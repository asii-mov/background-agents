/**
 * The publish order, which is the security argument in one function:
 *   1. bindings      every bound D1 database and KV namespace resolves to an app resource
 *   2. assertFloor   the Terraform `*.<domain>` Access app exists with the visitor policy
 *   3. ensureAccess  the per-app Access app exists with exactly that policy -> AccessGrant (AUD)
 *   4. put           guard + app modules, assets and bindings (AUD from the grant); no hostname
 *   5. attach        re-checks Access, then the Custom Domain: the first moment the app resolves
 * A failed step leaves nothing reachable that was not reachable before, and every step is an
 * ensure, so calling publish again converges.
 */

import type { BrokerDeployRequest, BrokerDeployResponse } from "@open-inspect/shared/app-broker";
import type { BundleAsset, HostingBackend, ScriptModule } from "./backends";
import { PublicIngressError, scriptBindings } from "./backends";
import { assertBindingsOwned, type DataDeps } from "./data";
import type { Edge } from "./edge";
import { accessGuardFailed } from "./errors";
import { appTarget } from "./names";

/** The platform guard: the main module first, and the module name it imports the app under. */
export interface GuardBundle {
  readonly modules: readonly ScriptModule[];
  readonly userModuleName: string;
}

/** A static-only app: the guard serves assets after verifying the visitor. */
const NO_USER_MODULE = "export default null;\n";

export interface PublishDeps extends DataDeps {
  readonly edge: Edge;
  readonly backend: HostingBackend;
  readonly guard: GuardBundle;
}

export interface PublishInput {
  readonly request: BrokerDeployRequest;
  readonly assets: readonly BundleAsset[];
  /** The app's bundled ES module Worker, or null for a static-only app. */
  readonly userModule: Uint8Array | null;
}

export async function publish(
  deps: PublishDeps,
  { request, assets, userModule }: PublishInput,
  signal: AbortSignal
): Promise<BrokerDeployResponse> {
  const target = appTarget(deps.config, request.name);
  await assertBindingsOwned(deps, request.bindings, signal);
  await deps.edge.assertFloor(signal);
  const grant = await deps.edge.ensureAccess(target, signal);

  let versionId: string;
  try {
    ({ versionId } = await deps.backend.put(
      {
        script: target.script,
        deploymentId: request.deploymentId,
        modules: [
          ...deps.guard.modules,
          { name: deps.guard.userModuleName, source: userModule ?? NO_USER_MODULE },
        ],
        assets,
        notFoundHandling: request.notFoundHandling,
        bindings: scriptBindings(deps.config, grant, request.bindings),
      },
      signal
    ));
  } catch (error) {
    if (!(error instanceof PublicIngressError)) throw error;
    await deps.edge.detach(target, signal);
    await deps.backend.remove(target.script, signal);
    throw accessGuardFailed("workers.dev or preview URLs stayed on, so the script was removed");
  }

  const { firstAttach } = await deps.edge.attach(
    grant,
    deps.backend.ingressService(target.script),
    signal
  );
  return {
    url: `https://${target.hostname}`,
    backend: deps.backend.kind,
    cfVersionId: versionId,
    accessAud: grant.aud,
    firstDeploy: firstAttach,
  };
}
