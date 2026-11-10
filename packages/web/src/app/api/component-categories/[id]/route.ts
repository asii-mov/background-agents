import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy(
  ({ id }: { id: string }) => `/component-categories/${encodeURIComponent(id)}`,
  "component category"
);
