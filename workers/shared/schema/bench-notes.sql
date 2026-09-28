-- Bench Notes data model — confidential.darius.life/bench/* (working side)
-- and darius.life/bench-entrusted/* (entrusted side).
--
-- Confidentiality is enforced structurally, not by a visibility flag: the
-- entrusted side's code (bench-entrusted.js, and the shared render function
-- it and the working side's preview both call — workers/shared/
-- bench-entrusted-view.js) can only ever reach cases/docket_entries through
-- one narrow, hardcoded query (docket_entries columns id/case_label/
-- entry_date/fact/shared_at only, WHERE shared_at IS NOT NULL AND case_id IN
-- the grant's own scope) — never recommended_direction, commentary, or
-- court_takeaways, never an unshared entry, never a case outside the
-- grant's scope, and never patterns or glossary_terms at all. That query
-- shape is the entire confidentiality boundary; nothing else reaches these
-- tables from that side.

CREATE TABLE IF NOT EXISTS cases (
  id            TEXT PRIMARY KEY,           -- e.g. "family-2026"
  title         TEXT NOT NULL,
  court         TEXT,
  case_number   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | closed | stayed
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The four simultaneous layers live as four columns on one row, not four
-- linked rows — they describe the same dated event from four angles and are
-- always read/written together. recommended_direction, commentary, and
-- court_takeaways are nullable (a fact can be logged before any of the
-- other three exist); fact and case_id/entry_date are not.
CREATE TABLE IF NOT EXISTS docket_entries (
  id                    TEXT PRIMARY KEY,
  case_id               TEXT NOT NULL REFERENCES cases(id),
  case_label            TEXT NOT NULL DEFAULT '',  -- denormalized, same reason as documents.case_label
  entry_date            TEXT NOT NULL,       -- the date the docket event itself happened
  fact                  TEXT NOT NULL,       -- what happened — never inferred, never fabricated;
                                              -- the ONLY column of this table the entrusted side
                                              -- may ever select, and only when shared_at is set
  recommended_direction TEXT,                -- what to consider doing about it — working-side only
  commentary            TEXT,                -- Darius's own read on it — working-side only
  court_takeaways       TEXT,                -- what the court/filing actually said — working-side only
  shared_at             TEXT,                -- null until Darius manually shares this entry —
                                              -- never automatic, same pattern as documents.shared_at
  source                TEXT NOT NULL DEFAULT 'manual',  -- manual | green-filing-ingest
  ingest_item_id        TEXT REFERENCES ingest_items(id),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_docket_entries_case ON docket_entries(case_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_docket_entries_shared ON docket_entries(shared_at);

-- Pattern-spotting on judge/opposing-counsel behavior. subject_type/subject_name
-- identify who the pattern is about; entries_json is a JSON array of
-- docket_entries.id this pattern was noticed across — never fabricated, always
-- traceable back to real dated entries.
CREATE TABLE IF NOT EXISTS patterns (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  subject_type  TEXT NOT NULL,        -- judge | opposing-counsel | other
  subject_name  TEXT NOT NULL,
  description   TEXT NOT NULL,
  entries_json  TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_patterns_case ON patterns(case_id);

CREATE TABLE IF NOT EXISTS glossary_terms (
  id            TEXT PRIMARY KEY,
  case_id       TEXT REFERENCES cases(id),   -- null = applies across every case
  term          TEXT NOT NULL,
  definition    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_glossary_case ON glossary_terms(case_id);

-- Documents-only, entrusted-side. `storage_ref` points at wherever the actual
-- bytes live (the Lovable-built document viewer, or an R2 key) — this table
-- never stores document content itself, only what the entrusted side is
-- allowed to list and open.
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  case_label    TEXT NOT NULL DEFAULT '',  -- case title, denormalized at insert time so
                                            -- bench-entrusted.js can label a document group
                                            -- without ever querying the cases table itself
  entry_id      TEXT REFERENCES docket_entries(id),  -- optional: attaches this document to one
                                                      -- timeline entry instead of just the case
                                                      -- generally. Null is a normal, general case
                                                      -- document, not an error.
  title         TEXT NOT NULL,
  storage_ref   TEXT NOT NULL,
  filed_date    TEXT,
  shared_at     TEXT,                 -- null until Darius manually shares it — never automatic
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_documents_entry ON documents(entry_id);

-- Occasional notes Darius writes directly to the entrusted side — distinct
-- from commentary (working-side, never shared). Also manual, also never
-- auto-populated from the working side.
CREATE TABLE IF NOT EXISTS entrusted_notes (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  case_label    TEXT NOT NULL DEFAULT '',  -- denormalized, same reason as documents.case_label
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_entrusted_notes_case ON entrusted_notes(case_id);

-- The single universal entrusted login. One active row = one valid access
-- code; revoking access means setting revoked_at, not deleting history.
-- code_hash is SHA-256 of the passphrase — the passphrase itself is never
-- stored. case_ids_json scopes which cases' documents/notes this grant can see.
CREATE TABLE IF NOT EXISTS access_grants (
  id            TEXT PRIMARY KEY,
  code_hash     TEXT NOT NULL,
  case_ids_json TEXT NOT NULL DEFAULT '[]',
  label         TEXT,                 -- e.g. "Attorney — family case" for Darius's own reference
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at    TEXT
);

-- Green Filing email ingestion. Every inbound email becomes a row here first,
-- matched status tracked explicitly — unmatched items are flagged, never
-- dropped, and never auto-promoted into a docket_entries row without review.
CREATE TABLE IF NOT EXISTS ingest_items (
  id              TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,
  from_address     TEXT NOT NULL,
  subject         TEXT NOT NULL,
  raw_body        TEXT NOT NULL,
  message_id      TEXT UNIQUE,          -- for dedupe against Green Filing re-sends
  matched_case_id TEXT REFERENCES cases(id),
  status          TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched | matched | reviewed | discarded
  reviewed_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_status ON ingest_items(status);
