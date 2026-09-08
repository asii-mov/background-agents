# Configure workforce SSO with Cloudflare Access

Use this procedure for internal apps produced by OpenInspect. Cloudflare Access authenticates the
workforce user before the request reaches the app. The app verifies the signed Access application
token and keeps its own record-level authorization.

This procedure does not replace OpenInspect's GitHub or Google sign-in. OpenInspect uses that
identity for repository access and user attribution. Keep both layers when you deploy OpenInspect
itself behind Access.

OpenInspect's web middleware verifies `Cf-Access-Jwt-Assertion` on every page and API route,
including the endpoint that mints session WebSocket tokens. Only static Next assets and the bundled
favicon, logo, and syntax stylesheets are exempt. The web boundary rejects service-token identities.

For either web hosting platform, set `cf_access_team_domain` and `cf_access_aud` in Terraform.
Terraform requires both and supplies `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` to the web service.
For deployments outside Terraform, set those two environment variables on the web host directly.
Missing or invalid configuration denies requests.

For Vercel, also set `vercel_custom_domain` to a hostname in a Cloudflare DNS zone. Add the hostname
to Vercel, proxy its DNS record through Cloudflare, and create the Access application for that
hostname. Cloudflare Access cannot protect the provider's `vercel.app` hostname. Preview deployments
deny requests unless you route their hostname through an Access application with the same audience.

For local `next dev`, set `AUTH_DEV_BYPASS=1` and use a loopback hostname such as `localhost` or
`127.0.0.1`. The bypass requires `NODE_ENV=development`; production and unknown environments refuse
it, even when a valid assertion is supplied. Existing local `.env` files need this explicit setting
or the two Access variables. Do not set the bypass in deployed environments.

Keep the control-plane hostname outside the human Access gate. Bots, webhooks, sandboxes, and
session WebSockets use their existing authentication there. The web service signs browser API
requests and retains its browser-session checks. WebSocket tokens currently remain valid for up to
24 hours, so Access logout or policy changes do not immediately revoke a minted token or an open
socket.

## Before you start

You need:

- a Cloudflare Zero Trust account with a team domain
- an existing workforce identity provider, such as Microsoft Entra ID, Okta, or Google Workspace
- an internal hostname for each app
- an IdP group that names the people allowed to use the app

If the IdP supports both OIDC and SAML, use OIDC unless your identity team requires SAML.

## 1. Connect the workforce identity provider

1. In Cloudflare Zero Trust, open **Integrations > Identity providers**.
2. Select **Add new identity provider**.
3. Select the workforce provider. Use the generic OIDC or SAML option when the provider is not
   listed.
4. Register Cloudflare's callback URL in the IdP.
5. Enter the IdP client ID and client secret in Cloudflare Zero Trust.
6. Save the provider, then select **Test**.

Keep the IdP client secret in Cloudflare. Do not copy it into an app `.env` file or the OpenInspect
repository.

Cloudflare documents the supported providers and provider-specific steps in its
[identity provider guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/).

## 2. Create one Access application per internal app

1. Open **Access controls > Applications** in Cloudflare Zero Trust.
2. Add a self-hosted application.
3. Enter the app's internal hostname.
4. Set the session duration to the company's standard.
5. Save the application.

Create a separate application for each hostname that needs its own audience or access policy. Do not
reuse one audience across unrelated apps.

## 3. Add a least-privilege Allow policy

1. Add an **Allow** policy to the Access application.
2. Include the app's workforce group.
3. Add device posture or network requirements when company policy requires them.
4. Do not add a **Bypass** policy for an internal app.
5. Test one allowed user and one denied user.

Use Access policy for broad app entry, such as "Finance can open the budget app." Keep checks such
as "only the assigned approver can approve this request" in the app.

See Cloudflare's
[Access policy guide](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
for policy selectors and evaluation rules.

## 4. Configure application-token verification

Open the Access application and copy its **Application Audience (AUD) Tag**. Add these values to the
app's deployment environment:

```dotenv
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CF_ACCESS_AUD=YOUR_APPLICATION_AUD_TAG
```

`CF_ACCESS_TEAM_DOMAIN` is a full HTTPS origin. `CF_ACCESS_AUD` is unique to the Access application.
Neither value is secret.

OpenInspect verifies the header with the team's JWKS and requires RS256, the exact issuer and
application audience, `exp`, `nbf`, `iat`, `type=app`, and nonempty human `sub` and `email` claims.
It removes Access credentials before handing requests to application routes.

Generated apps must also verify the header at their request boundary. Follow the repository's
[`internal-app-auth` skill](../.openinspect/skills/internal-app-auth/SKILL.md). Do not consider the
deployment complete because the Access login page appears. The origin must still verify the token's
signature, issuer, audience, algorithm, and time claims.

Cloudflare's
[JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
explains the header, JWKS endpoint, and audience tag.

## 5. Configure automated callers

For CI, scheduled jobs, and other non-human callers:

These steps apply to generated apps with explicit service endpoints. OpenInspect's human web
boundary rejects Access service tokens; its automated callers retain their control-plane endpoints.

1. Open **Access controls > Service credentials > Service Tokens**.
2. Create one service token for one caller and purpose.
3. Store the client ID and client secret in the caller's secret store.
4. Add a **Service Auth** policy to the Access application.
5. Restrict the policy by source IP or another available signal when possible.
6. Send both credentials with each request:

```text
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

Do not place service-token credentials in the receiving app. Rotate and revoke each caller without
affecting human access or another service.

See Cloudflare's
[service token guide](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## 6. Prevent direct origin access

1. Route a private origin through Cloudflare Tunnel or another private network path.
2. Remove direct public ingress to the origin.
3. Protect or disable every alternate hostname, including a provider default hostname.
4. On an account dedicated to internal apps, consider **Block traffic to all domains in this
   account** after reviewing every public-hostname exemption.

The account-wide setting blocks hostnames that have no matching Access application. Enabling it on a
mixed public and internal account without reviewing exemptions can take public sites offline. See
Cloudflare's
[Access protection guide](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/).

## 7. Verify the deployment

Complete these checks before release:

1. Open the app as an allowed user and confirm that the request succeeds.
2. Open the app as a denied user and confirm that Access blocks the request.
3. Send a request without an Access token directly to the origin and confirm that it fails.
4. Send a token with the wrong audience and confirm that the app rejects it.
5. Call a service endpoint with a valid service token and confirm that it receives a service
   identity, not a human identity.
6. Revoke the service token and confirm that the caller loses access.

## Keep each credential in its owner

| Value                                                        | Store it here                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| IdP OIDC or SAML client secret                               | Cloudflare Zero Trust identity-provider configuration         |
| `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`                  | App deployment environment, OpenInspect web service only      |
| Access service-token client ID and secret                    | Automated caller's secret store                               |
| Cloudflare deployment API token                              | Terraform or CI secret store                                  |
| OpenInspect GitHub or Google OAuth credentials               | OpenInspect Terraform configuration                           |
| GitHub App, model-provider, and sandbox-provider credentials | OpenInspect Terraform configuration or provider-account store |

Do not collect all of these values in one shared `.env`. Each credential belongs to a different
trust boundary and has a different rotation owner.
