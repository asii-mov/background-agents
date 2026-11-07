import { forwardedQuery } from "@/lib/forwarded-query";
import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ name }: { name: string }, request) =>
    `/apps/${encodeURIComponent(name)}/data/operations${forwardedQuery(request, ["cursor", "limit"])}`,
  "app data operations"
);
