---
name: internal-app-auth
description:
  Enforce centralized Cloudflare Access authentication for company internal web apps. Use when
  creating or changing an internal app, adding identity or access control, implementing routes or
  middleware, reviewing authentication code, or preparing an internal app for deployment.
---

# Centralize internal app authentication

Cloudflare Access owns workforce sign-in and decides who may reach an internal app. Do not add a
second authentication system inside the app.

The app still has two security duties. It must verify the Cloudflare Access application token, and
it must enforce any record-level or action-level authorization that Access cannot express.

## Follow this workflow

1. Confirm that the target is a company internal app. Stop and report that this skill does not apply
   to a customer-facing identity system.
2. Classify each caller as a human or an automated service. Do not treat a service identity as a
   human user.
3. Search the repository and the `approved-components` catalog for the company's shared Cloudflare
   Access verifier. Use it when available and record its adoption for the target repository.
4. Before writing a verifier, read
   [the Cloudflare Access reference](references/cloudflare-access.md).
5. Put verification in one boundary middleware or request adapter. Protect routes by default and
   allow-list any exceptions.
6. Keep missing configuration, missing tokens, invalid tokens, and identity lookup failures closed.
7. Report the Cloudflare Access and origin-network configuration that a platform owner must apply.

If no approved verifier exists, report that gap to AppSec. Do not hide a new one-off verifier behind
an unrelated utility name. Add a maintained JWT and remote-JWKS library as an explicit dependency.
If registry access is unavailable, still declare the dependency and implement the verifier against
the maintained library API. Keep startup fail-closed when the dependency cannot load, and report the
verification that you could not run. Do not replace the library with handwritten JWT parsing, JWKS
caching, or cryptography.

## Keep ownership at the right layer

- The identity provider owns workforce identities, credentials, MFA, group membership, and
  offboarding.
- Cloudflare Access owns app-level admission policy.
- The app verifies the signed application token at its request boundary.
- The app owns authorization for records and actions inside the app.

Implement a requirement such as "only Finance may open this app" as a Cloudflare Access policy.
Implement a requirement such as "only the assigned approver may approve this request" in the app.

An app may store a profile, preferences, ownership, or audit data for a verified user. Key durable
references by the verified `sub` claim. Treat `email` as mutable display and audit data. Do not
store passwords, login sessions, or a copied directory of group membership.

## Verify every human request

Require both settings at startup:

```text
CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CF_ACCESS_AUD=<this application's audience tag>
```

Accept `CF_ACCESS_TEAM_DOMAIN` only as an `https://` origin. Reject a bare hostname, `http://`, a
path, a query, or a fragment. Do not repair an invalid value by adding a scheme.

Validate the Access application token against the contract in the reference. At minimum,
verification must fail closed for:

- Signature and algorithm
- Issuer and per-app audience
- Expiry and not-before time
- Expected application-token type
- Non-empty human subject and email claims

Reject a missing or invalid token. Never decode a token and trust its payload without signature and
claim verification. Never trust `X-Forwarded-Email`, `X-Auth-User`, or another unsigned header as an
identity.

Apply the verifier to the whole router or framework boundary. Keep an unauthenticated health route
only when the hosting platform requires one, and make that route return no application data.

## Keep broad roles in the identity provider

Use Cloudflare Access policy for coarse app entry. If users need different roles inside one app,
read current group membership from Cloudflare's full identity endpoint and bind app behavior to the
company's IdP group names.

Parse the response body as the identity object itself, not as an `identity` wrapper. Read group data
through one adapter for the company's documented identity shape. The current company contract uses a
top-level `groups` array whose entries have non-empty `name` fields. If a route needs groups, reject
a missing or malformed group response.

Do not authorize from a custom `groups` claim in the JWT. Cloudflare does not include groups by
default and may trim custom claims. Do not mirror IdP group membership into a local roles table.

The app may still enforce resource facts that the IdP cannot know, such as record ownership,
approval state, or separation of duties.

## Route automated callers through Access

Use a Cloudflare Access service token and a Service Auth policy for CI, scheduled jobs, or another
service. Keep service-only endpoints explicit. Validate the resulting application token for the same
issuer and audience. Require an empty `sub`, a non-empty `common_name`, and no human `email`. Use
`common_name` as the service-token identifier. Require `exp` and `iat`, and validate `nbf` when the
token contains it.

Model the verified request identity as a closed human-or-service variant. A human identity has a
subject and email. A service identity has a service-token identifier and cannot carry a human email.

Do not accept a general API key or bearer token as a substitute for workforce authentication. Do not
manufacture an `email` for a service token.

## Keep local development fail-closed

Prefer tests that inject a verified identity into the application layer without disabling the
production request boundary.

If interactive local development needs a fake identity, require an explicit development flag and
make startup fail unless the runtime environment is exactly `development` or `test`. An unset or
unknown environment is not development. Never use a condition such as "anything except production"
to skip authentication.

## Do not generate these patterns

- Workforce login, signup, logout, password reset, OAuth, or SAML flows inside the app
- Password hashes, credential tables, or application-managed login sessions
- Auth middleware such as NextAuth, Auth.js, Passport, Flask-Login, or Devise for workforce sign-in
- Token decoding without signature, issuer, and audience verification
- Route-by-route opt-in protection
- A production-capable authentication bypass
- Local copies of IdP groups as an authorization source

This restriction does not prohibit OAuth credentials that the app needs to call an unrelated
third-party API. Keep that integration separate from workforce sign-in.

## Report platform handoffs

Finish the task by listing any work that remains outside the repository:

- Create the Access application and a least-privilege Allow policy.
- Set the per-app audience and team domain in the deployment environment.
- Route the origin through Cloudflare Tunnel or another private path with no direct public ingress.
- Enable Cloudflare's account-wide Access protection when the account is dedicated to internal
  applications.
- Create and scope service tokens for approved automated callers.
- Test both an allowed identity and a denied identity before release.

Do not replace a missing platform setting with application auth. Keep the app fail-closed and report
the missing setting. The platform owns the Access application and policy. The app still owns
application-token verification, so never defer the verifier itself as platform work.

## Check before completion

- No app-local workforce sign-in or credential store exists.
- Every data-bearing route passes through token verification.
- The verifier uses an approved component or a maintained JWT and remote-JWKS library. It contains
  no handwritten token parsing, JWKS cache, or cryptography.
- The verifier restricts the algorithm and checks the signature, issuer, audience, and time claims.
- Boundary checks cover a missing token, an invalid signature, the wrong issuer, the wrong audience,
  expiry, not-before time, and identity lookup failure without bypassing the verifier.
- Human identity requires verified `sub` and `email` claims.
- Group-based roles use the full identity response, not JWT custom claims.
- Automated callers use an explicit Access service identity with empty `sub`, non-empty
  `common_name`, and no human `email`.
- Development identity injection cannot start in an unknown or production environment.
- The deployment handoff prevents direct origin access.
- Any approved verifier adoption is recorded for the target repository.
