-- Additive evidence intake; originals never updated. Sharing remains explicit.
CREATE TABLE IF NOT EXISTS evidence_artifacts (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE,
 byte_size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_intakes (
 id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL UNIQUE, original_artifact_id TEXT NOT NULL,
 state TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 envelope_from TEXT, envelope_to TEXT, subject TEXT, message_id TEXT, sent_at TEXT,
 metadata_json TEXT, body_text TEXT, body_html TEXT, error_code TEXT,
 receipt_json TEXT, case_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS evidence_deliveries (
 id TEXT PRIMARY KEY, intake_id TEXT NOT NULL, received_at TEXT NOT NULL,
 envelope_from TEXT, envelope_to TEXT, message_id TEXT
);
CREATE TABLE IF NOT EXISTS evidence_parts (
 id TEXT PRIMARY KEY, intake_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
 part_index INTEGER NOT NULL, filename TEXT, mime_type TEXT NOT NULL,
 role TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, parent_part_id TEXT, mime_path TEXT,
 UNIQUE(intake_id,part_index)
);
CREATE TABLE IF NOT EXISTS evidence_derivations (
 id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, kind TEXT NOT NULL,
 method TEXT NOT NULL, version TEXT NOT NULL, created_at TEXT NOT NULL,
 text_content TEXT NOT NULL, provenance_json TEXT NOT NULL,
 UNIQUE(artifact_id,kind,method,version)
);
CREATE TABLE IF NOT EXISTS evidence_jobs (
 id TEXT PRIMARY KEY, intake_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
 lease_until TEXT, error_code TEXT
);
CREATE INDEX IF NOT EXISTS evidence_jobs_due ON evidence_jobs(state,available_at);
CREATE INDEX IF NOT EXISTS evidence_parts_intake ON evidence_parts(intake_id);
CREATE INDEX IF NOT EXISTS evidence_derivations_artifact ON evidence_derivations(artifact_id);
CREATE INDEX IF NOT EXISTS evidence_deliveries_intake ON evidence_deliveries(intake_id);
CREATE INDEX IF NOT EXISTS evidence_intakes_received ON evidence_intakes(received_at);
CREATE TABLE IF NOT EXISTS evidence_context (
 intake_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, method TEXT NOT NULL,
 version TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_context_history (
 id TEXT PRIMARY KEY,intake_id TEXT NOT NULL,context_json TEXT NOT NULL,method TEXT NOT NULL,
 version TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL
);
