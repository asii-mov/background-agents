# @open-inspect/app-broker

The app broker is the Worker that deploys internal apps into the dedicated apps Cloudflare account.
It is the only holder of the apps-account API token. The control plane calls it over a signed,
Access-protected interface; nothing else talks to `api.cloudflare.com` for apps.

The package holds three Workers:

- `src/` is the broker. It serves `POST /deploy`, `POST /takedown`, `POST /data` and `GET /health`
  as `@open-inspect/shared/app-broker` defines them. Every request must carry a sig1 signature from
  `control-plane`.
- `guard/` is the platform guard, the main module of every app script. It answers 404 on any host
  but the app's own, verifies the visitor's Access token against the app's own AUD, and sets
  `x-openinspect-user-sub` and `x-openinspect-user-email` before the app's code runs.
- `dispatcher/` is the Workers for Platforms dispatcher. It maps `<name>.<apps domain>` to the app's
  namespace script with the broker's own name rule.

`npm run build` writes `dist/index.js` (the broker, with the guard inlined), `dist/guard.mjs`,
`dist/guard-core.mjs` and `dist/dispatcher.js`. Build `@open-inspect/shared` first.

## What the broker guarantees

Every script, hostname and Access app it touches derives from the app name: the script is
`<APPS_SCRIPT_PREFIX><name>` and the hostname is `<name>.<APPS_DOMAIN>`. No request field can name
either. Data ops act only on resources whose Cloudflare name starts with `app-`, checked again on
the name Cloudflare reports for an id.

A deploy runs in this order, and every step is safe to repeat:

1. Bound D1 databases and KV namespaces resolve to `app-` resources.
2. The Terraform `*.<domain>` floor Access app exists with exactly the visitor policy.
3. The per-app Access app exists with exactly that policy. Duplicates are removed and drift is
   repaired.
4. The script is uploaded with the guard as its main module and the per-app AUD as `CF_ACCESS_AUD`.
   A plain Worker is created with workers.dev and previews off, and the setting is read back after
   the deployment. If it reads on, the script is removed and nothing is published.
5. The Access app is checked again, then the hostname is attached. This is the first moment the app
   resolves.
6. When this deploy attached the hostname, the broker waits `APP_DOMAIN_DNS_PUBLISH_WAIT_MS` before
   it returns the URL, so a visitor does not look the name up before its DNS record exists and cache
   NXDOMAIN for the zone's 30-minute negative TTL. A redeploy to an attached hostname returns at
   once.

Takedown reverses it: detach the hostname, remove the script, then detach again and delete the
per-app Access app. The floor is never touched.

## Fake Cloudflare

`test/fake-cloudflare.ts` is an in-memory Cloudflare REST API served as a `fetch` function. Pass
`fake.fetch` wherever the broker takes a `fetch`, with `FAKE_CLOUDFLARE_API_BASE_URL` as the API
base URL. It models Access apps, Workers (scripts, subdomain settings, assets upload sessions,
versions and deployments), Workers for Platforms namespace scripts, custom domains, D1 (databases,
`/query`, Time Travel), KV namespaces, and R2 buckets with lifecycle rules.

Every request that can change what a hostname under the apps domain serves is checked against the
ingress invariant:

- The `*.<apps domain>` floor Access app exists with exactly the visitor policy and covers the host.
- Exactly one per-app Access app exists for the host, with exactly the visitor policy.
- A plain Workers script behind the host has workers.dev and preview URLs off.
- The script behind the host is deployed and its `CF_ACCESS_AUD` is that per-app app's AUD.

A broken rule, or a request to an endpoint the fake does not model, is recorded in
`fake.violations`. End every scenario with `expect(fake.violations).toEqual([])`.

Tests steer it with `fake.inject({ step, status, applyThenFail, times, retryAfterSeconds })` for
failures (a `null` status makes `fetch` reject), `fake.onStep(step, hook)` for races, and the drift
helpers (`deleteFloor`, `setAccessPolicies`, `enableSubdomain`). `FAKE_STEPS` lists every step, for
failure-injection sweeps.

