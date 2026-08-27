import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/approved-components/${encodeURIComponent(id)}/consumers`,
  "approved component consumers"
);
