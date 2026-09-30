-- Additive migration. Apply before deploying either Bench Notes Worker.
-- Originals and existing guest grants are unchanged. No row is publicly readable.
CREATE TABLE IF NOT EXISTS bench_desk_updates (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  case_label TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  body TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_desk_releases (
  update_id TEXT PRIMARY KEY REFERENCES bench_desk_updates(id),
  actor_id TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  approval_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_desk_withdrawals (
  update_id TEXT PRIMARY KEY REFERENCES bench_desk_updates(id),
  actor_id TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_desk_operations (
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, operation_id)
);
CREATE TABLE IF NOT EXISTS bench_desk_audit (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  request_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bench_desk_updates_case ON bench_desk_updates(case_id, created_at);
-- A prepared edition and its audience never change. A correction is a new note.
CREATE TRIGGER IF NOT EXISTS bench_desk_updates_immutable
BEFORE UPDATE ON bench_desk_updates BEGIN SELECT RAISE(ABORT, 'immutable_update'); END;
