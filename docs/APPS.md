# Host agent-built internal apps

When a user asks for an internal app, the agent can deploy it with the `deploy-app` tool. Each app
is served at `https://<name>.<apps_domain>` from a dedicated apps Cloudflare account, behind
Cloudflare Access. This guide sets up that account with Terraform.

Security decides every control in Terraform. The control plane receives a broker URL and two
credentials, and never an apps-account API token. With `apps_enabled = true`, Terraform creates
these objects in the apps account:

- The visitor Access policy, built from `apps_access_include` and `apps_access_require`.
- A `*.<apps_domain>` Access application with only that policy. It gates every hostname under the
  apps domain from the moment DNS exists.
- An Access service token for the control plane, and an Access application on
  `deployer.<apps_domain>` that admits only that token.
- An account-owned API token for the broker. It holds Workers Scripts Write, Access: Apps and
  Policies Write, D1 Write, Workers KV Storage Write and Workers R2 Storage Write on the apps
  account, plus Workers Routes Write and DNS Write on the apps zone.
- The `open-inspect-app-broker-<deployment_name>` Worker. It has workers.dev and preview URLs off
  and serves only `deployer.<apps_domain>`.
- With `apps_hosting_backend = "dispatch-namespace"`, a Workers for Platforms dispatch namespace and
  the `open-inspect-app-dispatcher-<deployment_name>` Worker, also with workers.dev off.

The broker creates the rest for each deploy. That includes the app's own Access application, its
script and its custom domain. The guarantees it keeps are in `packages/app-broker/README.md`.

## Before you start

You need:

- A Cloudflare account used only for apps. Terraform refuses `apps_cloudflare_account_id` when it
  equals `cloudflare_account_id`.
