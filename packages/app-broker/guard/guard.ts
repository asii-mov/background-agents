/**
 * The platform guard: the main module of every app script, on both hosting backends. build.mjs
 * bundles this file as guard-core.mjs and writes guard.mjs, which imports it before the app's
 * module and exports `createGuard(app)`. With `run_worker_first: true` it runs before static
 * assets too, so nothing an app serves is reachable without a verified Access token for this
 * app's own AUD on this app's own hostname.
 */

import {
  ACCESS_IDENTITY_HEADERS,
  APP_PLATFORM_BINDINGS,
  FORBIDDEN_IDENTITY_HEADERS,
} from "@open-inspect/shared/types/app-data";
import { verifyAccessJwt } from "./access-jwt";

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const ACCESS_JWT_COOKIE = "CF_Authorization";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface AppHandler {
  fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
}

/** The app's own module, as `import * as app from "./app.mjs"` sees it. */
export interface AppModule {
  readonly default?: unknown;
}

function appHandler(app: AppModule): AppHandler | null {
  const handler = app.default;
  return typeof handler === "object" &&
    handler !== null &&
    typeof (handler as { fetch?: unknown }).fetch === "function"
    ? (handler as AppHandler)
    : null;
}

function cookie(header: string | null, name: string): string | null {
  for (const pair of (header ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return null;
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export function createGuard(app: AppModule) {
  return {
    async fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> {
      const teamDomain = env[APP_PLATFORM_BINDINGS.teamDomain];
      const aud = env[APP_PLATFORM_BINDINGS.aud];
      const hostname = env[APP_PLATFORM_BINDINGS.hostname];
      const assets = env[APP_PLATFORM_BINDINGS.assets] as Fetcher | undefined;
      if (
        typeof teamDomain !== "string" ||
        !teamDomain ||
        typeof aud !== "string" ||
        !aud ||
        typeof hostname !== "string" ||
        !hostname ||
        typeof assets?.fetch !== "function"
      ) {
        return text("This app is not configured.", 503);
      }

      if (new URL(request.url).hostname !== hostname.toLowerCase()) {
        return text("Not found.", 404);
      }

      const token =
        request.headers.get(ACCESS_JWT_HEADER) ??
        cookie(request.headers.get("cookie"), ACCESS_JWT_COOKIE);
      const verdict = await verifyAccessJwt(token, {
        teamDomain: teamDomain.replace(/\/+$/, ""),
        aud,
      });
      if (!verdict.ok) {
        return text("Sign in through your company's single sign-on to open this app.", 403);
      }

      const headers = new Headers(request.headers);
      for (const name of FORBIDDEN_IDENTITY_HEADERS) headers.delete(name);
      headers.set(ACCESS_IDENTITY_HEADERS.sub, verdict.identity.sub);
      headers.set(ACCESS_IDENTITY_HEADERS.email, verdict.identity.email);
      const verified = new Request(request, { headers });

      const handler = appHandler(app);
      return handler ? handler.fetch(verified, env, ctx) : assets.fetch(verified);
    },
  };
}
