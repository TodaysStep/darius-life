-- Durable, owner-only receipt outbox. No evidence content is copied here.
CREATE TABLE IF NOT EXISTS evidence_receipt_outbox (
 intake_id TEXT PRIMARY KEY,
 state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at TEXT NOT NULL,
 lease_until TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 sent_at TEXT,
 provider_message_id TEXT,
 error_code TEXT
);
CREATE INDEX IF NOT EXISTS evidence_receipt_outbox_due ON evidence_receipt_outbox(state,available_at);
