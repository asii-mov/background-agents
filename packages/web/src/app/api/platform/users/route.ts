import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/platform/users", "platform users");
