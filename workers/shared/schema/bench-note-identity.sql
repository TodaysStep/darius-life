-- Stable note identity is independent of content sharing.
-- Idempotent; existing numbers and shared_at values are preserved.
CREATE TABLE IF NOT EXISTS bench_note_number_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_number INTEGER NOT NULL
);
INSERT OR IGNORE INTO bench_note_number_counter(id,last_number)
SELECT 1, COALESCE(MAX(share_number),0) FROM docket_entries;
UPDATE bench_note_number_counter SET last_number = MAX(last_number, (SELECT COALESCE(MAX(share_number),0) FROM docket_entries)) WHERE id=1;
WITH pending AS MATERIALIZED (
 SELECT id, ROW_NUMBER() OVER (ORDER BY created_at,id) AS ordinal
 FROM docket_entries WHERE share_number IS NULL
), floor AS MATERIALIZED (SELECT last_number FROM bench_note_number_counter WHERE id=1)
UPDATE docket_entries SET share_number = (SELECT floor.last_number + pending.ordinal FROM pending,floor WHERE pending.id=docket_entries.id)
WHERE share_number IS NULL;
UPDATE bench_note_number_counter SET last_number = MAX(last_number, (SELECT COALESCE(MAX(share_number),0) FROM docket_entries)) WHERE id=1;
CREATE TRIGGER IF NOT EXISTS bench_note_assign_private_number
AFTER INSERT ON docket_entries WHEN NEW.share_number IS NULL
BEGIN
 UPDATE bench_note_number_counter SET last_number = MAX(last_number,(SELECT COALESCE(MAX(share_number),0) FROM docket_entries)) + 1 WHERE id=1;
 UPDATE docket_entries SET share_number = (SELECT last_number FROM bench_note_number_counter WHERE id=1) WHERE id=NEW.id;
END;
