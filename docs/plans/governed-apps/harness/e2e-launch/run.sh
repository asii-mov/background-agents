#!/bin/sh
# Rerunnable: dumps the control plane's real launch bodies, then checks them in Python.
set -eu
S=${SCRATCH:-/tmp/oi-scratch}
W=${1:-/home/asiimov/Projects/secure-generation/oi-unit-U4a}
export PATH=$S/bin:$PATH NPM_CONFIG_UPDATE_NOTIFIER=false UV_NO_CONFIG=1
TMP_TEST=$W/packages/control-plane/test/integration/zz-u4a-dump-launch.test.ts
cp $S/u4a-e2e/dump-launch.test.ts "$TMP_TEST"
trap 'rm -f "$TMP_TEST"' EXIT
(cd $W/packages/control-plane && npx vitest run --config vitest.integration.config.ts --silent=false --reporter=verbose test/integration/zz-u4a-dump-launch.test.ts) > $S/u4a-e2e/vitest.log 2>&1
(cd $W/packages/modal-infra && uv run --frozen --extra dev python $S/u4a-e2e/e2e_policy_text.py $S/u4a-e2e/vitest.log)
