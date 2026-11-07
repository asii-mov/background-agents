import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(
  ({ name }: { name: string }) => `/apps/${encodeURIComponent(name)}/data/migrations/approve`,
  "app migration",
  { POST: "approve app migration" }
);
