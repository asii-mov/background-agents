/**
 * packages/control-plane/src/apps/host.ts  (NEW)
 *
 * The two PORTS the control plane uses to reach the apps account, and their single production adapter:
 * the sig1-signed broker client. No Cloudflare wire types cross this file; the broker classifies
 * errors once. Tests use in-memory fakes (apps/fake-app-host.test-support.ts, app-data/fake-data-host).
 */
import type { AppName, HostingBackendKind } from "@open-inspect/shared/apps";
import type {
  AppResourceName,
  BrokerBinding,
  BrokerErrorCode,
} from "@open-inspect/shared/app-broker";
import type { FetchClient, OutboundServiceCredential } from "@open-inspect/shared/service-auth";
import type { AppBundle } from "./bundle";

/** Classified by the broker. `refused` is a security event: logged at error, never retried. */
export class AppHostError extends Error {
  constructor(
    readonly code: BrokerErrorCode | "network" | "deadline",
    readonly retryable: boolean,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AppHostError";
  }
}

export interface DeployReceipt {
  url: string;
  backend: HostingBackendKind;
  cfVersionId: string;
  accessAud: string;
  firstDeploy: boolean;
}

export interface AppHost {
  /** One call = ensureAccess -> publish (guard + user module + bindings) -> attach hostname -> verify. Idempotent. */
  deploy(
    input: {
      name: AppName;
      deploymentId: string;
      bundle: AppBundle;
      bindings: readonly BrokerBinding[];
    },
    signal: AbortSignal
  ): Promise<DeployReceipt>;
  /** detach -> remove script -> revoke Access app. Absent = done. */
  takedown(
    name: AppName,
    signal: AbortSignal
  ): Promise<{
    cleanupComplete: boolean;
    failedStep?: "detach" | "remove_script" | "revoke_access";
  }>;
}

export type D1RestoreTarget = { bookmark: string } | { timestamp: number };

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

// ---- Broker client (apps/broker-client.ts) --------------------------------------------------------

export const BROKER_DEPLOY_TIMEOUT_MS = 110_000; // inside APP_DEPLOY_DEADLINE_MS (120_000) and the tool's 150 s
export const BROKER_DATA_TIMEOUT_MS = 30_000;
/** rate_limited and upstream_unavailable retried; refused/not_found/sql_error/script_rejected/invalid never. */
export const BROKER_MAX_ATTEMPTS = 3;

export interface BrokerClientInput {
  /** https://deployer.<apps domain>, from APP_BROKER_URL */
  brokerUrl: string;
  /** sig1 credential for ServiceName "control-plane" (SERVICE_AUTH_SECRET_APP_BROKER) */
  credential: OutboundServiceCredential;
  /** Cloudflare Access service token in front of the broker hostname */
  accessClientId: string;
  accessClientSecret: string;
  fetch: FetchClient;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * deploy: multipart body = part "request" (brokerDeployRequestSchema JSON) + asset parts + worker part,
 * re-streamed from the parsed AppBundle; sig1 headers built over the exact bytes
 * (buildOutboundAuthHeaders); CF-Access-Client-Id/Secret headers; response parsed with
 * brokerDeployResponseSchema or brokerErrorSchema -> AppHostError.
 * data: POST /data with JSON, parsed with brokerDataResponseSchema[op].
 * Logs op, app/resource name and outcome; never bodies, SQL text or secret values.
 */
export function createBrokerClient(input: BrokerClientInput): AppHost & DataHost {
  void input;
  throw new Error("not implemented");
}
