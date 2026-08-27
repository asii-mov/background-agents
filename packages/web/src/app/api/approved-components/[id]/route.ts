import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy(
  ({ id }: { id: string }) => `/approved-components/${encodeURIComponent(id)}`,
  "approved component"
);
