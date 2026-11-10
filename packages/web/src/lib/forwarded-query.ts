import type { NextRequest } from "next/server";

/** The named query parameters of `request`, re-encoded for a control-plane path; others drop. */
export function forwardedQuery(request: NextRequest, names: readonly string[]): string {
  const forwarded = new URLSearchParams();
  for (const name of names) {
    const value = request.nextUrl.searchParams.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  const query = forwarded.toString();
  return query ? `?${query}` : "";
}
