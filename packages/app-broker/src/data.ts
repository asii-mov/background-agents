/**
 * The data ops: D1, KV and R2 resources that belong to apps. Every op either names a resource by
 * an `app-` name (checked by the request schema) or by an id, which is resolved first and refused
 * unless the name Cloudflare reports starts with `app-`. No op here can make data public: there is
 * no code for bucket domains, public access or policies.
 */

import type {
  BrokerBinding,
  BrokerDataOp,
  BrokerDataRequest,
  BrokerDataResponse,
} from "@open-inspect/shared/app-broker";
import { z } from "zod";
import { findOrCreate, hasStatus, type CloudflareApi } from "./cloudflare-api";
import type { BrokerConfig } from "./env";
import { BrokerRefusal } from "./errors";
import { assertAppResourceName } from "./names";

export interface DataDeps {
  readonly api: CloudflareApi;
  readonly config: BrokerConfig;
}

/** Cloudflare takes lifecycle ages in seconds. Objects this old are expired by the purge rule. */
const PURGE_OBJECT_MAX_AGE_SECONDS = 86_400;

const d1Schema = z.object({
  uuid: z.string().min(1),
  name: z.string(),
  file_size: z.number().int().nonnegative().catch(0),
  num_tables: z.number().int().nonnegative().catch(0),
});
type D1Database = z.output<typeof d1Schema>;
const kvSchema = z.object({ id: z.string().min(1), title: z.string() });
const bookmarkSchema = z.object({ bookmark: z.string().min(1) });

type Handler<Op extends BrokerDataOp> = (
  deps: DataDeps,
  request: Extract<BrokerDataRequest, { op: Op }>,
  signal: AbortSignal
) => Promise<BrokerDataResponse<Op>>;

const segment = encodeURIComponent;

/** The resource behind `databaseId`, refused unless it is an app database. */
async function ownedD1(deps: DataDeps, databaseId: string, signal: AbortSignal) {
  let database: D1Database;
  try {
    database = await deps.api.call("GET", `/d1/database/${segment(databaseId)}`, d1Schema, {
      signal,
    });
  } catch (error) {
    if (hasStatus(error, 404)) throw new BrokerRefusal("not_found", "No such database.");
    throw error;
  }
  assertAppResourceName(database.name);
  return database;
}

async function ownedKv(deps: DataDeps, namespaceId: string, signal: AbortSignal) {
  let namespace: z.output<typeof kvSchema>;
  try {
    namespace = await deps.api.call(
      "GET",
      `/storage/kv/namespaces/${segment(namespaceId)}`,
      kvSchema,
      { signal }
    );
  } catch (error) {
    if (hasStatus(error, 404)) throw new BrokerRefusal("not_found", "No such KV namespace.");
    throw error;
  }
  assertAppResourceName(namespace.title);
  return namespace;
}

/** Deleting what is already gone succeeds, so a purge sweep can repeat. */
async function absentIsDone(run: () => Promise<unknown>): Promise<{ ok: true }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof BrokerRefusal && error.code === "not_found") && !hasStatus(error, 404)) {
      throw error;
    }
  }
  return { ok: true };
}

const r2Options = (deps: DataDeps, signal: AbortSignal) => {
  const headers: Record<string, string> = {};
  if (deps.config.jurisdiction) headers["cf-r2-jurisdiction"] = deps.config.jurisdiction;
  return { signal, headers };
};

