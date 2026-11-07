/**
 * The hostname lifecycle, the same for both hosting backends: Cloudflare Access in front, a
 * Workers Custom Domain as the only ingress.
 *
 * Invariant this module owns: a hostname under the apps domain is attached to a Worker only while
 * the Terraform floor app `*.<domain>` carries exactly the visitor policy and one per-app Access
 * app for exactly that hostname carries exactly that policy. `attach` takes an AccessGrant and
 * only `ensureAccess` mints one, so "attach without Access" does not compile. The per-app app
 * gives each app its own AUD, so one app's Worker cannot replay a visitor's token at another.
 */

import { z } from "zod";
import { findOrCreate, hasStatus, type CloudflareApi } from "./cloudflare-api";
import type { BrokerConfig } from "./env";
import { accessGuardFailed, BrokerRefusal } from "./errors";
import type { AppTarget } from "./names";

declare const grantBrand: unique symbol;

/** Proof that Access gates exactly `target.hostname` with the visitor policy. */
export interface AccessGrant {
  readonly target: AppTarget;
  readonly accessAppId: string;
  /** Per-app audience tag; the app script receives it as CF_ACCESS_AUD. */
  readonly aud: string;
  readonly [grantBrand]: true;
}

export interface Edge {
  /** The Terraform floor app exists, covers `*.<domain>`, and carries exactly the visitor policy. */
  assertFloor(signal: AbortSignal): Promise<void>;
  /** Find or create the per-app Access app; remove duplicates; repair its policy if it drifted. */
  ensureAccess(target: AppTarget, signal: AbortSignal): Promise<AccessGrant>;
  /**
   * Re-check the floor and the grant's Access app, then point the hostname's Custom Domain at
   * `service`. Re-points a domain held by the app's own script or the dispatcher; refuses any
   * other holder, and never overrides a DNS record the platform did not create.
   */
  attach(
    grant: AccessGrant,
    service: string,
    signal: AbortSignal
  ): Promise<{ firstAttach: boolean }>;
  /** Remove the hostname's Custom Domains held by the app's own services. Absent = done. */
  detach(target: AppTarget, signal: AbortSignal): Promise<void>;
  /**
   * Delete the per-app Access app, after detaching again so Access never goes while a hostname is
   * attached. Only exact app hostnames reach here; the floor is never touched. Absent = done.
   */
  revokeAccess(target: AppTarget, signal: AbortSignal): Promise<void>;
}

const accessAppSchema = z.object({
  id: z.string().min(1),
  aud: z.string().min(1),
  domain: z.string(),
  created_at: z.string().optional(),
  policies: z.array(z.union([z.string(), z.object({ id: z.string() })])).default([]),
});
type AccessApp = z.output<typeof accessAppSchema>;

const customDomainSchema = z.object({
  id: z.string().min(1),
  hostname: z.string(),
  service: z.string(),
});

function policyIds(app: AccessApp): string[] {
  return app.policies.map((policy) => (typeof policy === "string" ? policy : policy.id));
}

