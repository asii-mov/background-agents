import { createHash } from "node:crypto";
import { APP_BUNDLE_LIMITS } from "@open-inspect/shared/apps";
import { describe, expect, it } from "vitest";
import { parseAssetPath, readDeployRequest } from "./bundle";

interface Parts {
  manifest?: unknown;
  app?: unknown;
  files?: Record<string, string | Uint8Array>;
}

/** A body shaped like the sandbox tool's: the manifest part has no filename, file parts do. */
function deployRequest({ manifest, app, files = {} }: Parts, headers: HeadersInit = {}): Request {
  const form = new FormData();
  if (manifest !== undefined) form.append("manifest", JSON.stringify(manifest));
  if (app !== undefined) {
    form.append("app", new File([JSON.stringify(app)], "app", { type: "application/json" }));
  }
  for (const [part, content] of Object.entries(files)) {
    form.append(part, new File([content], part, { type: "application/octet-stream" }));
  }
  return new Request("https://control-plane.test/sessions/s/apps", {
    method: "POST",
    body: form,
    headers,
  });
}

const site = (assets: Record<string, string>) => ({
  manifest: {
    name: "notes",
    assets: Object.keys(assets).map((path, index) => ({ path, part: `a${index}` })),
    worker: null,
    app: null,
    migrations: [],
  },
  files: Object.fromEntries(Object.values(assets).map((content, index) => [`a${index}`, content])),
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("parseAssetPath", () => {
  it.each(["/index.html", "/assets/app-3f2a.js", "/.well-known/security.txt", "/a b/c(1).png"])(
    "accepts %s",
    (path) => expect(parseAssetPath(path)).toBe(path)
  );

  it.each([
    "index.html",
    "dist/index.html",
    "/",
    "/a//b",
    "/a/",
    "/../x",
    "/a/../b",
    "/a/./b",
    "/a\\b",
    "/%2e%2e/x",
    "/a?b",
    "/a#b",
    "/a\u0000b",
    `/${"a".repeat(APP_BUNDLE_LIMITS.maxAssetPathLength)}`,
  ])("refuses %j rather than repairing it", (path) => expect(parseAssetPath(path)).toBeNull());
});

describe("readDeployRequest", () => {
  it("parses a static site and derives single-page not-found handling", async () => {
    const result = await readDeployRequest(
      deployRequest(site({ "/index.html": "<h1>hi</h1>", "/app.js": "go()" }))
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        name: "notes",
        bundle: { worker: null, notFoundHandling: "single-page-application", bytes: 15 },
        data: { manifest: null },
      },
    });
    if (!result.ok) return;
    expect(result.value.bundle.assets.map((asset) => asset.path)).toEqual([
      "/app.js",
      "/index.html",
    ]);
    expect(result.value.bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [{ "/404.html": "missing", "/index.html": "home" }, "404-page"],
    [{ "/about.html": "about" }, "none"],
  ])("derives not-found handling from %j", async (assets, expected) => {
    const result = await readDeployRequest(deployRequest(site(assets)));
    expect(result.ok && result.value.bundle.notFoundHandling).toBe(expected);
  });

  it("accepts a Worker-only app and keeps the module bytes", async () => {
    const result = await readDeployRequest(
      deployRequest({
        manifest: {
          name: "inventory-api",
          assets: [],
          worker: { part: "worker" },
          app: null,
          migrations: [],
        },
        files: { worker: "export default {}" },
      })
    );

    expect(result.ok && new TextDecoder().decode(result.value.bundle.worker!)).toBe(
      "export default {}"
    );
  });

  it("computes the bundle hash from content, so equal builds hash equally", async () => {
    const a = await readDeployRequest(deployRequest(site({ "/index.html": "same" })));
    const b = await readDeployRequest(deployRequest(site({ "/index.html": "same" })));
    const c = await readDeployRequest(deployRequest(site({ "/index.html": "changed" })));

    expect(a.ok && b.ok && a.value.bundle.sha256 === b.value.bundle.sha256).toBe(true);
    expect(a.ok && c.ok && a.value.bundle.sha256 === c.value.bundle.sha256).toBe(false);
  });

  it("refuses a declared length over the cap before reading the body", async () => {
    const unreadable = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new Error("the body was read");
      },
    });
    const request = new Request("https://control-plane.test/sessions/s/apps", {
      method: "POST",
      body: unreadable,
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(APP_BUNDLE_LIMITS.maxRequestBytes + 1),
      },
      duplex: "half",
    } as RequestInit);

    expect(await readDeployRequest(request)).toMatchObject({
      ok: false,
      reason: "bundle_too_large",
    });
  });

  it("refuses a Worker over its size limit", async () => {
    const result = await readDeployRequest(
      deployRequest({
        manifest: {
          name: "inventory-api",
          assets: [],
          worker: { part: "worker" },
          app: null,
          migrations: [],
        },
        files: { worker: new Uint8Array(APP_BUNDLE_LIMITS.maxWorkerBytes + 1) },
      })
    );
    expect(result).toMatchObject({ ok: false, reason: "bundle_too_large" });
  });

  it.each([
    ["a non-multipart body", new Request("https://cp.test/x", { method: "POST", body: "{}" })],
    ["a missing manifest", deployRequest({ files: { a0: "x" } })],
    [
      "an unnamed part",
      deployRequest({ ...site({ "/index.html": "x" }), files: { a0: "x", a9: "y" } }),
    ],
    ["a missing part", deployRequest({ manifest: site({ "/index.html": "x" }).manifest })],
    [
      "a duplicated path",
      deployRequest({
        manifest: {
          name: "notes",
          assets: [
            { path: "/index.html", part: "a0" },
            { path: "/index.html", part: "a1" },
          ],
          worker: null,
          app: null,
          migrations: [],
        },
        files: { a0: "x", a1: "y" },
      }),
    ],
    [
      "one part named twice",
      deployRequest({
        manifest: {
          name: "notes",
          assets: [
            { path: "/a.html", part: "a0" },
            { path: "/b.html", part: "a0" },
          ],
          worker: null,
          app: null,
          migrations: [],
        },
        files: { a0: "x" },
      }),
    ],
    ["a traversal path", deployRequest(site({ "/../secrets.txt": "x" }))],
    ["a host configuration file", deployRequest(site({ "/_headers": "/* x: y" }))],
    ["nothing to publish", deployRequest(site({}))],
    [
      "a migration name outside the pattern",
      deployRequest({
        manifest: {
          name: "notes",
          assets: [],
          worker: { part: "worker" },
          app: { part: "app" },
          migrations: [{ binding: "DB", name: "init.sql", part: "m0" }],
        },
        app: { schemaVersion: 1, name: "notes", data: { DB: { kind: "d1" } } },
        files: { worker: "export default {}", m0: "CREATE TABLE t (id TEXT);" },
      }),
    ],
  ])("refuses %s as an invalid bundle", async (_case, request) => {
    expect(await readDeployRequest(request)).toMatchObject({ ok: false, reason: "invalid_bundle" });
  });

  it.each([
    ["Notes", "invalid_name"],
    ["xn--notes", "invalid_name"],
    ["ab--cd", "invalid_name"],
    ["deployer", "reserved_name"],
  ])("refuses the app name %s with %s", async (name, reason) => {
    const request = site({ "/index.html": "x" });
    const result = await readDeployRequest(
      deployRequest({ ...request, manifest: { ...request.manifest, name } })
    );
    expect(result).toMatchObject({ ok: false, reason });
  });

  describe("with openinspect.app.json", () => {
    const dataApp = (app: unknown, migrations: Array<[string, string, string]> = []) =>
      deployRequest({
        manifest: {
          assets: [{ path: "/index.html", part: "a0" }],
          worker: null,
          app: { part: "app" },
          migrations: migrations.map(([binding, name], index) => ({
            binding,
            name,
            part: `m${index}`,
          })),
        },
        app,
        files: {
          a0: "<h1>notes</h1>",
          ...Object.fromEntries(migrations.map(([, , sql], index) => [`m${index}`, sql])),
        },
      });

    it("takes the name from the manifest and groups migrations by binding in name order", async () => {
      const result = await readDeployRequest(
        dataApp(
          {
            schemaVersion: 1,
            name: "notes",
            data: { DB: { kind: "d1" }, AUDIT: { kind: "d1", migrations: "db/audit" } },
            secrets: ["STRIPE_KEY"],
          },
          [
            ["DB", "0002_add-tags.sql", "ALTER TABLE notes ADD tags TEXT;"],
            ["DB", "0001_create-notes.sql", "CREATE TABLE notes (id TEXT);"],
            ["AUDIT", "0001_create-log.sql", "CREATE TABLE log (id TEXT);"],
          ]
        )
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("notes");
      expect(result.value.data.manifest).toMatchObject({
        classification: "internal",
        secrets: ["STRIPE_KEY"],
        data: { DB: { kind: "d1", migrations: "migrations" } },
      });
      expect(Object.fromEntries(result.value.data.migrations)).toEqual({
        DB: [
          {
            name: "0001_create-notes.sql",
            sql: "CREATE TABLE notes (id TEXT);",
            sha256: sha256("CREATE TABLE notes (id TEXT);"),
          },
          {
            name: "0002_add-tags.sql",
            sql: "ALTER TABLE notes ADD tags TEXT;",
            sha256: sha256("ALTER TABLE notes ADD tags TEXT;"),
          },
        ],
        AUDIT: [
          {
            name: "0001_create-log.sql",
            sql: "CREATE TABLE log (id TEXT);",
            sha256: sha256("CREATE TABLE log (id TEXT);"),
          },
        ],
      });
    });

    it.each([
      [
        "a manifest the shared schema rejects",
        { schemaVersion: 1, name: "notes", secrets: ["CF_TOKEN"] },
      ],
      [
        "an external database",
        { schemaVersion: 1, name: "notes", data: { DB: { kind: "external", url: "x" } } },
      ],
    ])("refuses %s as data_manifest_invalid", async (_case, app) => {
      expect(await readDeployRequest(dataApp(app))).toMatchObject({
        ok: false,
        reason: "data_manifest_invalid",
      });
    });

    it("refuses migrations for a binding that is not a declared d1 database", async () => {
      const result = await readDeployRequest(
        dataApp({ schemaVersion: 1, name: "notes", data: { CACHE: { kind: "kv" } } }, [
          ["CACHE", "0001_init.sql", "CREATE TABLE t (id TEXT);"],
        ])
      );
      expect(result).toMatchObject({ ok: false, reason: "data_manifest_invalid" });
    });

    it("refuses a name that disagrees with the manifest", async () => {
      const request = deployRequest({
        manifest: {
          name: "other",
          assets: [{ path: "/index.html", part: "a0" }],
          worker: null,
          app: { part: "app" },
          migrations: [],
        },
        app: { schemaVersion: 1, name: "notes" },
        files: { a0: "x" },
      });
      expect(await readDeployRequest(request)).toMatchObject({
        ok: false,
        reason: "invalid_bundle",
      });
    });
  });
});
