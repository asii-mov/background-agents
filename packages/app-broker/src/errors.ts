import type { BrokerErrorCode } from "@open-inspect/shared/app-broker";
import { CloudflareApiError } from "./cloudflare-api";

/**
 * A request the broker will not carry out, classified with the protocol's error code. Thrown by
 * the domain modules and turned into the wire error once, in index.ts.
 */
export class BrokerRefusal extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "BrokerRefusal";
  }
}

/** The floor or a per-app Access app is missing or not what security configured. Never retried. */
export function accessGuardFailed(detail: string): BrokerRefusal {
  return new BrokerRefusal(
    "access_guard_failed",
    `App sign-in protection is not in place: ${detail}`
  );
}

/**
 * What a log line may say about a failure: the code or the Cloudflare route and status. Never the
 * message, which can quote SQL, and never anything from the request.
 */
export function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof BrokerRefusal) return { error_code: error.code };
  if (error instanceof CloudflareApiError) return { route: error.route, status: error.status };
  return { error_type: error instanceof Error ? error.name : typeof error };
}
