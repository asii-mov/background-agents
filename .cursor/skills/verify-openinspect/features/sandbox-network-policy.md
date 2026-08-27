# Sandbox network policy

Sandbox settings let platform editors restrict outbound traffic for autonomous agents.

## Browser-covered

- TLS domain and CIDR allowlists.
- A rejected save leaves the stored policy unchanged.
- A member policy change surfaces the server denial.
- Global policy.

## Backend-only

- Unrestricted and blocked policy normalization.
- Empty allowlist validation and fail-closed parsing.
- Current-policy resolution and provider capability checks at sandbox launch.
- Modal mapping for blocked, CIDR, and TLS-domain policies.

Repository and environment network-policy override round trips are `uncovered`; generic scoped
settings tests are not sufficient proof of that policy-specific behavior.

## How to get to it (user POV)

Open **Settings** and select **Sandbox**. Choose **All Repositories (Global)** or a repository.
Select an **Egress policy**. An allowlist requires at least one TLS domain or CIDR range.

## Driving it with Playwright

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "outbound allowlist|sandbox policy"
```

The allowlist test runs as an editor and saves `api.openai.com`, `*.github.com`, and `10.0.0.0/8`.
The rejection test checks the UI shows a control-plane error without changing the saved unrestricted
policy. A member Playwright test checks the server denial reaches the UI.

## Gotchas

Browser errors are intercepted API fixtures. They prove UI behavior, not control-plane authorization
or provider enforcement. Modal is the only current provider declaring support for restrictive
network policy. Other providers are refused later at sandbox launch, not while saving Settings.

Pair policy changes with:

- `packages/control-plane/test/integration/integration-settings.test.ts` for member ownership
  restrictions.
- `packages/control-plane/src/sandbox/settings.test.ts` for validation and fail-closed parsing.
- `packages/control-plane/src/sandbox/lifecycle/manager.test.ts` for provider capability checks and
  current-policy resolution.
- `packages/modal-infra/tests/test_sandbox_resources.py` for Modal's installed API and domain and
  CIDR allowlist arguments.
