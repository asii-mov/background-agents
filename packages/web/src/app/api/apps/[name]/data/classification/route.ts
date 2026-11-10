import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}/data/classification`,
  "app data classification"
);
