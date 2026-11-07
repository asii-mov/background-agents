import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/apps", "apps");
