import { forwardedQuery } from "@/lib/forwarded-query";
import { settingsProxy } from "@/lib/settings-proxy";

export const { DELETE } = settingsProxy(
  ({ name, key }: { name: string; key: string }, request) =>
    `/apps/${encodeURIComponent(name)}/data/secrets/${encodeURIComponent(key)}${forwardedQuery(request, ["stage"])}`,
  "app secret"
);
