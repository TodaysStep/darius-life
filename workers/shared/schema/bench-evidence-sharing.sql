CREATE TABLE IF NOT EXISTS evidence_note_links (
 entry_id TEXT NOT NULL REFERENCES docket_entries(id),
 intake_id TEXT NOT NULL REFERENCES evidence_intakes(id),
 shared_at TEXT,
 PRIMARY KEY(entry_id,intake_id)
);
