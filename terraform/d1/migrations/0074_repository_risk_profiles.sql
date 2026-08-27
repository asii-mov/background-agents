-- Simple repository-criticality half of the risk matrix. Change sensitivity is
-- derived from the current session diff at pull-request time.

CREATE TABLE repository_risk_profiles (
  repository_key TEXT PRIMARY KEY,
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  criticality     TEXT NOT NULL CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
  rationale       TEXT,
  updated_by      TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);
