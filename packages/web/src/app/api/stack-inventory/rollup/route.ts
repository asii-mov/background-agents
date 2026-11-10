import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/stack-inventory/rollup", "stack adoption rollup");
