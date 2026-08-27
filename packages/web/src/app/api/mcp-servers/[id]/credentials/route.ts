import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT } = settingsProxy(
  ({ id }: { id: string }) => `/mcp-servers/${encodeURIComponent(id)}/credentials`,
  "MCP server credentials"
);
