import useSWR from "swr";
import { z } from "zod";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const platformRoleSchema = z.strictObject({
  userId: z.string(),
  role: z.enum(["member", "editor", "admin"]),
});

export function usePlatformRole() {
  const { data: session } = useAuthSession();
  const { data, isLoading, error } = useSWR(session ? "/api/platform/me" : null, async (path) => {
    const response = await browserApiFetch(path);
    if (!response.ok) throw new Error("Failed to load platform role");
    return platformRoleSchema.parse(await response.json());
  });

  return {
    role: data?.role ?? null,
    canWriteCatalog: data?.role === "editor" || data?.role === "admin",
    canManagePlatform: data?.role === "admin",
    loading: isLoading,
    error,
  };
}
