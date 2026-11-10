-- Run against the control-plane D1 database after deploy, for example:
--   wrangler d1 execute <database> --remote --file docs/plans/governed-apps/bot-verified-users.sql
-- Read-only. Users whose email is marked verified but that no GitHub or Google sign-in proved:
-- before U12, Slack/Linear attestation (and migration 0057's one-time backlog verify) set
-- email_verified = 1 without mailbox proof. Review each row; nothing here changes data.
SELECT
  u.id,
  u.email,
  u.display_name,
  datetime(u.created_at / 1000, 'unixepoch') AS created_at_utc,
  (SELECT group_concat(provider, ',') FROM (
     SELECT DISTINCT provider FROM user_identities WHERE user_id = u.id ORDER BY provider)
  ) AS providers,
  u.platform_role
FROM users u
WHERE u.email_verified = 1
  AND u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_identities w
    WHERE w.user_id = u.id
      AND w.provider IN ('github', 'google')
      AND lower(trim(w.provider_email)) = lower(trim(u.email))
  )
ORDER BY u.created_at;
