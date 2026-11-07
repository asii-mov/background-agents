import type {
  BROKER_TAKEDOWN_STEPS,
  BrokerTakedownResponse,
} from "@open-inspect/shared/app-broker";
import type { AppName } from "@open-inspect/shared/apps";
import type { Logger } from "@open-inspect/shared/logger";
import type { HostingBackend } from "./backends";
import type { BrokerConfig } from "./env";
import type { Edge } from "./edge";
import { errorLogFields } from "./errors";
import { appTarget } from "./names";

type TakedownStep = (typeof BROKER_TAKEDOWN_STEPS)[number];

export interface TakedownDeps {
  readonly config: BrokerConfig;
  readonly edge: Edge;
  readonly backend: HostingBackend;
  readonly log: Logger;
}

/**
 * The publish order reversed: the hostname goes first, so the app stops resolving before anything
 * that protects it is removed; the per-app Access app goes last and the floor is never touched.
 * Each step treats "already gone" as done, so re-running a partial takedown finishes it.
 */
export async function takedown(
  deps: TakedownDeps,
  name: AppName,
  signal: AbortSignal
): Promise<BrokerTakedownResponse> {
  const target = appTarget(deps.config, name);
  const steps: readonly [TakedownStep, () => Promise<void>][] = [
    ["detach", () => deps.edge.detach(target, signal)],
    ["remove_script", () => deps.backend.remove(target.script, signal)],
    ["revoke_access", () => deps.edge.revokeAccess(target, signal)],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      if (signal.aborted) throw error;
      deps.log.warn("Takedown step failed", {
        event: "app_broker.takedown_incomplete",
        app: name,
        step,
        ...errorLogFields(error),
      });
      return { cleanupComplete: false, failedStep: step };
    }
  }
  return { cleanupComplete: true };
}
