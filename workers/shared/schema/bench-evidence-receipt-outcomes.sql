-- Each distinct final/preservation receipt retains its own provider acceptance.
CREATE TABLE IF NOT EXISTS evidence_receipt_history (
 intake_id TEXT NOT NULL,
 outcome_fingerprint TEXT NOT NULL,
 phase TEXT NOT NULL,
 outcome_json TEXT NOT NULL,
 provider_message_id TEXT,
 sent_at TEXT NOT NULL,
 PRIMARY KEY(intake_id,outcome_fingerprint)
);
CREATE INDEX IF NOT EXISTS evidence_receipt_history_sent ON evidence_receipt_history(intake_id,sent_at);
-- Existing receipts did not retain their sent count snapshot. Preserve that
-- uncertainty instead of inventing whether an old receipt was final.
INSERT OR IGNORE INTO evidence_receipt_history(intake_id,outcome_fingerprint,phase,outcome_json,provider_message_id,sent_at)
SELECT intake_id,'legacy_unclassified','legacy_unclassified','{"classification":"legacy_receipt_content_not_recorded"}',provider_message_id,sent_at
FROM evidence_receipt_outbox WHERE state='sent' AND sent_at IS NOT NULL;
