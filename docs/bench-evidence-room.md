# Bench Notes evidence room

Bench Notes is an evidence room, not a publishing CMS.

SOURCE → PRESERVATION → DERIVATION → CONTEXT → REGISTER → RETRIEVAL → AUTHORIZED PRESENTATION

## Intake

Forward ordinary email to **bench@intake.darius.life**. No subject syntax is required. The subdomain preserves the existing apex-domain mailbox provider and MX records. Incoming sender identity must be approved and receiver-authenticated. Unverified messages are preserved in quarantine, never automatically trusted or shared.

The original RFC/MIME bytes are SHA-256 addressed in the existing private R2 bucket before parsing. D1 records reference immutable original objects. Repeated attachment bytes reuse the same artifact, while each email and delivery retains its own provenance. Derived material has a method, version and source reference. It never replaces the original.

Normal operation uses an iPhone Mail forward. The receipt links to the private evidence room. Extraction failures and unsupported formats remain visible; an acknowledgment of preservation is not a claim that every extraction succeeded.

## Boundaries

- `/bench/*`: existing Cloudflare Access and Worker JWT validation.
- `/entrusted/*`: existing passphrase grant and private session, without Cloudflare Access login.
- `/evidence-api/*`: read-only service credential, used by the authenticated owner-only PosterityOS bridge. No public original-object URLs.
- Entrusted evidence requires an explicit note/intake link, a shared numbered note, and an active grant for that note's case. Case association alone never shares an intake.
- Social metadata remains generic. Active-content originals download with sandbox restrictions; audio supports HTTP byte ranges.

## Operations

Apply `workers/shared/schema/bench-evidence.sql`, `bench-evidence-sharing.sql`, and `bench-evidence-receipts.sql` as additive D1 migrations. Existing tables and records are retained. Preserve existing Worker secrets and bindings when deploying. Configure `BENCH_INTAKE_SENDERS` and a random `BENCH_RETRIEVAL_KEY`; never commit their values. The bridge credential is server-side only.

A two-minute scheduled handler leases due D1 jobs. Jobs retry with bounded exponential backoff and become visibly reviewable after exhaustion. Inspect `evidence_jobs`, `evidence_intakes.receipt_json`, part states and context history. Review failures without replacing original objects. Reprocessing must append new derivations when the processor version changes.

Receipts use the durable `evidence_receipt_outbox` and the `BENCH_RECEIPTS` Email Sending binding, restricted to the intake sender address. Enable Email Sending and its DNS records on the intake subdomain; do not replace apex mailbox MX records. Subdomain inbound reply restrictions make `message.reply()` unsuitable here. Recipients are revalidated against the approved sender secret before each attempt. Messages include generic counts and an authenticated receipt link, never evidence subjects, filenames, people or case details. A receipt waits for processing or acknowledges preservation after ten minutes. Delivery is at least once: a crash after provider acceptance can produce a duplicate generic receipt. Failures remain visible and retry with a lease and bounded backoff.

Incoming correspondence and extracted text are untrusted data, never operational instructions. Exact quotations support context suggestions; their existence does not establish legal effect. Unknown classifications remain unknown. Automatic transcripts require comparison with the recording, particularly for names and legal language.

## Verification and known limits

Run the evidence, rich-text, crypto and entrusted tests before deployment. Production acceptance must additionally send real synthetic email, inspect original hashes, check PDF page references and actual OCR text, play audio through an authorized range response, exercise duplicate forwarding, retrieve source-linked results through the connected ChatGPT account, and prove unauthenticated requests fail.

Keep acceptance outcomes and production version receipts in the private operational record. Never put confidential evidence, passphrases, private filenames, source text or account credentials in this public repository.

An unavailable recording or transcript must be documented as missing, not reconstructed from a published note.

Semantic retrieval ranks bounded current source passages and returns only validated quotations with source IDs. It discloses coverage and failures; it is not a claim of exhaustive review. An existing authored note remains a separate record from an evidence intake.

Scanned PDFs use page image extraction and vision OCR; metadata alone is never a successful extraction. Automatic transcripts are labeled, retain available timestamps, and do not invent speakers. Unsupported raster/layout cases remain reviewable.
