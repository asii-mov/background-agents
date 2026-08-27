import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, POST } = settingsProxy(() => "/approved-components", "approved component");
