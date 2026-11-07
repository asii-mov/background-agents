/**
 * The public surface of app data. The apps composition root builds the service here, so app data
 * shares the broker client that hosting already authenticates.
 */

import { DATA_JURISDICTIONS } from "@open-inspect/shared/types/app-data";
import type { DataHost } from "../apps/host";
import { ApprovedComponentStore } from "../db/approved-components";
import { AppDataStore } from "../db/app-data";
import type { SqlDatabase } from "../db/sql-database";
import type { EnvConfig } from "../types";
import { parseAppDataConfig } from "./model";
import { AppDataService } from "./service";

export { AppDataService } from "./service";
export type {
  ActionResult,
  AppDataRefusalCode,
  PrepareInput,
  PrepareResult,
  UserActor,
} from "./service";

/** Fails closed: a jurisdiction Cloudflare does not offer, or no secrets key, disables app data. */
export function createAppDataService(input: {
  db: SqlDatabase;
  host: DataHost;
  env: Pick<EnvConfig, "APP_DATA_JURISDICTION" | "REPO_SECRETS_ENCRYPTION_KEY">;
  now?: () => number;
}): { ok: true; service: AppDataService } | { ok: false; problems: string[] } {
  const config = parseAppDataConfig(input.env);
  const problems = [
    ...(config
      ? []
      : [`APP_DATA_JURISDICTION must be empty or one of ${DATA_JURISDICTIONS.join(", ")}`]),
    ...(input.env.REPO_SECRETS_ENCRYPTION_KEY ? [] : ["REPO_SECRETS_ENCRYPTION_KEY is not set"]),
  ];
  if (!config || !input.env.REPO_SECRETS_ENCRYPTION_KEY) return { ok: false, problems };
  return {
    ok: true,
    service: new AppDataService({
      db: input.db,
      store: new AppDataStore(input.db, input.env.REPO_SECRETS_ENCRYPTION_KEY),
      host: input.host,
      policy: new ApprovedComponentStore(input.db),
      config,
      now: input.now ?? Date.now,
    }),
  };
}
