---
name: internal-app-auth
description:
  Keep sign-in and identity for company internal web apps on the platform's centralized Cloudflare
  Access. Use when creating or changing an internal app, adding identity, ownership, or access
  control, storing per-user data, implementing routes or middleware, reviewing authentication code,
  or deploying an internal app.
---

# Centralize internal app authentication

Company sign-in happens before a request reaches the app. Do not add a second authentication system
inside the app. The app owns only the authorization that sign-in cannot express, such as who may
edit a record or approve a request.

The person asking for the app is often not technical. Never ask them to configure Cloudflare, Access
applications, audiences, policies, DNS, tokens, or Worker settings. When something needs an
administrator, say so in one plain sentence and keep the app working without it.

## Apps published with `deploy-app`

Apps published with the `deploy-app` tool run behind a platform guard. For every request, static
files included, the guard checks the visitor's Cloudflare Access token for this app, removes any
identity headers the visitor sent, and sets two headers before the app code runs:

| Header                     | Value                         | Use                                   |
| -------------------------- | ----------------------------- | ------------------------------------- |
| `x-openinspect-user-sub`   | The verified, stable user ID  | Key owners, assignees, and audit rows |
| `x-openinspect-user-email` | The verified email at sign-in | Display and audit text; it can change |

Follow these rules in app code:

- Read identity only from those two headers.
- Never read identity from `Cf-Access-Authenticated-User-Email`, `X-Forwarded-Email`,
  `X-Forwarded-User`, `X-Auth-User`, a cookie, a query parameter, or the request body.
- Do not verify the Access token again. Do not add a JWT or JWKS library, and do not read
  `CF_ACCESS_AUD` in app code. The guard owns verification.
- Read identity in one function at the request boundary and pass a typed user to handlers. When the
  user ID header is missing or empty, return 401 and do no work.
- Store the user ID as the durable reference. Treat the email as display data.

A static-only app needs no sign-in code at all. An app with server code ships one bundled ES-module
Worker. Serve static files from that Worker with `env.ASSETS.fetch(request)` for every path the code
does not handle.

```ts
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

interface User {
  sub: string;
  email: string;
}

function signedInUser(request: Request): User | null {
  const sub = request.headers.get("x-openinspect-user-sub");
  const email = request.headers.get("x-openinspect-user-email");
  return sub && email ? { sub, email } : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const user = signedInUser(request);
    if (!user) return new Response("Not signed in", { status: 401 });

    if (url.pathname === "/api/notes" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, body FROM notes WHERE owner_sub = ?")
        .bind(user.sub)
        .all();
      return Response.json(results);
    }
    return new Response("Not found", { status: 404 });
  },
};
```

## Declare data and secrets in `openinspect.app.json`

Declare every data store and secret name in `openinspect.app.json` at the project root. The platform
creates a dedicated store per binding and binds it to the Worker as `env.<NAME>`.

```json
{
  "schemaVersion": 1,
  "name": "expense-approvals",
  "data": { "DB": { "kind": "d1" } },
  "secrets": ["EXCHANGE_RATES_API_KEY"]
}
```

- Use `d1` for records, `kv` for caches and small ephemeral state, and `r2` for files.
- Put D1 schema changes in `migrations/` as numbered files such as `0001_create-notes.sql`. Never
  edit or delete a migration that has been deployed. Add a new numbered file instead.
- Never write `wrangler.toml`, `wrangler.json`, or `wrangler.jsonc`. Never put account IDs, database
  IDs, API tokens, or connection strings in the repository.
- A person enters secret values on the app's page in Open-Inspect (Settings, then Apps). Never ask
  for a secret value in chat, and never write one to a file.
- Scope personal records to the signed-in user, as in `WHERE owner_sub = ?` bound to the user ID.

## Decide who may do what

Every published app admits the company's signed-in people. Administrators own that sign-in policy.

When the user wants only some people to use the app or an action, enforce it in the app and fail
closed. Use record ownership, an allow-list kept in the app's own data and managed in the app, or
current identity-provider group membership. For groups, follow the full-identity section of
[the Cloudflare Access reference](references/cloudflare-access.md). Never copy group membership into
a local roles table.

Requests without a person, such as CI jobs, scheduled jobs, or other services, cannot reach apps on
this platform. Tell the user that an administrator must arrange that integration. Do not add API
keys, shared secrets, or unauthenticated routes as a workaround.

## Publish

Build the app, then call `deploy-app` with the build output directory and, when the app has server
code, the bundled Worker file. Calling it again with the same name updates the app. When it fails,
do what its message says. When it succeeds, give the user the URL.

Do not publish through other hosting, public tunnels, or preview URLs.

## Test and run locally

Test handlers with requests that carry both identity headers. Also assert that a request without
them gets 401.

Local tooling may inject a development identity. App code must never invent a user when the headers
are missing. Do not add a branch such as "if not production, use a default user".

## Apps hosted elsewhere

The guard and its headers exist only for apps published with `deploy-app`. For an app on any other
host, the app must verify the Access token itself. Read
[the Cloudflare Access reference](references/cloudflare-access.md) and follow it before writing any
verifier. The operator of that host owns its Access configuration. Report what they must set up to
the user as administrator work, never as steps for the user.

## Do not generate these patterns

- Workforce login, signup, logout, password reset, OAuth, or SAML flows inside the app
- Password hashes, credential tables, or application-managed login sessions
- Auth middleware such as NextAuth, Auth.js, Passport, Flask-Login, or Devise for workforce sign-in
- Identity read from any header other than `x-openinspect-user-sub` and `x-openinspect-user-email`
- A default or fake user when the identity headers are missing
- Route-by-route opt-in protection of data routes
- Hand-written Worker configuration, resource IDs, or credentials in the repository
- Local copies of identity-provider groups as an authorization source

This restriction does not prohibit credentials the app needs to call an unrelated third-party API.
Declare those as secrets in `openinspect.app.json`.

## Check before completion

- Identity is read in one boundary function from `x-openinspect-user-sub` and
  `x-openinspect-user-email`, and a request without them gets 401.
- Durable references use the user ID, not the email.
- No app-local sign-in, credential store, or workforce auth library exists.
- No code reads a forbidden identity header.
- Data stores and secret names are declared in `openinspect.app.json`, schema lives in numbered
  migration files, and no Worker configuration, resource ID, or credential is in the repository.
- Personal records are filtered by the signed-in user.
- Nothing asks the user to do Cloudflare or platform setup. Administrator-only needs are stated in
  one plain sentence.
