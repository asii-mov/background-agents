# OpenInspect verification feature map

The canonical, checked coverage directory is [docs/REPO_MAP.md](../../../../docs/REPO_MAP.md). The
checker requires every user route and every Settings tab to be labelled `browser-covered`,
`backend-only`, or `uncovered`.

| Area                                                | Browser proof                                                      | Playwright grep                           |
| --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| [Core sessions](core-sessions.md)                   | Prompt, live output, terminal, diff, visible PR                    | `sessions.core-workflow-terminal-diff-pr` |
| [Automations](automations.md)                       | Manual trigger and recent completion                               | `automations.trigger-seeded-workflow`     |
| [Analytics](analytics.md)                           | Dashboard data and range change                                    | `analytics.dashboard-range-and-outcomes`  |
| [Integrations](integrations.md)                     | Settings to Slack configuration                                    | `integrations.open-slack-configuration`   |
| [Settings](settings.md)                             | Navigation through 10 of 14 tabs                                   | `settings.navigation-covers-ten-tabs`     |
| [Managed Skills](managed-skills.md)                 | Repository preview and import                                      | `imports the OpenAI Playwright skill`     |
| [MCP Servers](mcp-servers.md)                       | Git-owned metadata and credential rotation                         | `Git-governed MCP`                        |
| [AppSec governance](appsec-governance.md)           | Role assignment/visibility, pipeline creation, and repository risk | `administrator assign\|AppSec catalogue`  |
| [Sandbox network policy](sandbox-network-policy.md) | Allowlist, rejected save, and member denial                        | `outbound allowlist\|sandbox policy`      |

Run every browser proof with:

```bash
npm run test:e2e -w @open-inspect/web
```

Browser tests use local fixtures. Run the mapped lower-level tests before making an end-to-end
security claim.
