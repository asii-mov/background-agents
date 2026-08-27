import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { bridgeFetch, extractError } from "./_bridge-client.js";

const REPO_MANIFEST_PATH = "/tmp/oi-repo-manifest.json";

function repositories() {
  try {
    const parsed = JSON.parse(readFileSync(REPO_MANIFEST_PATH, "utf8"));
    return (Array.isArray(parsed?.repositories) ? parsed.repositories : [])
      .map((entry) => ({
        owner: String(entry?.owner || "").trim(),
        name: String(entry?.name || "").trim(),
      }))
      .filter((entry) => entry.owner && entry.name);
  } catch {
    return [];
  }
}

export function resolveAdoptionRepository(requested, members) {
  if (requested) {
    const normalized = requested.trim().toLowerCase();
    return (
      members.find((entry) => `${entry.owner}/${entry.name}`.toLowerCase() === normalized) ?? null
    );
  }
  return members.length === 1 ? members[0] : null;
}

export default tool({
  name: "approved-components",
  description:
    "Search the organisation's centrally approved libraries, services, templates, and code snippets before implementing common functionality such as authentication, authorization, logging, secrets, or database access. Results include the reviewed locator, exact version or integrity digest, owner, provenance, and usage instructions. Use action=adopt after you actually choose a component for a repository; this records the consumer so its owner can find applications affected by upgrades or deprecation.",
  args: {
    action: z
      .enum(["search", "adopt"])
      .describe("search discovers applicable approved components; adopt records actual use."),
    query: z
      .string()
      .optional()
      .describe("Search text for names, kinds, descriptions, owners, locators, or usage guidance."),
    componentId: z
      .string()
      .optional()
      .describe("The exact component ID returned by search. Required for adopt."),
    repo: z
      .string()
      .optional()
      .describe(
        'Repository as "owner/name". Required for adopt in multi-repository sessions; inferred in a single-repository session.'
      ),
  },
  async execute(args) {
    try {
      if (args.action === "search") {
        const params = new URLSearchParams();
        if (args.query?.trim()) params.set("query", args.query.trim());
        const suffix = params.size ? `?${params.toString()}` : "";
        const response = await bridgeFetch(`/approved-components${suffix}`);
        if (!response.ok)
          return `Approved component search failed: ${await extractError(response)}`;
        const components = await response.json();
        if (!Array.isArray(components) || components.length === 0) {
          return "No centrally approved component matched this session and query.";
        }
        return JSON.stringify({ count: components.length, components }, null, 2);
      }

      if (!args.componentId) return "componentId is required when action=adopt.";
      const target = resolveAdoptionRepository(args.repo, repositories());
      if (!target) {
        return "repo must identify one repository in this session when action=adopt.";
      }
      const response = await bridgeFetch(
        `/approved-components/${encodeURIComponent(args.componentId)}/adopt`,
        {
          method: "POST",
          body: JSON.stringify({ repoOwner: target.owner, repoName: target.name }),
        }
      );
      if (!response.ok)
        return `Approved component adoption failed: ${await extractError(response)}`;
      return JSON.stringify({ ok: true, consumer: await response.json() }, null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Approved component catalogue unavailable: ${message}`;
    }
  },
});
