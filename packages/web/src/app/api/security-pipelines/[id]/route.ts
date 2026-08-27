import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy(
  ({ id }: { id: string }) => `/security-pipelines/${encodeURIComponent(id)}`,
  "security pipeline"
);
