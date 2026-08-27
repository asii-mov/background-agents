import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/platform/me", "platform role");
