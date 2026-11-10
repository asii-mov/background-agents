import { forwardedQuery } from "@/lib/forwarded-query";
import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  (_params: object, request) =>
    `/stack-policy/preview${forwardedQuery(request, ["repo", "environmentId"])}`,
  "stack policy preview"
);