export function createEdge(api: CloudflareApi, config: BrokerConfig): Edge {
  const { policyId, floorAppId } = config.access;
  const hasOnlyVisitorPolicy = (app: AccessApp) => {
    const ids = policyIds(app);
    return ids.length === 1 && ids[0] === policyId;
  };

  /** The only Access app body the broker ever sends: there is no parameter for another policy. */
  const perAppBody = (target: AppTarget) => ({
    name: `Open-Inspect app ${target.hostname}`,
    type: "self_hosted",
    domain: target.hostname,
    destinations: [{ type: "public", uri: target.hostname }],
    policies: [{ id: policyId, precedence: 1 }],
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
  });

  /** Oldest first, so a repeat keeps the app (and AUD) the first deploy created. */
  async function perAppApps(target: AppTarget, signal: AbortSignal): Promise<AccessApp[]> {
    const apps = await api.list("/access/apps", accessAppSchema, {
      signal,
      query: { domain: target.hostname, exact: "true" },
    });
    return apps
      .filter((app) => app.id !== floorAppId && app.domain.toLowerCase() === target.hostname)
      .sort(
        (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id)
      );
  }

  async function deleteAccessApp(id: string, signal: AbortSignal): Promise<void> {
    if (id === floorAppId) throw accessGuardFailed("refusing to delete the floor Access app");
    try {
      await api.call("DELETE", `/access/apps/${encodeURIComponent(id)}`, z.unknown(), { signal });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
  }

  async function domainsFor(target: AppTarget, signal: AbortSignal) {
    const domains = await api.call("GET", "/workers/domains", z.array(customDomainSchema), {
      signal,
      query: { hostname: target.hostname, zone_id: config.zoneId },
    });
    return domains.filter((domain) => domain.hostname.toLowerCase() === target.hostname);
  }

  const ownServices = (target: AppTarget): ReadonlySet<string> =>
    new Set([
      target.script,
      ...(config.hosting.kind === "dispatch-namespace" ? [config.hosting.dispatcherService] : []),
    ]);

  async function assertFloor(signal: AbortSignal): Promise<void> {
    let floor: AccessApp;
    try {
      floor = await api.call(
        "GET",
        `/access/apps/${encodeURIComponent(floorAppId)}`,
        accessAppSchema,
        { signal }
      );
    } catch (error) {
      if (hasStatus(error, 404)) throw accessGuardFailed("the apps floor Access app is missing");
      throw error;
    }
    if (floor.domain.toLowerCase() !== `*.${config.appsDomain}` || !hasOnlyVisitorPolicy(floor)) {
      throw accessGuardFailed("the apps floor Access app no longer has the configured policy");
    }
  }

  async function detach(target: AppTarget, signal: AbortSignal): Promise<void> {
    const own = ownServices(target);
    for (const domain of await domainsFor(target, signal)) {
      if (!own.has(domain.service)) continue;
      try {
        await api.call("DELETE", `/workers/domains/${encodeURIComponent(domain.id)}`, z.unknown(), {
          signal,
        });
      } catch (error) {
        if (!hasStatus(error, 404)) throw error;
      }
    }
  }

  return {
    assertFloor,

    async ensureAccess(target, signal) {
      const { value: apps } = await findOrCreate(
        async () => {
          const found = await perAppApps(target, signal);
          return found.length > 0 ? found : null;
        },
        async () => [
          await api.call("POST", "/access/apps", accessAppSchema, {
            signal,
            body: perAppBody(target),
          }),
        ]
      );
      const [kept, ...duplicates] = apps;
      for (const duplicate of duplicates) await deleteAccessApp(duplicate.id, signal);
      const app = hasOnlyVisitorPolicy(kept)
        ? kept
        : await api.call("PUT", `/access/apps/${encodeURIComponent(kept.id)}`, accessAppSchema, {
            signal,
            body: perAppBody(target),
          });
      return { target, accessAppId: app.id, aud: app.aud } as AccessGrant;
    },

    async attach(grant, service, signal) {
      const { target } = grant;
      await assertFloor(signal);
      let app: AccessApp;
      try {
        app = await api.call(
          "GET",
          `/access/apps/${encodeURIComponent(grant.accessAppId)}`,
          accessAppSchema,
          { signal }
        );
      } catch (error) {
        if (hasStatus(error, 404)) throw accessGuardFailed(`no Access app for ${target.hostname}`);
        throw error;
      }
      if (
        app.domain.toLowerCase() !== target.hostname ||
        app.aud !== grant.aud ||
        !hasOnlyVisitorPolicy(app)
      ) {
        throw accessGuardFailed(`the Access app for ${target.hostname} changed during the deploy`);
      }

      const [existing] = await domainsFor(target, signal);
      if (existing?.service === service) return { firstAttach: false };
      if (existing && !ownServices(target).has(existing.service)) {
        throw new BrokerRefusal(
          "hostname_conflict",
          `${target.hostname} is already used by something the platform did not deploy.`
        );
      }
      try {
        await api.call("PUT", "/workers/domains", z.unknown(), {
          signal,
          body: {
            hostname: target.hostname,
            service,
            zone_id: config.zoneId,
            environment: "production",
            ...(existing ? { override_existing_origin: true } : {}),
          },
        });
      } catch (error) {
        if (hasStatus(error, 409)) {
          throw new BrokerRefusal(
            "hostname_conflict",
            `${target.hostname} already has DNS records the platform did not create.`
          );
        }
        throw error;
      }
      return { firstAttach: existing === undefined };
    },

    detach,

    async revokeAccess(target, signal) {
      await detach(target, signal);
      if ((await domainsFor(target, signal)).length > 0) {
        throw new BrokerRefusal(
          "hostname_conflict",
          `${target.hostname} is still attached, so its Access app stays.`
        );
      }
      for (const app of await perAppApps(target, signal)) await deleteAccessApp(app.id, signal);
    },
  };
}
