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
  -- bench-case-summary.js's own synthesis of everything on record for this
  -- case (entries, documents, notes, patterns, glossary) — regenerated in
  -- the background after any write that changes the record, never by
  -- Darius's own hand. Null until the first entry or document exists.
  -- Never legal advice, never a prediction — see that module's own prompt
  -- for the exact boundary, and the UI's own label for how it's shown.
  ai_summary            TEXT,
  ai_summary_updated_at TEXT,
  -- Darius's own reference notes for this case's court — its local rules,
  -- filing requirements, what a clerk or self-help center told him. Plain
  -- text he writes or pastes in himself, never AI-generated (unlike
  -- ai_summary above): a wrong guess at procedure is exactly the kind of
  -- mistake that matters pro per, so this stays entirely his own words,
  -- sourced from his own court.
  local_rules_notes TEXT,
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
  -- note (default, a chronological fact) | hearing | deadline — drives the
  -- "Upcoming" banner on the case list and case page (bench-working.js): any
  -- hearing/deadline entry whose entry_date hasn't passed yet, soonest
  -- first. Never inferred: Darius (or an edit of an auto-extracted entry)
  -- picks this explicitly, the same way source below is never guessed.
  entry_kind            TEXT NOT NULL DEFAULT 'note',
  source                TEXT NOT NULL DEFAULT 'manual',  -- manual | green-filing-ingest |
                                                          -- upload-ai | upload-unreadable |
                                                          -- upload-ai-failed | upload-too-large-to-analyze
                                                          -- (the upload-* values are bench-document-ai.js's
                                                          -- own read of an uploaded file, not Darius's own
                                                          -- typed fact — the UI tags these visibly)
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
  -- 'link': storage_ref is an external address Darius pasted in, validated as
  -- http(s) at write time (bench-data.js). 'upload': storage_ref is an
  -- internal R2 object key, never a URL — each side (working, entrusted)
  -- builds its own serving address from the document's id, because the two
  -- sides serve the same bytes through different, differently-gated routes.
  storage_kind  TEXT NOT NULL DEFAULT 'link',
  storage_ref   TEXT NOT NULL,
  filed_date    TEXT,
  shared_at     TEXT,                 -- null until Darius manually shares it — never automatic
  -- The paper-filing lifecycle this document is actually in, tracked
  -- explicitly rather than inferred from filed_date alone (a document can
  -- be drafted with no filed_date yet, or filed but not yet served).
  -- drafted (default) | filed | served. filed_date is the filing date;
  -- served_at/served_method/served_on/proof_of_service_ref describe
  -- service specifically — see bench-working.js's markDocumentServed.
  -- Never legal guidance about what must be filed or served, or when —
  -- only a record of what Darius has already done.
  filing_status TEXT NOT NULL DEFAULT 'drafted',
  served_at     TEXT,
  served_method TEXT,                 -- mail | personal | sheriff | other
  served_on     TEXT,                 -- free text: who was served
  -- Same storage convention as storage_ref/storage_kind above: an R2 key
  -- if uploaded (bench-data.js's benchBlobKey), never a URL. The proof
  -- itself — a signed certificate, a mail receipt, a sheriff's return —
  -- attached to the service record it belongs to, not filed as a second,
  -- disconnected document.
  proof_of_service_ref       TEXT,
  proof_of_service_mime_type TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_documents_entry ON documents(entry_id);

-- Any number of dated recordings and/or typed notes about one document —
-- Darius adding his thinking about it as it develops, not one note fixed at
-- upload time. Working-side only; never shared, never entrusted-visible,
-- same as commentary. body and audio_storage_ref are each independently
-- optional (a text-only note, or audio with no separate note), though the
-- write path never allows both to be empty.
CREATE TABLE IF NOT EXISTS document_recordings (
  id                      TEXT PRIMARY KEY,
  document_id             TEXT NOT NULL REFERENCES documents(id),
  case_id                 TEXT NOT NULL REFERENCES cases(id),  -- denormalized, same reason as documents.case_label
  noted_at                TEXT NOT NULL,   -- the date this note/recording is ABOUT, not just created_at
  body                    TEXT,
  audio_storage_ref       TEXT,            -- an R2 key (bench-data.js's benchBlobKey), never a URL
  audio_mime_type         TEXT,
  audio_duration_seconds  INTEGER,
  -- bench-transcribe.js's own read of audio_storage_ref, via Cloudflare
  -- Workers AI's Whisper model, regenerated in the background after each
  -- upload/recording — see bench-working.js's transcribeRecordingInBackground.
  -- Darius's own spoken words, mechanically converted, but speech
  -- recognition still makes mistakes, so it stays a distinct, correctable
  -- layer: transcript_source is "auto" until he edits it, then "manual" —
  -- same pattern as docket_entries.source for an auto-extracted fact.
  -- Null until transcription runs or if there's no audio to transcribe.
  transcript              TEXT,
  transcript_error        TEXT,
  transcript_source       TEXT,
  -- What kind of input this actually is, chosen explicitly by Darius (a
  -- select field, right alongside the note/audio itself) — never inferred
  -- from the text or transcript. note (the default, a plain observation) |
  -- correction (fixing something already on record) | contradiction
  -- (flagging that this conflicts with something he said before) | update
  -- (new development). Drives search/filtering (bench-data.js's
  -- searchAll) and shows as a visible tag, same as docket_entries.
  -- entry_kind for hearings/deadlines — a different axis (this is about
  -- the input's own nature, not timing).
  content_type            TEXT NOT NULL DEFAULT 'note',
  -- What this recording is about/corrects, if anything specific — an
  -- optional pointer to one existing docket entry, same "attach to an
  -- entry" convention documents.entry_id already uses. Most useful with
  -- content_type = "correction" or "contradiction", but never required.
  related_entry_id        TEXT REFERENCES docket_entries(id),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_document_recordings_document ON document_recordings(document_id, noted_at);

-- A voice note's primary home is document_recordings.document_id (where
-- it's added from, and where it's shown by default) — this table is only
-- for the *additional* documents one recording also affects, since "an
-- update that affects multiple documents differently" doesn't fit a
-- single foreign key. Each document a recording affects is meant to show
-- that recording cross-referenced on its own page too (see
-- bench-data.js's listDocumentAffectingRecordings), while the recording
-- itself still lives under its one primary document.
CREATE TABLE IF NOT EXISTS recording_documents (
  recording_id TEXT NOT NULL REFERENCES document_recordings(id),
  document_id  TEXT NOT NULL REFERENCES documents(id),
  PRIMARY KEY (recording_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_recording_documents_document ON recording_documents(document_id);

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

-- Not case-scoped, not AI-generated, not maintained by anyone but Darius —
-- a plain list he curates himself (a courthouse self-help center, legal
-- aid, an advocacy hotline), reachable from /bench/resources on the case
-- list page. Seeded with exactly one entry: the National Domestic Violence
-- Hotline (1-800-799-7233 / thehotline.org), verified directly (web
-- search, 2026) rather than assumed, since a wrong number in a DV safety
-- context is a real harm — everything else here is his own to add.
CREATE TABLE IF NOT EXISTS resources (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  url        TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

-- Prep sessions: rehearsal for an upcoming hearing OR a design
-- presentation/meeting — one shared area, two event kinds (Darius is a
-- self-represented litigant AND a presentation designer; the system tells
-- the two apart explicitly, never by guessing from wording). kind =
-- 'hearing' | 'presentation'. A hearing-kind session may link to a case
-- (case_id), which is how its pressure-test can draw on that case's own
-- flagged patterns (see patterns table); a presentation-kind session
-- never has a case_id — it stands alone, described entirely by context.
-- pressure_test is bench-prep.js's own output: a list of anticipated hard
-- questions/challenges to rehearse answering, grounded only in what's on
-- record (flagged patterns/prior contradictions for a hearing, or the
-- audience/stakes Darius describes in context for a presentation) — never
-- advice on what to say, never a prediction of the outcome. Regenerated
-- only on Darius's own "Generate pressure test" action (synchronous, not
-- background), so pressure_test_updated_at always reflects a deliberate
-- request, never a silent auto-refresh.
CREATE TABLE IF NOT EXISTS prep_sessions (
  id                       TEXT PRIMARY KEY,
  kind                     TEXT NOT NULL,        -- hearing | presentation
  title                    TEXT NOT NULL,
  case_id                  TEXT REFERENCES cases(id),  -- hearing-kind only; null for presentation-kind
  event_date               TEXT,
  context                  TEXT,                 -- Darius's own description: what this is, who's involved,
                                                   -- what's at stake — the only input a presentation-kind
                                                   -- pressure-test has to work from
  pressure_test            TEXT,
  pressure_test_updated_at TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_prep_sessions_kind ON prep_sessions(kind, event_date);
CREATE INDEX IF NOT EXISTS idx_prep_sessions_case ON prep_sessions(case_id);

-- A curated, closed set of verses, built up front rather than left to the
-- model — see daily_verses below for how it's used. This table is the
-- entire anti-hallucination boundary for scripture in this app:
-- bench-verse.js is only ever handed rows from THIS table, it returns an
-- id (never its own transcription of a verse), and that id is always
-- re-checked against this table before anything is shown — the AI never
-- gets the chance to misquote or invent a citation because it never
-- produces the text at all, only a choice among rows already in it.
--
-- Seeded with 14 starting verses (World English Bible — public domain,
-- modern English), fetched directly from ebible.org's own WEB text rather
-- than assumed, same "checked directly, not assumed" rule as the one
-- seeded resources entry above. These are a starting point for Darius's
-- own review, not a finished or authoritative set — exactly the
-- distinction the Scripture library page states to him directly; he's
-- free to delete any of them and add his own.
CREATE TABLE IF NOT EXISTS scripture_verses (
  id          TEXT PRIMARY KEY,
  reference   TEXT NOT NULL,       -- e.g. "Philippians 4:6-7"
  translation TEXT NOT NULL,       -- e.g. "WEB" — stated explicitly, never left implicit
  text        TEXT NOT NULL,       -- exact wording Darius approved; always read from here, never from AI output
  tags        TEXT NOT NULL DEFAULT '',  -- free-text, comma-separated (e.g. "anxiety,courage,waiting") —
                                          -- Darius's own words for what a verse speaks to, used to help
                                          -- bench-verse.js match it to a day's agenda; never AI-assigned
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per calendar date already picked — a cache, not a log: the
-- daily verse is lazy-computed synchronously on the first home-page load
-- of a new day (see bench-working.js), then reused for the rest of that
-- day rather than recomputed on every visit. verse_id is always one of
-- scripture_verses.id (bench-verse.js validates this itself before
-- writing the row); rationale is the AI's own stated reason for the
-- match, shown alongside the verse so Darius can see why it was picked,
-- never as a substitute for the verse's own text.
CREATE TABLE IF NOT EXISTS daily_verses (
  date       TEXT PRIMARY KEY,     -- YYYY-MM-DD
  verse_id   TEXT NOT NULL REFERENCES scripture_verses(id),
  rationale  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
