import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}/data/restore`,
  "app database",
  { POST: "restore app database" }
);
