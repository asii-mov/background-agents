import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/governance/catalog/sync", "governance catalog sync");
