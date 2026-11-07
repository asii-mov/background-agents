# Integration follow-ups (assigned to later units)

- [U4a] Set AGENT_APP_DEPLOY_ENABLED in sandbox env when hosting is configured (control plane
  launch + modal-infra pass-through). From U9.
- [U4b or integration] Add "deploy-app.js": "AGENT_APP_DEPLOY_ENABLED" to AGENT_TOOLS_GATED_ON_ENV
  in opencode_server.py. From U9.
- [U5] Contract: export DEFAULT_MIGRATIONS_DIR and bridge_error guidance from the app-deploy
  contract; U9 duplicated them. Failure body {reason,message,detail,retryAfterSeconds}; manifest
  part has no filename.
- [U11] Update docs/IDP_AND_ACCESS_SETUP.md: platform-hosted apps trust guard identity headers; JWT
  self-verification only for externally hosted apps. From U9.
- [U4a] runtime_config.py still refuses Claude + security_pipelines inside the sandbox; narrow it
  with assertHarnessGovernance. From U4b.
- [U3] POST /sessions/:id/stack-observations route (plan line 200) must exist; until then sandbox
  reports are only logged. From U4b.
- [U11] Reuse collect_tree_facts(CommitSource), Baseline.of, evaluate from sandbox_runtime for the
  CI CLI. From U4b.
- [U7] Terraform docs: add identity_link_email_domains to terraform.tfvars.example and
  GETTING_STARTED.md (U12 added the variable + workflow TF_VAR). From U12.
- [PR body] Include U12's read-only SQL listing users verified only by bot attestation, for operator
  review after deploy.
- [U7/U11] FORK_DIFFERENCES.md: U12 inserted rows mid-section; rebase own rows carefully.
- [U7] APPS_SCRIPT_PREFIX must start with app-; APP_DATA_JURISDICTION in {"", eu, fedramp} (not us);
  artifacts dist/index.js + dist/dispatcher.js; compat date 2026-06-01. From U6.
- [U5] Sign each broker attempt fresh (replayed nonce = 401); 401/413 bodies
  error:"invalid_request"; url https://<name>.<domain> no trailing slash; WfP cfVersionId = etag.
  From U6.
- [U8] broker d1.restore timestamp is Unix ms. From U6.
- [any/U11] knip.json lacks app-broker entry; jose only used in tests but still in dependencies.
  From U6.
- [U3] new StackInventoryStore(db, new ApprovedComponentStore(db)); map
  StackObservationRejectedError->403, ApprovedComponentConflictError(deleteCategory)->409,
  GitManagedCatalogueError->409. Cap/bound facts per observation request so D1 batch size works on
  free plan too (5000 facts = 627 statements). From U2.
- [U8] Inject renderDataInstructions into ApprovedComponentStore at EVERY compile site (or make
  default) so preview == launch text; resolveForApp(repo|null, env). From U2.
- [U4a] compileForSession(repos, env); prune(now) with STACK_OBSERVATION_RETENTION_MS. From U2.
- [U5] After U3 merge: route-count lines and both route snapshots conflict; regenerate with -u. From
  U3.
- [U8] Inject renderDataInstructions in routes/stack-policy.ts too. From U3.
- [U11] Update docs/GIT_GOVERNANCE_CATALOG.md and SECURE_GENERATION.md editor/admin route table.
  From U3.
- [cleanup] Reject app-row component/category creation with 409 while Git owns the catalogue (today
  it is created then disabled within 15 min). From U3.
- [open, final report] Free-plan CPU: parsing a 5000-fact observation took 12-16 ms locally vs 10 ms
  free CPU limit; lower MAX_OBSERVED_FACTS if running on free plan. From U3.
- [cleanup] Admin write path should reject tunnelPorts when SANDBOX_TUNNELS_POLICY=disabled: pass
  tunnelsPolicy into sandbox validation at the 3 set handlers in routes/integration-settings.ts
  (today ports are silently dropped at launch). From U4a.
- [U5/cleanup] Replace U4a's isAppHostingConfigured with U5's apps/config.ts. From U4a.
- [U8] Launch now compiles the policy; injected renderDataInstructions must apply at launch and
  preview. From U4a.
- [U10a/U10b] No web proxy/download for /stack-policy/export yet; name the UI route in
  docs/STACK_POLICY.md once it exists. From U11.
- [cleanup] knip still reports app-broker unused exports and two unused sandbox tool .js files. From
  U11.
- [final report] CI mirror bypass limits: PR can edit its own workflow; fix with org-required
  workflow + CODEOWNERS on .github/. From U11.
- [cleanup] MCP write route still requires fork catalog.write; swap MCP/skills client gating to
  named permissions together with removing catalog.write from routes/mcp-servers.ts. From U10a.
- [U10b] Edits same settings registry, verification-api.ts and feature directory as U10a; app data
  inventory UI expects GET /app-data/inventory {rows,nextCursor} from U8. From U10a.
