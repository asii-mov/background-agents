import type { AppName, HostingBackendKind } from "@open-inspect/shared/apps";
import type { BROKER_TAKEDOWN_STEPS } from "@open-inspect/shared/app-broker";
import { AppHostError, type AppHost, type AppHostDeployInput, type DeployReceipt } from "./host";

type Step = (typeof BROKER_TAKEDOWN_STEPS)[number];

export interface PublishedApp {
  deploymentId: string;
  cfVersionId: string;
  backend: HostingBackendKind;
  bindings: string[];
  assetPaths: string[];
}

/**
 * An in-memory apps account. `published` is what would be reachable: deploy puts an app there,
 * a complete takedown removes it. Failures and hooks are queued per operation.
 */
export interface FakeAppHost extends AppHost {
  readonly calls: Array<{ op: "deploy" | "takedown"; name: AppName }>;
  readonly published: Map<AppName, PublishedApp>;
  backend: HostingBackendKind;
  /** Thrown by the next deploy calls, in order. */
  readonly deployFailures: AppHostError[];
  /** The next takedown calls stop at these steps, in order. */
  readonly takedownStops: Array<Step | AppHostError>;
  /** Runs after the app is published and before the receipt returns. */
  afterPublish?: (name: AppName) => Promise<void>;
}

export const FAKE_APPS_DOMAIN = "apps.example.test";

export function createFakeAppHost(): FakeAppHost {
  let versions = 0;
  const everAttached = new Set<AppName>();
  const host: FakeAppHost = {
    calls: [],
    published: new Map(),
    backend: "workers",
    deployFailures: [],
    takedownStops: [],
    async deploy(input: AppHostDeployInput): Promise<DeployReceipt> {
      host.calls.push({ op: "deploy", name: input.name });
      const failure = host.deployFailures.shift();
      if (failure) throw failure;
      const cfVersionId = `cf-version-${++versions}`;
      host.published.set(input.name, {
        deploymentId: input.deploymentId,
        cfVersionId,
        backend: host.backend,
        bindings: input.bindings.map((binding) => binding.name),
        assetPaths: input.bundle.assets.map((asset) => asset.path),
      });
      const firstDeploy = !everAttached.has(input.name);
      everAttached.add(input.name);
      await host.afterPublish?.(input.name);
      return {
        url: `https://${input.name}.${FAKE_APPS_DOMAIN}`,
        backend: host.backend,
        cfVersionId,
        accessAud: `aud-${input.name}`,
        firstDeploy,
      };
    },
    async takedown(name: AppName) {
      host.calls.push({ op: "takedown", name });
      const stop = host.takedownStops.shift();
      if (stop instanceof AppHostError) throw stop;
      if (stop) return { cleanupComplete: false, failedStep: stop };
      host.published.delete(name);
      return { cleanupComplete: true };
    },
  };
  return host;
}
