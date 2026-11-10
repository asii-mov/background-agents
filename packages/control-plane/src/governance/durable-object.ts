import type { GovernanceCatalogStatus } from "./catalog-store";
import { DurableObject } from "cloudflare:workers";
import type { SqlDatabase } from "../db/sql-database";
import { createCloudflareEnv, type WorkerBindings } from "../cloudflare/platform";
import { reconcileGovernanceCatalogNow } from "./reconciler";
import { GovernanceSyncCoordinator } from "./sync-coordinator";

/** The singleton Durable Object lane that serializes Git catalogue publication. */
export class GovernanceCatalogDO extends DurableObject<WorkerBindings> {
  private readonly coordinator = new GovernanceSyncCoordinator<GovernanceCatalogStatus>();
  private readonly db: SqlDatabase;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    // eslint-disable-next-line no-restricted-syntax -- composition root input: the DO's one env.DB read
    this.db = env.DB;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/sync") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return this.reconcile();
  }

  private async reconcile(): Promise<Response> {
    try {
      return Response.json(
        await this.coordinator.run(() =>
          reconcileGovernanceCatalogNow(createCloudflareEnv(this.env), this.db)
        )
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Governance catalogue sync failed" },
        { status: 422 }
      );
    }
  }
}
