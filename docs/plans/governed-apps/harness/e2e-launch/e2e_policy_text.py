"""Feed the control plane's real Modal launch bodies through modal-infra and the sandbox runtime.

Usage: python e2e_policy_text.py <vitest-output.log>
Checks, per launch: the SESSION_CONFIG Modal builds carries the policy; the sandbox runtime boots
the session (Claude included); the policy file the supervisor writes and the Claude system prompt
both start with exactly the instructions the preview compiled.
"""

import importlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

# Same inert image reference the modal-infra test suite registers functions with.
with (
    patch("modal.is_local", return_value=False),
    patch.dict(os.environ, {"OPENINSPECT_MODAL_BASE_IMAGE_ID": "im-test-functions"}),
):
    importlib.import_module("src")

from sandbox_runtime.platform_context import (
    claude_system_prompt_append,
    materialize_stack_policy,
    stack_policy_path,
)
from sandbox_runtime.runtime_config import RuntimeConfig
from sandbox_runtime.stack_policy import parse_stack_policy
from src.web_api import _session_config_from_create_request

log = Path(sys.argv[1]).read_text()
dumps = [json.loads(m) for m in re.findall(r"@@LAUNCH@@(.*?)@@END@@", log)]
assert len(dumps) == 2, f"expected 2 launch dumps, found {len(dumps)}"
for dump in dumps:
    body, preview = dump["launch"], dump["preview"]
    session_config = _session_config_from_create_request(
        body, repo_owner=body["repo_owner"], repo_name=body["repo_name"]
    )
    env_session_config = session_config.model_dump_json()
    runtime = RuntimeConfig.from_env({"SESSION_CONFIG": env_session_config})
    policy = parse_stack_policy(json.loads(env_session_config))
    assert policy is not None, "policy dropped between the control plane and the sandbox"
    with tempfile.TemporaryDirectory() as config_dir:
        materialize_stack_policy(policy, Path(config_dir))
        written = stack_policy_path(Path(config_dir)).read_text()
        appended = claude_system_prompt_append(policy, None, Path(config_dir))
    assert written == preview["instructions"], "policy file differs from the preview text"
    assert appended == preview["instructions"].strip(), "Claude prompt differs from the preview"
    assert policy.digest == preview["digest"]
    print(
        f"{dump['harness']}: harness={runtime.session_config['harness']} "
        f"rules={len(policy.rules)} digest={policy.digest[:16]} "
        f"instructions={len(written)} chars, file == preview: True, claude append == preview: True"
    )
print("E2E OK")