- A zone in that account for the apps domain. See [Choose the apps domain](#choose-the-apps-domain).
- A Zero Trust organization in that account with your identity provider. See
  [Set up Access in the apps account](#set-up-access-in-the-apps-account).
- An API token for the apps account that Terraform uses. It must differ from `cloudflare_api_token`.
  Give it these permissions:
  - Account: Account API Tokens Read and Account API Tokens Write, to mint the broker's token.
  - Account: Access: Apps and Policies Write and Access: Service Tokens Write.
  - Account: Workers Scripts Write.
  - Zone (the apps zone): Workers Routes Write and DNS Write, for the broker's custom domain.
- A passing run of the broker's live smoke test against a separate test account. See
  `packages/app-broker/README.md`.

## Choose the apps domain

Use a separate registered domain that the apps account owns, such as `acme-apps.example`. A zone
belongs to one account. A subdomain of your corporate zone cannot move to the apps account unless
you have Enterprise subdomain delegation.

If you have Enterprise subdomain delegation, you can delegate a subdomain such as `apps.acme.com` to
the apps account instead. Terraform accepts an apps domain under the web app's domain. It refuses an
apps domain that is, or contains, the web app or docs site hostname, because the apps account's
Access floor would then sit in front of them.

An app name is one DNS label, so an app named `inventory` is served at `inventory.<apps_domain>`.
The names `deployer` and `dispatcher` are reserved for the platform.

## Set up Access in the apps account

1. In the apps account, create a Zero Trust organization. Its team domain, such as
   `https://acme-apps.cloudflareaccess.com`, is `apps_access_team_domain`.
2. Add your identity provider to that organization. Register a new application with the provider, or
   federate the provider you already use.
3. Decide who may open apps. Write that as `apps_access_include`, in the
   `cloudflare_zero_trust_access_policy` v5 rule form. For example,
   `[{ email_domain = { domain = "corp.example" } }]` or
   `[{ group = { id = "<access group id>" } }]`.

`apps_access_require` adds rules every visitor must also meet. Device posture rules work only for
devices enrolled in the apps account's Zero Trust organization, and a device enrolls in one
organization at a time. If your devices are enrolled in the platform account's organization, a
posture rule here denies every visitor. The default is SSO only.

## Configure Terraform

1. Build the broker. Terraform uploads `packages/app-broker/dist/index.js` and
   `packages/app-broker/dist/dispatcher.js`.

   ```bash
   npm run build -w @open-inspect/shared
   npm run build -w @open-inspect/app-broker
   ```

2. Add the apps inputs to `terraform/environments/production/terraform.tfvars`:

   ```hcl
   apps_enabled               = true
   apps_cloudflare_account_id = "<apps account id>"
   apps_cloudflare_api_token  = "<apps Terraform token>"
   apps_zone_id               = "<apps zone id>"
   apps_domain                = "acme-apps.example"
   apps_access_team_domain    = "https://acme-apps.cloudflareaccess.com"
   apps_access_include        = [{ email_domain = { domain = "corp.example" } }]
   sandbox_tunnels_policy     = "disabled"
   ```

   Set `app_data_jurisdiction` to `eu` or `fedramp` to create every app database and bucket in that
   jurisdiction. Leave it empty for no jurisdiction. You cannot change the jurisdiction of data that
   already exists.

3. Run `terraform apply`. The broker has no Durable Objects, so one apply is enough.

Terraform fails the plan when `apps_enabled` is true and an input is missing, when the apps token or
account is the platform's, and when the apps account does not offer a permission group the broker
needs.

For CI, add these Actions variables: `APPS_ENABLED`, `APPS_CLOUDFLARE_ACCOUNT_ID`, `APPS_ZONE_ID`,
`APPS_DOMAIN`, `APPS_ACCESS_TEAM_DOMAIN`, `APPS_ACCESS_INCLUDE`, and optionally
`APPS_ACCESS_REQUIRE`, `APPS_HOSTING_BACKEND`, `APP_DATA_JURISDICTION` and `SANDBOX_TUNNELS_POLICY`.
Write the two rule lists as JSON or HCL. Add the apps Terraform token as the
`APPS_CLOUDFLARE_API_TOKEN` secret. Never reuse the `CLOUDFLARE_API_TOKEN` secret for it.

## Check the deployment

Run these checks before you tell users about app hosting:

1. Request the broker without credentials:
   `curl -s -o /dev/null -w '%{http_code}\n' https://deployer.<apps_domain>/health`. Access refuses
   it with `401` instead of a sign-in redirect.
2. Open `https://not-an-app.<apps_domain>` in a browser. Access asks you to sign in through the apps
   account's organization.
3. Ask an agent to build and deploy a small app. Open its URL as an allowed user, then as a user
   that `apps_access_include` does not admit.

## Turn off public preview tunnels

Upstream sandboxes can expose ports on public tunnel URLs without Access. Set
`sandbox_tunnels_policy = "disabled"` once app hosting works. The control plane then rejects
`tunnelPorts` and tells the agent to use `deploy-app`. The default `public` keeps upstream behavior.

## Switch to Workers for Platforms

By default each app is its own Worker in the apps account. Set
`apps_hosting_backend = "dispatch-namespace"` to put app scripts in a Workers for Platforms dispatch
namespace instead. Terraform then creates the namespace and the dispatcher Worker, and the broker
attaches each app's hostname to the dispatcher. Your account needs a Workers for Platforms
subscription.

Choose the backend before the first deploy. The control plane records each app's backend and refuses
to redeploy an app on a different one with `hosting_backend_changed`. To switch later, take down
every app, apply the new backend, then deploy the apps again.

## Rotate credentials

Each command runs from `terraform/environments/production`. Each replacement creates the new
credential, deploys it, then revokes the old one.

| Credential                                         | Rotate with                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Broker API token                                   | `terraform apply -replace='cloudflare_account_token.app_broker[0]'`                            |
| Control plane Access service token                 | `terraform apply -replace='cloudflare_zero_trust_access_service_token.control_plane[0]'`       |
| Shared request-signing secret                      | `terraform apply -replace='random_password.service_auth_secret_app_broker[0]'`                 |
| Apps Terraform token (`apps_cloudflare_api_token`) | Create a new token in the dashboard, update tfvars or the CI secret, then revoke the old token |

The Access service token expires one year after it is created. Replace it before then, or every
deploy fails with `hosting_unavailable`. Its expiry date is in the apps account under **Zero Trust >
Access > Service credentials**. While the signing secret is replaced, the control plane and the
broker update separately, so deploys can fail until both Workers run the new secret.

## Limits

- Terraform does not track the Access applications, scripts, custom domains, databases, KV
  namespaces and buckets that the broker creates for each app. No scheduled job compares the apps
  account with the control plane's records. Keep dashboard access to the apps account to a small
  group, and review its audit log.
- Bundles are limited to 16 MiB, the largest body the control plane signs.
- The broker's token can change any DNS record in the apps zone. Do not host anything else in that
  zone.
