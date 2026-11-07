import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/stack-inventory", "stack inventory");