const HANDLERS: { [Op in BrokerDataOp]: Handler<Op> } = {
  async "d1.ensure"(deps, { name }, signal) {
    const { value, created } = await findOrCreate(
      async () => {
        const matches = await deps.api.list("/d1/database", d1Schema, {
          signal,
          query: { name },
        });
        return matches.find((database) => database.name === name) ?? null;
      },
      () =>
        deps.api.call("POST", "/d1/database", d1Schema, {
          signal,
          body: {
            name,
            ...(deps.config.jurisdiction ? { jurisdiction: deps.config.jurisdiction } : {}),
          },
        })
    );
    return { databaseId: value.uuid, created };
  },

  async "d1.execute"(deps, { databaseId, sql }, signal) {
    await ownedD1(deps, databaseId, signal);
    try {
      await deps.api.call("POST", `/d1/database/${segment(databaseId)}/query`, z.unknown(), {
        signal,
        body: { sql },
      });
    } catch (error) {
      if (hasStatus(error, 400, 422)) {
        throw new BrokerRefusal("sql_error", error.messages.join("; ") || "D1 rejected the SQL.");
      }
      throw error;
    }
    return { ok: true };
  },

  async "d1.bookmark"(deps, { databaseId }, signal) {
    await ownedD1(deps, databaseId, signal);
    return deps.api.call(
      "GET",
      `/d1/database/${segment(databaseId)}/time_travel/bookmark`,
      bookmarkSchema,
      { signal }
    );
  },

  async "d1.restore"(deps, { databaseId, target }, signal) {
    await ownedD1(deps, databaseId, signal);
    const query: Record<string, string> =
      "bookmark" in target
        ? { bookmark: target.bookmark }
        : { timestamp: new Date(target.timestamp).toISOString() };
    const restored = await deps.api.call(
      "POST",
      `/d1/database/${segment(databaseId)}/time_travel/restore`,
      bookmarkSchema.extend({ previous_bookmark: z.string().min(1) }),
      { signal, query, idempotent: true }
    );
    return { bookmark: restored.bookmark, previousBookmark: restored.previous_bookmark };
  },

  async "d1.describe"(deps, { databaseId }, signal) {
    const database = await ownedD1(deps, databaseId, signal);
    return {
      name: assertAppResourceName(database.name),
      fileSize: database.file_size,
      numTables: database.num_tables,
    };
  },

  async "d1.delete"(deps, { databaseId }, signal) {
    return absentIsDone(async () => {
      await ownedD1(deps, databaseId, signal);
      await deps.api.call("DELETE", `/d1/database/${segment(databaseId)}`, z.unknown(), {
        signal,
      });
    });
  },

  async "kv.ensure"(deps, { name }, signal) {
    const { value, created } = await findOrCreate(
      async () => {
        const namespaces = await deps.api.list("/storage/kv/namespaces", kvSchema, { signal });
        return namespaces.find((namespace) => namespace.title === name) ?? null;
      },
      () =>
        deps.api.call("POST", "/storage/kv/namespaces", kvSchema, { signal, body: { title: name } })
    );
    return { namespaceId: value.id, created };
  },

  async "kv.delete"(deps, { namespaceId }, signal) {
    return absentIsDone(async () => {
      await ownedKv(deps, namespaceId, signal);
      await deps.api.call("DELETE", `/storage/kv/namespaces/${segment(namespaceId)}`, z.unknown(), {
        signal,
      });
    });
  },

  async "r2.ensure"(deps, { name }, signal) {
    const { created } = await findOrCreate(
      async () => {
        try {
          return await deps.api.call("GET", `/r2/buckets/${segment(name)}`, z.unknown(), {
            ...r2Options(deps, signal),
          });
        } catch (error) {
          if (hasStatus(error, 404)) return null;
          throw error;
        }
      },
      () =>
        deps.api.call("POST", "/r2/buckets", z.unknown(), {
          ...r2Options(deps, signal),
          body: { name },
        })
    );
    return { bucketName: name, created };
  },

  async "r2.purge"(deps, { bucketName }, signal) {
    const bucketPath = `/r2/buckets/${segment(bucketName)}`;
    try {
      await deps.api.call("PUT", `${bucketPath}/lifecycle`, z.unknown(), {
        ...r2Options(deps, signal),
        body: {
          rules: [
            {
              id: "open-inspect-purge",
              enabled: true,
              conditions: { prefix: "" },
              deleteObjectsTransition: {
                condition: { type: "Age", maxAge: PURGE_OBJECT_MAX_AGE_SECONDS },
              },
              abortMultipartUploadsTransition: {
                condition: { type: "Age", maxAge: PURGE_OBJECT_MAX_AGE_SECONDS },
              },
            },
          ],
        },
      });
      await deps.api.call("DELETE", bucketPath, z.unknown(), r2Options(deps, signal));
    } catch (error) {
      if (hasStatus(error, 404)) return { status: "deleted" };
      if (hasStatus(error, 409)) return { status: "emptying" };
      throw error;
    }
    return { status: "deleted" };
  },
};

export function handleDataOp<Op extends BrokerDataOp>(
  deps: DataDeps,
  request: Extract<BrokerDataRequest, { op: Op }>,
  signal: AbortSignal
): Promise<BrokerDataResponse<Op>> {
  return (HANDLERS[request.op] as Handler<Op>)(deps, request, signal);
}

/**
 * A deploy may bind only app resources. Ids are resolved like the data ops resolve them; bucket
 * names are already `app-` names by the request schema.
 */
export async function assertBindingsOwned(
  deps: DataDeps,
  bindings: readonly BrokerBinding[],
  signal: AbortSignal
): Promise<void> {
  for (const binding of bindings) {
    if (binding.type === "d1") await ownedD1(deps, binding.databaseId, signal);
    if (binding.type === "kv_namespace") await ownedKv(deps, binding.namespaceId, signal);
  }
}
