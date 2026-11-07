#!/bin/sh
# Rerunnable verification of the merge worktree. Usage: verify-all.sh <worktree>
S=${SCRATCH:-/tmp/oi-scratch}
export PATH=$S/bin:$PATH NPM_CONFIG_UPDATE_NOTIFIER=false UV_NO_CONFIG=1
R=${1:-/home/asiimov/Projects/secure-generation/open-inspect-upstream-sync}
L=${VERIFY_LOG_DIR:-$S/logs/final}
mkdir -p $L
run() {
  name=$1; shift
  ( cd "$R" && "$@" ) > "$L/$name.log" 2>&1
  code=$?
  summary=$(grep -hE "Test Files .*\(|^ +Tests .*\(|^# (pass|fail) |[0-9]+ passed|All checks passed|already formatted|Repository map is current|SQL portability: clean|All matched files" "$L/$name.log" | tr -s ' ' | tr '\n' ';' | cut -c1-220)
  echo "$name exit=$code $summary"
}
run build-shared npm run build -w @open-inspect/shared
run typecheck npm run typecheck --workspaces --if-present
run test-shared npm test -w @open-inspect/shared
run test-control-plane npm test -w @open-inspect/control-plane
run test-mcp-artifact-builder npm test -w @open-inspect/mcp-artifact-builder
run test-slack-bot npm test -w @open-inspect/slack-bot
run test-github-bot npm test -w @open-inspect/github-bot
run test-linear-bot npm test -w @open-inspect/linear-bot
run test-web npm test -w @open-inspect/web
run int-route-snapshots sh -c "cd packages/control-plane && npx vitest run --config vitest.integration.config.ts test/integration/hono-route-catalog-conformance.test.ts test/integration/route-admission-matrix.test.ts"
run pytest-modal-infra sh -c "cd packages/modal-infra && uv run --frozen --extra dev pytest tests/ -q -p no:cacheprovider"
run pytest-sandbox-runtime sh -c "cd packages/sandbox-runtime && uv run --frozen --extra dev pytest tests/ -q -p no:cacheprovider -o faulthandler_timeout=60"
run node-sandbox-runtime sh -c "cd packages/sandbox-runtime && node --test tests/*.test.mjs"
run ruff-sandbox-runtime sh -c "cd packages/sandbox-runtime && uv run --frozen --extra dev ruff check src/ tests/ && uv run --frozen --extra dev ruff format --check src/ tests/"
run ruff-infra sh -c "uv run --project packages/modal-infra --frozen --extra dev ruff check packages/modal-infra/ packages/e2b-infra/ packages/daytona-infra/ packages/sandbox-images/ && uv run --project packages/modal-infra --frozen --extra dev ruff format --check packages/modal-infra/ packages/e2b-infra/ packages/daytona-infra/ packages/sandbox-images/"
run mypy-sandbox-runtime sh -c "cd packages/sandbox-runtime && uv run --frozen --extra dev mypy src/"
run eslint npm run lint
run prettier npm run format:check
run sql-portability npm run -s lint:sql-portability
run repo-map npm run -s repo-map:check
run script-tests sh -c "npm run -s test:lint-complexity && npm run -s test:lint-sql-portability && npm run -s test:deploy-aws && npm run -s test:terraform-workflow-contract && npm run -s test:node-version-workflow-contract"
run migration-numbers sh -c "ls terraform/d1/migrations | grep -oE '^[0-9]+' | sort | uniq -d | grep . && exit 1 || echo 'no duplicate migration numbers'"
