/**
 * packages/app-broker/src/index.ts  (NEW package; Hono Worker deployed by Terraform INTO THE APPS ACCOUNT)
 *
 * The only code anywhere that holds the apps-account token or knows api.cloudflare.com paths.
 * Reachable only at https://deployer.<apps domain> behind an exact-hostname Access app with a
 * service-token policy (Terraform). Every request is additionally sig1-verified for ServiceName
 * "control-plane". workers.dev and preview URLs are off (module input workers_dev_enabled=false).
 */
import { Hono } from "hono";
import { APP_BROKER_ROUTES } from "@open-inspect/shared/app-broker";

export interface BrokerEnv {
  APPS_ACCOUNT_ID: string;
  APPS_ZONE_ID: string;
  APPS_DOMAIN: string; // apps.example.com
  APPS_SCRIPT_PREFIX: string; // "app-"  (same prefix as data resources: one grammar)
  APPS_HOSTING_BACKEND: string; // "workers" | "dispatch-namespace"
  APPS_DISPATCH_NAMESPACE?: string;
  APPS_DISPATCHER_SERVICE?: string;
  APPS_ACCESS_TEAM_DOMAIN: string; // https://<team>.cloudflareaccess.com (apps account's org)
  APPS_ACCESS_POLICY_ID: string; // Terraform-owned visitor policy: the only policy ever attached
  APPS_ACCESS_FLOOR_APP_ID: string; // Terraform-owned *.<domain> app
  APP_DATA_JURISDICTION: string; // "" | eu | us | fedramp
  /** Minted by Terraform (cloudflare_account_token) or pasted; rotated by re-apply. */
  APPS_API_TOKEN: string;
  SERVICE_AUTH_SECRET_CONTROL_PLANE: string;
  CLOUDFLARE_API_BASE_URL?: string; // tests point at the fake
}

export const BROKER_MAX_BODY_BYTES = 16 * 1024 * 1024; // == SERVICE_REQUEST_MAX_BODY_BYTES

export const app = new Hono<{ Bindings: BrokerEnv }>();
// app.use("*", verifySig1("control-plane"))           401 on missing/invalid/expired; body hash over exact bytes
// app.get(APP_BROKER_ROUTES.health, ...)              200 {ok:true} (no token use)
// app.post(APP_BROKER_ROUTES.deploy, ...)             multipart -> parseDeployRequest -> publish() -> brokerDeployResponseSchema
// app.post(APP_BROKER_ROUTES.takedown, ...)           -> takedown()
// app.post(APP_BROKER_ROUTES.data, ...)               -> handleDataOp() (data.ts)
// Errors: BrokerRefusal/AppHostError -> { error, message, retryAfterSeconds } with BROKER_ERROR_STATUS.
// Never logs the token, SQL text, secret values or asset bytes.
void APP_BROKER_ROUTES;
export default app;
