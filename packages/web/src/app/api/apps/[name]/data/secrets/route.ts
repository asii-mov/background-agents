import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}/data/secrets`,
  "app secrets",
  { POST: "set app secrets" }
);
