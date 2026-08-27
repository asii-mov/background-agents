# Core sessions

## Browser-covered

- Create a warm session from the home prompt.
- Load the session snapshot through the real Next.js server boundary.
- Subscribe to schema-valid WebSocket state and show assistant output.
- Open a changed file and render its patch.
- Show the terminal iframe and prove the fetched access token is present in its URL.
- Show the agent-created pull request link and open status.

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "sessions.core-workflow"
```

## Boundary

The Playwright test uses a loopback session gateway. It does not create a real Modal sandbox,
execute an agent, enforce terminal authorization, push Git commits, or create a GitHub pull request.
It also starts from an already-ready sandbox and does not exercise follow-up prompts over WebSocket.
Pair it with the session lifecycle, WebSocket, diff, sandbox access, and pull-request integration
proofs in `docs/REPO_MAP.md`.
