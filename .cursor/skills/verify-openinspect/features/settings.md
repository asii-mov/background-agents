# Settings

## Browser-covered

The navigation Playwright test clicks through 10 of the 14 production tabs and proves their headings
render:

- Secrets
- Models
- Appearance
- Keyboard
- Data Controls
- Sandbox
- Integrations
- Skills
- MCP Servers
- AppSec

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "settings.navigation"
```

## Backend-only

Environments, Accounts, Images, and SCM Settings have lower-level tests but no Playwright test.

Navigation proves headings only. Other Playwright tests cover Skill import, MCP credential rotation,
AppSec writes, sandbox policy saves and denials, and role visibility. The map labels all remaining
behavior explicitly.
