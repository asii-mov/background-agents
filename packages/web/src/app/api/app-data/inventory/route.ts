import { forwardedQuery } from "@/lib/forwarded-query";
import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  (_params: object, request) =>
    `/app-data/inventory${forwardedQuery(request, ["classification", "status", "query", "cursor"])}`,
  "app data inventory"
);
