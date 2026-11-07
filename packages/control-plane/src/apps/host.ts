/**
 * The two ports the control plane uses to reach the apps account. The broker client
 * (broker-client.ts) is the one production adapter; tests use in-memory fakes. No Cloudflare or
 * broker wire type crosses this file: the broker classifies errors once and the client maps them
 * to {@link AppHostError}.
 */

import type { AppName, HostingBackendKind } from "@open-inspect/shared/apps";
import type {
  AppResourceName,
  BrokerErrorCode,
  BrokerTakedownResponse,
} from "@open-inspect/shared/app-broker";
import type { AppDataBinding, D1RestoreTarget } from "@open-inspect/shared/types/app-data";
import type { AppBundle } from "./bundle";

/**
 * Broker codes, plus what the client itself observed: Access or sig1 refused the control plane
 * (`unauthorized`), the body was over the broker's cap (`too_large`), the request never got an
 * answer (`network`), or the caller's deadline passed (`deadline`).
 */
export type AppHostErrorCode =
  BrokerErrorCode | "unauthorized" | "too_large" | "network" | "deadline";

const RETRYABLE: ReadonlySet<AppHostErrorCode> = new Set([
  "rate_limited",
  "upstream_unavailable",
  "network",
]);

export class AppHostError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: AppHostErrorCode,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AppHostError";
    this.retryable = RETRYABLE.has(code);
  }
}

export interface DeployReceipt {
  url: string;
  backend: HostingBackendKind;
  cfVersionId: string;
  accessAud: string;
  firstDeploy: boolean;
}

export interface AppHostDeployInput {
  name: AppName;
  /** `app_deployments.id`, carried to the script for drift correlation. */
  deploymentId: string;
  bundle: AppBundle;
  /** Resolved by app data. Secret values are revealed only inside the broker request body. */
  bindings: readonly AppDataBinding[];
}

export type TakedownResult = BrokerTakedownResponse;

export interface AppHost {
  /** Access, then publish (guard + module + bindings), then attach the hostname, then verify. Idempotent. */
  deploy(input: AppHostDeployInput, signal: AbortSignal): Promise<DeployReceipt>;
  /** Detach, remove the script, revoke the Access app. Absent counts as done. */
  takedown(name: AppName, signal: AbortSignal): Promise<TakedownResult>;
}

export interface DataHost {
  ensureD1(name: AppResourceName): Promise<{ databaseId: string; created: boolean }>;
  executeD1(databaseId: string, sql: string): Promise<void>;
  bookmarkD1(databaseId: string): Promise<string>;
  restoreD1(
    databaseId: string,
    target: D1RestoreTarget
  ): Promise<{ bookmark: string; previousBookmark: string }>;
  describeD1(databaseId: string): Promise<{ fileSize: number; numTables: number }>;
  deleteD1(databaseId: string): Promise<void>;
  ensureKv(name: AppResourceName): Promise<{ namespaceId: string; created: boolean }>;
  deleteKv(namespaceId: string): Promise<void>;
  ensureR2(name: AppResourceName): Promise<{ bucketName: AppResourceName; created: boolean }>;
  purgeR2(bucketName: AppResourceName): Promise<{ status: "emptying" | "deleted" }>;
}
