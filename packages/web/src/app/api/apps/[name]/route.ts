import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}`,
  "app"
);
