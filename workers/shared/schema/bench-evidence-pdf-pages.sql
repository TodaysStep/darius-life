-- Durable page-level extraction; original PDFs remain in immutable artifact storage.
CREATE TABLE IF NOT EXISTS evidence_pdf_pages (
 artifact_id TEXT NOT NULL,
 page_number INTEGER NOT NULL,
 processor_version TEXT NOT NULL,
 state TEXT NOT NULL,
 text_content TEXT NOT NULL DEFAULT '',
 method TEXT,
 error_code TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_until TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(artifact_id,page_number,processor_version)
);
