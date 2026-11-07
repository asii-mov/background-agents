import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}/release-hold`,
  "app",
  { POST: "release app hold" }
);