The fake does not assume Cloudflare's safe answers. A Worker created without a `subdomain` setting
gets workers.dev and previews on, unless the test sets `newWorkerSubdomainDefault`. Access accepts
two apps for one hostname. List filters on Access `domain` and D1 `name` match substrings. Deleting
a script leaves its custom domain attached. Branch on HTTP status, not error codes.

## Live smoke

`scripts/live-smoke.ts` checks the fake's assumptions against a real account before rollout. It
records one row per assumption:

1. An exact-hostname Access app takes precedence over the `*.<domain>` floor and issues its own AUD.
2. A token issued for one app is refused at a sibling app's hostname.
3. A Worker created with workers.dev and previews off stays off after versions and deployments.
4. Asset uploads accept `sha256(base64 + extension)` truncated to 32 hex characters.
5. A custom domain gets a certificate. The times until the zone's nameservers serve the hostname and
   until the first HTTPS response are recorded separately.
6. A D1 `/query` body whose second statement fails leaves the first statement unapplied.
7. Takedown (detach the domain, delete the script, revoke the Access app) stops the hostname
   resolving.

`test/live-smoke.test.ts` runs the smoke's API steps (3, 4, 6 and the publish and takedown order)
against the fake, so the script and the fake agree before anyone runs it live.

### Running it

Use a Cloudflare account and zone that exist only for this test. Terraform must not manage them: the
smoke creates its own `*.<domain>` floor Access app.

| Variable                           | Value                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| `APP_BROKER_LIVE_SMOKE`            | `1`. Without it the script prints `SKIPPED` and exits 0.            |
| `APP_BROKER_SMOKE_ACCOUNT_ID`      | The test account id.                                                |
| `APP_BROKER_SMOKE_API_TOKEN`       | An account API token for that account (permissions below).          |
| `APP_BROKER_SMOKE_ZONE_ID`         | The test zone id.                                                   |
| `APP_BROKER_SMOKE_DOMAIN`          | The apps domain inside that zone. Hostnames are one label under it. |
| `APP_BROKER_SMOKE_D1_JURISDICTION` | Optional: `eu` or `fedramp`, as production will use.                |
| `APP_BROKER_SMOKE_API_BASE_URL`    | Optional: defaults to `https://api.cloudflare.com/client/v4`.       |

The token needs Workers Scripts Edit, Workers Routes Edit and DNS Edit on the zone (custom domains),
Access: Apps and Policies Edit, Access: Service Tokens Edit, and D1 Edit.

```bash
export APP_BROKER_SMOKE_ACCOUNT_ID=... APP_BROKER_SMOKE_ZONE_ID=... \
  APP_BROKER_SMOKE_DOMAIN=apps-smoke.example.com
read -rs APP_BROKER_SMOKE_API_TOKEN && export APP_BROKER_SMOKE_API_TOKEN
APP_BROKER_LIVE_SMOKE=1 npm run smoke -w @open-inspect/app-broker
```

A run takes a few minutes; it waits up to 10 minutes each for DNS to publish, for the certificate,
and for DNS to stop resolving. It asks the zone's nameservers directly and connects to the address
they return, because a caching resolver that saw the hostname before it was published keeps the
NXDOMAIN for the zone's SOA minimum (30 minutes on Cloudflare). It creates a service token, two
Access policies, the floor app, two Workers with Access apps and custom domains, and a D1 database,
each with `oi-smoke` and the run id in its name or hostname (the floor app has only `oi-smoke`), and
deletes them before it exits. Anything it could not delete is printed under `Could not delete`. An
interrupted run deletes nothing, so remove that run's `oi-smoke` objects by hand.

It prints a Markdown table of assumptions, results and observations, and exits 1 if any assumption
failed. Paste the table into the PR that enables app hosting. The D1 row includes the real error
envelope; if its status or code differs from the fake's (400, 7500), update the fake. If an
assumption fails, change the fake to match what Cloudflare did, then the broker. The planned
fallbacks are wildcard-only Access with the guard's host pin as the per-app boundary (1, 2),
deleting the script when the post-publish subdomain read shows it on (3), and one statement per D1
request (6).
