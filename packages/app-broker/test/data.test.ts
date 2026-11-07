import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_API_MAX_ATTEMPTS } from "../src/cloudflare-api";
import { FAKE_OPTIONS, createHarness, type Harness } from "./broker-harness";
import type { FakeStep } from "./fake-cloudflare";

async function ok(harness: Harness, op: Record<string, unknown>) {
  const response = await harness.data(op);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function failure(harness: Harness, op: Record<string, unknown>) {
  const response = await harness.data(op);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D1", () => {
  it("creates a database once and adopts it by exact name afterwards", async () => {
    const harness = createHarness({ env: { APP_DATA_JURISDICTION: "eu" } });
    harness.fake.seedD1("app-notes-db-archive");

    const created = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });
    const adopted = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });

    expect(created).toEqual({ databaseId: expect.any(String), created: true });
    expect(adopted).toEqual({ databaseId: created.databaseId, created: false });
    expect(harness.fake.d1("app-notes-db")).toMatchObject({
      uuid: created.databaseId,
      jurisdiction: "eu",
    });
    expect(harness.fake.d1("app-notes-db-archive")?.uuid).not.toBe(created.databaseId);
  });

  it("converges on one database when a create applies and then fails", async () => {
    const harness = createHarness();
    harness.fake.inject({ step: "d1.create", status: 500, applyThenFail: true });

    const first = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });
    const second = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });

    expect(second.databaseId).toBe(first.databaseId);
    expect(harness.fake.calls.filter((call) => call.step === "d1.create")).toHaveLength(1);
  });

  it("runs a migration file and relays D1's error without applying any of a failing file", async () => {
    const harness = createHarness();
    const { databaseId } = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });

    await ok(harness, { op: "d1.execute", databaseId, sql: "CREATE TABLE notes (id TEXT);" });
    const rejected = await failure(harness, {
      op: "d1.execute",
      databaseId,
      sql: "CREATE TABLE tags (id TEXT); INSERT INTO missing VALUES (1);",
    });

    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toBe("sql_error");
    expect(rejected.body.message).toContain("no such table: missing");
    expect(harness.fake.d1("app-notes-db")?.tables).toEqual(["notes"]);
  });

  it("records a bookmark and restores to it", async () => {
    const harness = createHarness();
    const { databaseId } = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });
    const { bookmark } = await ok(harness, { op: "d1.bookmark", databaseId });
    await ok(harness, { op: "d1.execute", databaseId, sql: "CREATE TABLE notes (id TEXT);" });

    const restored = await ok(harness, { op: "d1.restore", databaseId, target: { bookmark } });

    expect(restored).toEqual({ bookmark, previousBookmark: expect.any(String) });
    expect(restored.previousBookmark).not.toBe(bookmark);
    expect(harness.fake.d1("app-notes-db")?.tables).toEqual([]);
  });

  it("restores to a moment given in milliseconds", async () => {
    const harness = createHarness();
    const { databaseId } = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });
    await ok(harness, { op: "d1.execute", databaseId, sql: "CREATE TABLE notes (id TEXT);" });
    const beforeTags = Date.UTC(2026, 0, 1) + 1_000;
    harness.fake.advanceTime(5_000);
    await ok(harness, { op: "d1.execute", databaseId, sql: "CREATE TABLE tags (id TEXT);" });

    await ok(harness, { op: "d1.restore", databaseId, target: { timestamp: beforeTags } });

    expect(harness.fake.d1("app-notes-db")?.tables).toEqual(["notes"]);
  });

  it("describes a database and treats deleting an absent one as done", async () => {
    const harness = createHarness();
    const { databaseId } = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });
    await ok(harness, { op: "d1.execute", databaseId, sql: "CREATE TABLE notes (id TEXT);" });

    expect(await ok(harness, { op: "d1.describe", databaseId })).toEqual({
      name: "app-notes-db",
      fileSize: expect.any(Number),
      numTables: 1,
    });
    expect(await ok(harness, { op: "d1.delete", databaseId })).toEqual({ ok: true });
    expect(harness.fake.d1("app-notes-db")).toBeNull();
    expect(await ok(harness, { op: "d1.delete", databaseId })).toEqual({ ok: true });
  });
});

describe("the app- prefix", () => {
  it.each([
    { op: "d1.ensure", name: "billing-production" },
    { op: "kv.ensure", name: "sessions" },
    { op: "r2.ensure", name: "company-backups" },
    { op: "r2.purge", bucketName: "company-backups" },
  ])("refuses $op on a name outside it, before any Cloudflare call", async (op) => {
    const harness = createHarness();

    const { status, body } = await failure(harness, op);

    expect(status).toBe(403);
    expect(body.error).toBe("refused");
    expect(harness.fake.calls).toEqual([]);
  });

  it.each(["d1.execute", "d1.bookmark", "d1.restore", "d1.describe", "d1.delete"])(
    "refuses %s on a database id whose name is outside it",
    async (op) => {
      const harness = createHarness();
      const databaseId = harness.fake.seedD1("billing-production");

      const { status, body } = await failure(harness, {
        op,
        databaseId,
        ...(op === "d1.execute" ? { sql: "DROP TABLE invoices;" } : {}),
        ...(op === "d1.restore" ? { target: { timestamp: Date.UTC(2026, 0, 1) } } : {}),
      });

      expect(status).toBe(403);
      expect(body.error).toBe("refused");
      expect(harness.fake.d1(databaseId)).toMatchObject({ name: "billing-production", log: [] });
      const touched: FakeStep[] = ["d1.query", "d1.restore", "d1.delete", "d1.bookmark"];
      expect(harness.fake.calls.filter((call) => touched.includes(call.step))).toEqual([]);
    }
  );

  it("refuses to delete a KV namespace whose title is outside it", async () => {
    const harness = createHarness();
    const namespaceId = harness.fake.seedKv("sessions");

    const { status, body } = await failure(harness, { op: "kv.delete", namespaceId });

    expect(status).toBe(403);
    expect(body.error).toBe("refused");
    expect(harness.fake.kvNamespaces()).toEqual([{ id: namespaceId, title: "sessions" }]);
  });
});

