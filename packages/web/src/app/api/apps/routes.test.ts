import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET as listApps } from "@/app/api/apps/route";
import { GET as getApp } from "@/app/api/apps/[name]/route";
import { POST as takeDown } from "@/app/api/apps/[name]/takedown/route";
import { POST as releaseHold } from "@/app/api/apps/[name]/release-hold/route";
import { GET as getData } from "@/app/api/apps/[name]/data/route";
import { GET as listOperations } from "@/app/api/apps/[name]/data/operations/route";
import { POST as setSecrets } from "@/app/api/apps/[name]/data/secrets/route";
import { DELETE as deleteSecret } from "@/app/api/apps/[name]/data/secrets/[key]/route";
import { POST as approveMigration } from "@/app/api/apps/[name]/data/migrations/approve/route";
import { POST as restore } from "@/app/api/apps/[name]/data/restore/route";
import { PUT as classify } from "@/app/api/apps/[name]/data/classification/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const app = { params: Promise.resolve({ name: "expenses" }) };
const sessionCookie = { Cookie: "openinspect.session_token=placeholder" };

function mutation(path: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: sessionCookie,
    body: JSON.stringify(body),
  });
}

function forwarded() {
  return vi.mocked(controlPlaneUserFetch).mock.calls.map(([path, init]) => ({
    path,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
  }));
}

beforeEach(() => {
  vi.mocked(controlPlaneUserFetch).mockReset();
  vi.mocked(controlPlaneUserFetch).mockImplementation(async () => Response.json({ ok: true }));
});

describe("apps BFF routes", () => {
  it("reads the directory, an app and its data summary", async () => {
    await listApps(new NextRequest("http://localhost/api/apps"), { params: Promise.resolve({}) });
    await getApp(new NextRequest("http://localhost/api/apps/expenses"), app);
    await getData(new NextRequest("http://localhost/api/apps/expenses/data"), app);

    expect(forwarded()).toEqual([
      { path: "/apps", method: "GET", body: undefined },
      { path: "/apps/expenses", method: "GET", body: undefined },
      { path: "/apps/expenses/data", method: "GET", body: undefined },
    ]);
  });

  it("forwards only the ledger page parameters", async () => {
    await listOperations(
      new NextRequest(
        "http://localhost/api/apps/expenses/data/operations?cursor=17.op_1&limit=20&debug=1"
      ),
      app
    );

    expect(forwarded()[0]?.path).toBe("/apps/expenses/data/operations?cursor=17.op_1&limit=20");
  });

  it("relays takedown, release, approval, restore and classification bodies unchanged", async () => {
    const sha256 = "ab".repeat(32);
    await takeDown(mutation("/api/apps/expenses/takedown", "POST", { reason: "Leaks data" }), app);
    await releaseHold(mutation("/api/apps/expenses/release-hold", "POST", {}), app);
    await approveMigration(
      mutation("/api/apps/expenses/data/migrations/approve", "POST", {
        stage: "production",
        binding: "DB",
        name: "0002_drop-notes.sql",
        sha256,
      }),
      app
    );
    await restore(
      mutation("/api/apps/expenses/data/restore", "POST", {
        stage: "production",
        binding: "DB",
        target: { timestamp: 1_700_000_000_000 },
        confirmBinding: "DB",
      }),
      app
    );
    await classify(
      mutation("/api/apps/expenses/data/classification", "PUT", {
        classification: "restricted",
      }),
      app
    );

    expect(forwarded()).toEqual([
      { path: "/apps/expenses/takedown", method: "POST", body: { reason: "Leaks data" } },
      { path: "/apps/expenses/release-hold", method: "POST", body: {} },
      {
        path: "/apps/expenses/data/migrations/approve",
        method: "POST",
        body: { stage: "production", binding: "DB", name: "0002_drop-notes.sql", sha256 },
      },
      {
        path: "/apps/expenses/data/restore",
        method: "POST",
        body: {
          stage: "production",
          binding: "DB",
          target: { timestamp: 1_700_000_000_000 },
          confirmBinding: "DB",
        },
      },
      {
        path: "/apps/expenses/data/classification",
        method: "PUT",
        body: { classification: "restricted" },
      },
    ]);
  });

  it("sets secrets and answers with the control plane's names-only response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ keys: ["API_KEY"] }));

    const response = await setSecrets(
      mutation("/api/apps/expenses/data/secrets", "POST", {
        stage: "production",
        secrets: { API_KEY: "placeholder-value" },
      }),
      app
    );

    expect(forwarded()[0]).toMatchObject({ path: "/apps/expenses/data/secrets", method: "POST" });
    expect(await response.json()).toEqual({ keys: ["API_KEY"] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("deletes a secret by its encoded key and stage only", async () => {
    await deleteSecret(
      new NextRequest(
        "http://localhost/api/apps/expenses/data/secrets/API_KEY?stage=production&value=x",
        { method: "DELETE" }
      ),
      { params: Promise.resolve({ name: "expenses", key: "API_KEY" }) }
    );

    expect(forwarded()).toEqual([
      {
        path: "/apps/expenses/data/secrets/API_KEY?stage=production",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("refuses a mutation without a browser session", async () => {
    const response = await takeDown(
      new NextRequest("http://localhost/api/apps/expenses/takedown", {
        method: "POST",
        body: JSON.stringify({ reason: "Leaks data" }),
      }),
      app
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("relays refusals and unconfigured hosting with their status", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json(
        { ok: false, reason: "feature_unavailable", message: "App hosting is not set up" },
        { status: 503 }
      )
    );
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json(
        { error: "Only an administrator can release an administrator's hold" },
        { status: 403 }
      )
    );

    const list = await listApps(new NextRequest("http://localhost/api/apps"), {
      params: Promise.resolve({}),
    });
    const release = await releaseHold(mutation("/api/apps/expenses/release-hold", "POST", {}), app);

    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ reason: "feature_unavailable" });
    expect(release.status).toBe(403);
  });
});
