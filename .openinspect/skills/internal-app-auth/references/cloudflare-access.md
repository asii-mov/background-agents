# Cloudflare Access reference

Apps published with `deploy-app` sit behind the platform guard and read identity from its headers.
They need only the [full identity and groups](#full-identity-and-groups) section of this reference.

Every other section applies to an internal app on another host, where nothing verifies the Access
token in front of the app. There the app must verify the token itself at its request boundary.

## Verify every human request on another host

Prefer the company's approved verifier. Search the repository and the `approved-components` catalog
for a shared Cloudflare Access verifier, use it when available, and record its adoption for the
target repository. If none exists, report that gap to AppSec and add a maintained JWT and
remote-JWKS library as an explicit dependency. Do not hide a one-off verifier behind an unrelated
utility name. Do not write JWT parsing, JWKS caching, or cryptography by hand.

Require both settings at startup:

```text
CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CF_ACCESS_AUD=<this application's audience tag>
```

Accept `CF_ACCESS_TEAM_DOMAIN` only as an `https://` origin. Reject a bare hostname, `http://`, a
path, a query, or a fragment. Do not repair an invalid value by adding a scheme.

Put verification in one boundary middleware or request adapter. Protect routes by default and
allow-list any exceptions. Keep an unauthenticated health route only when the host requires one, and
make it return no application data. Keep missing configuration, missing tokens, invalid tokens, and
identity lookup failures closed.

## Application token contract

Cloudflare Access adds the application token to the `Cf-Access-Jwt-Assertion` request header. A
browser request may also contain the token in the `CF_Authorization` cookie, but Cloudflare
recommends verifying the header because the cookie is not guaranteed to reach the origin.

| Purpose   | Value                                                      |
| --------- | ---------------------------------------------------------- |
| Issuer    | `https://<team>.cloudflareaccess.com`                      |
| JWKS      | `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` |
| Algorithm | `RS256`                                                    |
| Audience  | The Access application's AUD tag                           |

Fetch keys through the JWKS endpoint so key rotation does not require a deploy. Cache keys through
the JWT library's remote-JWKS support. Do not pin the current PEM certificate.

Verification must fail closed for:

- Signature and algorithm
- Issuer and per-app audience
- Expiry and not-before time
- Expected application-token type
- Non-empty human `sub` and `email` claims

Require and validate `exp` and `nbf`. Require `iat` as part of the token shape, but never treat it
as a replacement for expiry. Use a small clock tolerance, such as 60 seconds, only for clock skew.
Use `sub` for durable references and keep `email` for display and audit output. Never decode a token
and trust its payload without signature and claim verification.

Official documentation:

- [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)

## Full identity and groups

Custom SAML and OIDC claims may be trimmed when the serialized custom claim grows beyond roughly 1
KB. Cloudflare names group membership as a common cause. Do not make authorization decisions from a
custom JWT `groups` claim.

For current group membership, forward the user's `CF_Authorization` cookie to:

```text
https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity
```

On the platform, read the team origin from `env.CF_ACCESS_TEAM_DOMAIN`. The platform sets that
binding on every app.

Treat a failed identity lookup as an authorization failure. Never cache groups beyond the verified
application token's expiry. If the app requires immediate group revocation, do not cache group
membership. Never fall back to stale groups after an error.

The response body is the identity object. It is not wrapped in an `identity` property. Parse group
membership through one adapter for the company's documented IdP response. The current company
contract uses a top-level `groups` array of objects with non-empty `name` fields. Validate the exact
shape and fail closed when a route requires group membership.

See
[Application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#user-identity).

## Automated services on another host

Cloudflare Access service tokens are credentials for automated callers. The caller presents the
Cloudflare client ID and secret to Access. Access evaluates a Service Auth policy and sends the
origin an application token.

Service-token application tokens use an empty `sub` and a non-empty `common_name`. They do not
contain a human `email`. Require `exp` and `iat`, and validate `nbf` when present. Use `common_name`
as the service-token identifier.

Model the verified request identity as a closed human-or-service variant. A human identity has a
subject and email. A service identity has a service-token identifier and cannot carry a human email.
Do not accept a general API key or bearer token as a substitute for workforce authentication, and do
not manufacture an `email` for a service token.

See
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Local development on another host

Prefer tests that inject a verified identity into the application layer without disabling the
production request boundary.

If interactive local development needs a fake identity, require an explicit development flag and
make startup fail unless the runtime environment is exactly `development` or `test`. An unset or
unknown environment is not development. Never use a condition such as "anything except production"
to skip authentication.

## Origin and account controls

Token verification does not fix a publicly reachable origin. Prefer Cloudflare Tunnel, which uses
outbound-only connections and lets the origin block inbound public traffic.

For Cloudflare accounts dedicated to internal applications, turn on **Block traffic to all domains
in this account**. Cloudflare then blocks a hostname until it has a matching Access application.
Review public hostname exemptions before enabling the setting.

Official documentation:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Require Access protection](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

## Administrator handoff for another host

The operator of the host owns this work. Report it to the user as something an administrator must
do, never as steps for the user:

- Create the Access application and a least-privilege Allow policy.
- Set the per-app audience and team domain in the deployment environment.
- Route the origin through Cloudflare Tunnel or another private path with no direct public ingress.
- Create and scope service tokens for approved automated callers.
- Test both an allowed identity and a denied identity before release.

Do not replace a missing platform setting with application auth. Keep the app fail-closed. The app
still owns application-token verification on another host, so never defer the verifier itself as
administrator work.

## Verifier checklist for another host

- The verifier uses an approved component or a maintained JWT and remote-JWKS library.
- It restricts the algorithm and checks the signature, issuer, audience, and time claims.
- Boundary tests cover a missing token, an invalid signature, the wrong issuer, the wrong audience,
  expiry, not-before time, and identity lookup failure without bypassing the verifier.
- Human identity requires verified `sub` and `email` claims.
- Automated callers use an explicit Access service identity with empty `sub`, non-empty
  `common_name`, and no human `email`.
- Development identity injection cannot start in an unknown or production environment.
- Any approved verifier adoption is recorded for the target repository.
