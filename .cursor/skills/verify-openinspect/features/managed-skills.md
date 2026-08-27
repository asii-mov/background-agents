# Managed Skills

Managed Skills let an editor review a Skill from a connected repository before OpenInspect stores it
for staff sessions.

## Browser-covered

- Direct repository import.
- Moving `main` branch input.
- Subdirectory selection.
- Previewed commit, source digest, and file contents.
- Stored import provenance.

## Backend-only

- Re-import behavior.
- Git-governed read-only catalogue state.

## How to get to it (user POV)

Open **Settings**, select **Skills**, and stay on **Shared skills**. Editors see **Import from
repository** when Git governance is not configured.

For the temporary OpenAI source, select `openai/skills`. Enter `main` as the ref and
`skills/.curated/playwright` as the subdirectory.

## Driving it with Playwright

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "imports the OpenAI Playwright skill"
```

The test runs as an editor, selects the repository, enters the moving `main` ref, previews the
content, and checks the resolved commit and source digest. The confirmation request must carry the
previewed commit, source digest, and revision digest. The result view must retain the repository,
subdirectory, ref, commit, and source digest.

## Gotchas

The fixture returns a fixed source snapshot. The browser proof establishes what the UI reviewed and
sent, not that the server re-read Git. Pair it with
`packages/control-plane/src/routes/skills.git-governance.test.ts`,
`packages/control-plane/src/skills/import-confirmation.test.ts`,
`packages/control-plane/test/integration/skill-imports.test.ts`, and
`packages/control-plane/src/skills/git-import.test.ts` for write protection, preview confirmation,
and repository-reading boundaries.

Role visibility in the browser does not authorize the write. Pair role changes with
`packages/control-plane/src/db/platform-roles.test.ts` and the managed Skills integration tests.
