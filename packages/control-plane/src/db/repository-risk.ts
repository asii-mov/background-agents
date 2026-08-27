import type { RiskLevel } from "../risk/change-risk";
import type { SqlDatabase } from "./sql-database";

export interface RepositoryRiskProfile {
  repoOwner: string;
  repoName: string;
  criticality: RiskLevel;
  rationale: string | null;
  updatedBy: string;
  updatedAt: number;
}

function repositoryKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

interface Row {
  repo_owner: string;
  repo_name: string;
  criticality: RiskLevel;
  rationale: string | null;
  updated_by: string;
  updated_at: number;
}

function toProfile(row: Row): RepositoryRiskProfile {
  return {
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    criticality: row.criticality,
    rationale: row.rationale,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export class RepositoryRiskStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<RepositoryRiskProfile[]> {
    const result = await this.db
      .prepare("SELECT * FROM repository_risk_profiles ORDER BY repo_owner, repo_name")
      .all<Row>();
    return (result.results ?? []).map(toProfile);
  }

  async get(owner: string, name: string): Promise<RepositoryRiskProfile | null> {
    const row = await this.db
      .prepare("SELECT * FROM repository_risk_profiles WHERE repository_key = ?")
      .bind(repositoryKey(owner, name))
      .first<Row>();
    return row ? toProfile(row) : null;
  }

  async getCriticality(owner: string, name: string): Promise<RiskLevel> {
    return (await this.get(owner, name))?.criticality ?? "medium";
  }

  async upsert(input: {
    repoOwner: string;
    repoName: string;
    criticality: RiskLevel;
    rationale: string | null;
    actorUserId: string;
  }): Promise<RepositoryRiskProfile> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO repository_risk_profiles
         (repository_key, repo_owner, repo_name, criticality, rationale, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_key) DO UPDATE SET
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name,
           criticality = excluded.criticality,
           rationale = excluded.rationale,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .bind(
        repositoryKey(input.repoOwner, input.repoName),
        input.repoOwner,
        input.repoName,
        input.criticality,
        input.rationale,
        input.actorUserId,
        now
      )
      .run();
    const profile = await this.get(input.repoOwner, input.repoName);
    if (!profile) {
      throw new Error(
        `Repository risk profile ${input.repoOwner}/${input.repoName} is missing after upsert`
      );
    }
    return profile;
  }
}
