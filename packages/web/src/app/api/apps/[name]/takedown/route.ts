import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}/takedown`,
  "app",
  { POST: "take down app" }
);
