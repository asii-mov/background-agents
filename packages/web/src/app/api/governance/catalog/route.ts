import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/governance/catalog", "governance catalog");
