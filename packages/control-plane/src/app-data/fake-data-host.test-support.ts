import { DatabaseSync } from "node:sqlite";
import type { AppResourceName } from "@open-inspect/shared/app-broker";
import type { D1RestoreTarget } from "@open-inspect/shared/types/app-data";
import { AppHostError, type DataHost } from "../apps/host";

export type DataHostOp = keyof DataHost;

interface FakeDatabase {
  id: string;
  name: AppResourceName;
  sqlite: DatabaseSync;
  /** Bumped by every write, so bookmarks name a state. */
  version: number;
}

interface FakeBucket {
  objects: number;
  lifecycle: boolean;
}

/**
 * An in-memory apps account behind the DataHost port. Each D1 database is a real SQLite database,
 * and a body runs as one transaction, as D1 runs a /query batch. Faults are consumed in order by
 * the first call of their op: `before` fails without effect, `after` applies and then fails, as
 * when a response is lost.
 */
export interface FakeDataHost extends DataHost {
  readonly calls: Array<{ op: DataHostOp; target: string }>;
  readonly restores: Array<{ databaseId: string; target: D1RestoreTarget }>;
  inject(op: DataHostOp, when: "before" | "after", error?: AppHostError): void;
  database(nameOrId: string): { id: string; tables: string[]; rows(sql: string): unknown[] } | null;
  databaseCount(): number;
  kvNamespaces(): string[];
  bucket(name: string): FakeBucket | null;
  putObjects(bucket: string, count: number): void;
  /** Cloudflare applying every bucket's expire-all lifecycle rule. */
  runLifecycle(): void;
}

export function createFakeDataHost(): FakeDataHost {
  const databases = new Map<string, FakeDatabase>();
  const namespaces = new Map<string, string>();
  const buckets = new Map<string, FakeBucket>();
  const faults: Array<{ op: DataHostOp; when: "before" | "after"; error: AppHostError }> = [];
  let ids = 0;

  const find = (nameOrId: string) =>
    databases.get(nameOrId) ?? [...databases.values()].find((db) => db.name === nameOrId) ?? null;
  const requireDatabase = (id: string) => {
    const db = databases.get(id);
    if (!db) throw new AppHostError("not_found", "No such database.");
    return db;
  };
  const tables = (db: FakeDatabase) =>
    (
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

  async function call<T>(op: DataHostOp, target: string, run: () => T): Promise<T> {
    host.calls.push({ op, target });
    const index = faults.findIndex((fault) => fault.op === op);
    const fault = index === -1 ? null : faults.splice(index, 1)[0]!;
    if (fault?.when === "before") throw fault.error;
    const result = run();
    if (fault) throw fault.error;
    return result;
  }

  const host: FakeDataHost = {
    calls: [],
    restores: [],
    inject(op, when, error = new AppHostError("upstream_unavailable", `${op} failed`)) {
      faults.push({ op, when, error });
    },
    database(nameOrId) {
      const db = find(nameOrId);
      return db
        ? {
            id: db.id,
            tables: tables(db),
            rows: (sql) => db.sqlite.prepare(sql).all() as unknown[],
          }
        : null;
    },
    databaseCount: () => databases.size,
    kvNamespaces: () => [...namespaces.values()].sort(),
    bucket: (name) => (buckets.has(name) ? { ...buckets.get(name)! } : null),
    putObjects(bucket, count) {
      buckets.get(bucket)!.objects += count;
    },
    runLifecycle() {
      for (const bucket of buckets.values()) if (bucket.lifecycle) bucket.objects = 0;
    },

    ensureD1: (name) =>
      call("ensureD1", name, () => {
        const existing = find(name);
        if (existing) return { databaseId: existing.id, created: false };
        const id = `d1-${++ids}`;
        databases.set(id, { id, name, sqlite: new DatabaseSync(":memory:"), version: 0 });
        return { databaseId: id, created: true };
      }),
    executeD1: (databaseId, sql) =>
      call("executeD1", databaseId, () => {
        const db = requireDatabase(databaseId);
        db.sqlite.exec("BEGIN");
        try {
          db.sqlite.exec(sql);
          db.sqlite.exec("COMMIT");
          db.version += 1;
        } catch (error) {
          db.sqlite.exec("ROLLBACK");
          throw new AppHostError("sql_error", (error as Error).message);
        }
      }),
    bookmarkD1: (databaseId) =>
      call("bookmarkD1", databaseId, () => {
        const db = requireDatabase(databaseId);
        return `${db.id}@${db.version}`;
      }),
    restoreD1: (databaseId, target) =>
      call("restoreD1", databaseId, () => {
        const db = requireDatabase(databaseId);
        host.restores.push({ databaseId, target });
        const previousBookmark = `${db.id}@${db.version}`;
        db.version += 1;
        return { bookmark: `${db.id}@${db.version}`, previousBookmark };
      }),
    describeD1: (databaseId) =>
      call("describeD1", databaseId, () => {
        const db = requireDatabase(databaseId);
        const count = tables(db).length;
        return { fileSize: 4096 * (1 + count), numTables: count };
      }),
    deleteD1: (databaseId) =>
      call("deleteD1", databaseId, () => {
        databases.get(databaseId)?.sqlite.close();
        databases.delete(databaseId);
      }),
    ensureKv: (name) =>
      call("ensureKv", name, () => {
        const existing = [...namespaces].find(([, title]) => title === name);
        if (existing) return { namespaceId: existing[0], created: false };
        const id = `kv-${++ids}`;
        namespaces.set(id, name);
        return { namespaceId: id, created: true };
      }),
    deleteKv: (namespaceId) =>
      call("deleteKv", namespaceId, () => {
        namespaces.delete(namespaceId);
      }),
    ensureR2: (name) =>
      call("ensureR2", name, () => {
        const created = !buckets.has(name);
        if (created) buckets.set(name, { objects: 0, lifecycle: false });
        return { bucketName: name, created };
      }),
    purgeR2: (bucketName) =>
      call("purgeR2", bucketName, () => {
        const bucket = buckets.get(bucketName);
        if (!bucket) return { status: "deleted" as const };
        bucket.lifecycle = true;
        if (bucket.objects > 0) return { status: "emptying" as const };
        buckets.delete(bucketName);
        return { status: "deleted" as const };
      }),
  };
  return host;
}
