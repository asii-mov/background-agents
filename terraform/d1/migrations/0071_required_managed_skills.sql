-- Required managed skills are selected independently of a user's optional
-- profile and fail sandbox startup when repository content would shadow them.

ALTER TABLE skills
  ADD COLUMN required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1));

ALTER TABLE session_skill_revisions
  ADD COLUMN required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1));
