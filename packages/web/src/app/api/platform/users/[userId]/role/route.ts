import { settingsProxy } from "@/lib/settings-proxy";

export const { PATCH } = settingsProxy(
  ({ userId }: { userId: string }) => `/platform/users/${encodeURIComponent(userId)}/role`,
  "platform role"
);
