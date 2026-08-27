import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const GOVERNANCE_CATALOG_KEY = "/api/governance/catalog";

export interface GovernanceCatalogStatus {
  configured: boolean;
  source?: { provider: string; owner: string; name: string; ref: string; path: string };
  activeCommitSha?: string;
  lastAttemptedAt?: number;
  lastSucceededAt?: number;
  lastStatus: "idle" | "succeeded" | "failed";
  lastError?: string;
}

async function fetchStatus(): Promise<GovernanceCatalogStatus> {
  const response = await browserApiFetch(GOVERNANCE_CATALOG_KEY);
  if (!response.ok) throw new Error("Failed to load Git governance status");
  return response.json();
}

export function useGovernanceCatalog() {
  const { data: session } = useAuthSession();
  const result = useSWR<GovernanceCatalogStatus>(
    session ? GOVERNANCE_CATALOG_KEY : null,
    fetchStatus
  );
  return {
    status: result.data,
    loading: result.isLoading,
    error: result.error,
    mutate: result.mutate,
  };
}

export async function syncGovernanceCatalog(): Promise<GovernanceCatalogStatus> {
  const response = await browserApiFetch("/api/governance/catalog/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = (await response.json().catch(() => ({}))) as Partial<GovernanceCatalogStatus> & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? "Failed to sync Git governance catalog");
  return body as GovernanceCatalogStatus;
}