describe("KV", () => {
  it("adopts a namespace by exact title across list pages", async () => {
    const harness = createHarness();
    for (let index = 0; index < 120; index += 1) harness.fake.seedKv(`app-filler-${index}`);
    const existing = harness.fake.seedKv("app-notes-cache");

    expect(await ok(harness, { op: "kv.ensure", name: "app-notes-cache" })).toEqual({
      namespaceId: existing,
      created: false,
    });
    const created = await ok(harness, { op: "kv.ensure", name: "app-notes" });

    expect(created.created).toBe(true);
    expect(harness.fake.kvNamespaces().filter((ns) => ns.title === "app-notes")).toHaveLength(1);
  });

  it("deletes an app namespace and treats an absent one as done", async () => {
    const harness = createHarness();
    const { namespaceId } = await ok(harness, { op: "kv.ensure", name: "app-notes-cache" });

    expect(await ok(harness, { op: "kv.delete", namespaceId })).toEqual({ ok: true });
    expect(await ok(harness, { op: "kv.delete", namespaceId })).toEqual({ ok: true });
    expect(harness.fake.kvNamespaces()).toEqual([]);
  });
});

describe("R2", () => {
  it("creates a private bucket in the configured jurisdiction and adopts it afterwards", async () => {
    const harness = createHarness({ env: { APP_DATA_JURISDICTION: "eu" } });

    const created = await ok(harness, { op: "r2.ensure", name: "app-notes-files" });
    const adopted = await ok(harness, { op: "r2.ensure", name: "app-notes-files" });

    expect(created).toEqual({ bucketName: "app-notes-files", created: true });
    expect(adopted).toEqual({ bucketName: "app-notes-files", created: false });
    expect(harness.fake.r2Bucket("app-notes-files", "eu")).not.toBeNull();
    expect(harness.fake.r2Bucket("app-notes-files")).toBeNull();
  });

  it("sets an expire-all lifecycle, reports emptying, then deleted once Cloudflare empties it", async () => {
    const harness = createHarness();
    harness.fake.seedR2("app-notes-files", { objects: 3 });

    expect(await ok(harness, { op: "r2.purge", bucketName: "app-notes-files" })).toEqual({
      status: "emptying",
    });
    expect(harness.fake.r2Bucket("app-notes-files")?.lifecycleRules).toHaveLength(1);

    harness.fake.runR2Lifecycle();
    expect(await ok(harness, { op: "r2.purge", bucketName: "app-notes-files" })).toEqual({
      status: "deleted",
    });
    expect(harness.fake.r2Bucket("app-notes-files")).toBeNull();
    expect(await ok(harness, { op: "r2.purge", bucketName: "app-notes-files" })).toEqual({
      status: "deleted",
    });
  });
});

describe("rate limits and failures", () => {
  it("waits out a short Retry-After and completes", async () => {
    const harness = createHarness();
    harness.fake.inject({ step: "d1.list", status: 429, retryAfterSeconds: 2 });

    await ok(harness, { op: "d1.ensure", name: "app-notes-db" });

    expect(harness.sleeps).toEqual([2_000]);
  });

  it("returns rate_limited with Cloudflare's Retry-After when the wait is too long to hold", async () => {
    const harness = createHarness();
    harness.fake.inject({
      step: "d1.list",
      status: 429,
      retryAfterSeconds: 120,
      times: CLOUDFLARE_API_MAX_ATTEMPTS,
    });

    const response = await harness.data({ op: "d1.ensure", name: "app-notes-db" });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message: expect.any(String),
      retryAfterSeconds: 120,
    });
    expect(harness.sleeps).toEqual([]);
  });

  it("never logs the apps token, SQL text or secret values", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const harness = createHarness();
    const { databaseId } = await ok(harness, { op: "d1.ensure", name: "app-notes-db" });
    await harness.data({
      op: "d1.execute",
      databaseId,
      sql: "INSERT INTO secret_table VALUES (1);",
    });
    harness.fake.inject({ step: "d1.get", status: 500, times: CLOUDFLARE_API_MAX_ATTEMPTS });
    await harness.data({ op: "d1.describe", databaseId });
    await harness.data({ op: "d1.ensure", name: "billing-production" });
    harness.fake.inject({ step: "versions.create", status: 400 });
    await harness.deploy({
      name: "notes",
      bindings: [{ type: "secret_text", name: "PAYMENTS_KEY", value: "placeholder-secret-value" }],
    });

    const logged = lines.join("\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(logged).not.toContain(FAKE_OPTIONS.apiToken);
    expect(logged).not.toContain("secret_table");
    expect(logged).not.toContain("placeholder-secret-value");
  });
});
