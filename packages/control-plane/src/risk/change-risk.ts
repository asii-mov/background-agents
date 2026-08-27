export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const WEIGHT: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };

const CRITICAL_CHANGE = [
  /(^|\/)(auth|authentication|authorization|iam|rbac|acl)(\/|\.|$)/i,
  /(^|\/)(crypto|cryptography|secrets?|payments?|billing)(\/|\.|$)/i,
  /(^|\/)(production|prod)(\/|\.|$)/i,
];
const HIGH_CHANGE = [
  /(^|\/)(infra|infrastructure|terraform|k8s|kubernetes|network|firewall)(\/|\.|$)/i,
  /(^|\/)(migrations?|database|db)(\/|\.|$)/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements.*\.txt|uv\.lock)$/i,
  /(^|\/)(api|routes?|controllers?)(\/|\.|$)/i,
];
const LOW_CHANGE = [
  /(^|\/)(docs?|tests?|__tests__|fixtures?|examples?)(\/|\.|$)/i,
  /\.(md|txt|css|scss|png|jpe?g|gif|svg)$/i,
];

export interface RiskAssessment {
  repositoryCriticality: RiskLevel;
  changeSensitivity: RiskLevel;
  score: number;
  requiresSecurityReview: boolean;
  matchedPaths: string[];
}

export function classifyChangeSensitivity(paths: readonly string[]): {
  level: RiskLevel;
  matchedPaths: string[];
} {
  if (paths.length === 0) return { level: "low", matchedPaths: [] };
  const critical = paths.filter((path) => CRITICAL_CHANGE.some((pattern) => pattern.test(path)));
  if (critical.length) return { level: "critical", matchedPaths: critical };
  const high = paths.filter((path) => HIGH_CHANGE.some((pattern) => pattern.test(path)));
  if (high.length) return { level: "high", matchedPaths: high };
  if (paths.every((path) => LOW_CHANGE.some((pattern) => pattern.test(path)))) {
    return { level: "low", matchedPaths: paths.slice() };
  }
  return { level: "medium", matchedPaths: [] };
}

export function assessChangeRisk(
  repositoryCriticality: RiskLevel,
  paths: readonly string[]
): RiskAssessment {
  const change = classifyChangeSensitivity(paths);
  const score = WEIGHT[repositoryCriticality] * WEIGHT[change.level];
  return {
    repositoryCriticality,
    changeSensitivity: change.level,
    score,
    requiresSecurityReview: score >= 8,
    matchedPaths: change.matchedPaths,
  };
}
