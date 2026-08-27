import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy(() => "/repository-risk", "repository risk profile");
