# Cloudflare Access reference

Read this reference before implementing or reviewing the request boundary for an internal app.
Prefer the company's approved verifier package. Use a maintained JWT library when no approved
package exists. Do not implement JWT cryptography.

## Application token contract

Cloudflare Access adds the application token to the `Cf-Access-Jwt-Assertion` request header. A
browser request may also contain the token in the `CF_Authorization` cookie, but Cloudflare
recommends verifying the header because the cookie is not guaranteed to reach the origin.

Use these endpoints and values:

| Purpose   | Value                                                      |
| --------- | ---------------------------------------------------------- |
| Issuer    | `https://<team>.cloudflareaccess.com`                      |
| JWKS      | `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` |
| Algorithm | `RS256`                                                    |
| Audience  | The Access application's AUD tag                           |

Treat the team domain as a full HTTPS origin. Reject a bare hostname, an HTTP origin, a path, a
query, or a fragment. Do not add or replace the scheme in application code.

Fetch keys through the JWKS endpoint so key rotation does not require a deploy. Cache keys through
the JWT library's remote-JWKS support. Do not pin the current PEM certificate.

For a human request, accept the identity only after verification and claim validation. Require an
application token with string `sub` and `email` claims. Use `sub` for durable references and retain
`email` for display and audit output.

A verifier must require and validate `exp` and `nbf`. Require `iat` as part of the token shape. Do
not treat `iat` as a replacement for expiry. Use a small clock tolerance, such as 60 seconds, only
for clock skew.

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

Treat a failed identity lookup as an authorization failure. Never cache groups beyond the verified
application token's expiry. If the app requires immediate group revocation, do not cache group
membership. Never fall back to stale groups after an error.

The response body is the identity object. It is not wrapped in an `identity` property. Parse group
membership through one adapter for the company's documented IdP response. The current company
contract uses a top-level `groups` array of objects with non-empty `name` fields. Validate the exact
shape and fail closed when a route requires group membership.

See
[Application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#user-identity).

## Automated services

Cloudflare Access service tokens are credentials for automated callers. The caller presents the
Cloudflare client ID and secret to Access. Access evaluates a Service Auth policy and sends the
origin an application token.

Service-token application tokens use an empty `sub` and a non-empty `common_name`. They do not
contain a human `email`. Require `exp` and `iat`, and validate `nbf` when present. Use `common_name`
as the service-token identifier, and keep the service identity variant separate from the human
identity variant in application code.

See
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

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
