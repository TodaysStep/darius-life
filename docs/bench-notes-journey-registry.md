# Bench Notes — Journey Registry

## Constitutional role
Bench Notes is the durable private evidence room. Cloudflare D1/R2 is the system of record. ChatGPT, Skills, plugins, and PosterityOS are interfaces and governed consumers; none may silently replace source evidence or become required for preservation.

Evidence model: SOURCE → PRESERVATION → DERIVATION → CONTEXT → REGISTER → RETRIEVAL → AUTHORIZED PRESENTATION.

Legal-state rule: received ≠ served ≠ filed ≠ accepted ≠ issued ≠ signed ≠ ordered. Source assertions remain source assertions.

## J1 — Voice report
Trigger: “I’m reporting something” or equivalent preservation intent in Chat/Work/Voice.

Journey: speak → preserve report immediately → durable receipt → determine whether new Bench Note/supporting record/unresolved intake → relate → process asynchronously → make retrievable.

Performance: no semantic search, PosterityOS call, OCR, transcription, classification, or cross-record reasoning may delay the preservation receipt.

## J2 — ChatGPT file evidence
Trigger: attached evidence/document with preservation intent.

Journey: ChatGPT temporary file → ingest_evidence → hash → R2 original → D1 intake/register → stable bench:// reference → asynchronous extraction/contextualization.

Original bytes and hash are immutable. Classification is metadata and remains correctable. Duplicate bytes may share storage while preserving each intake event.

## J3 — Retrieval
Trigger: ordinary-language question in a new conversation.

Journey: exact/structured retrieval first → optional semantic rerank → provenance → source return path. Case-number and recency queries must not depend on a bounded semantic candidate set.

## J4 — PosterityOS
PosterityOS consumes Bench Notes through a thin authenticated bridge. It is never in the hot path for J1/J2/J3 and does not duplicate originals. Bridge responses are views; Bench Notes remains authoritative.

Failure rule: PosterityOS unavailable → preservation/retrieval still works. ChatGPT unavailable → evidence remains available in Bench Notes. Index/AI unavailable → preserved originals remain intact.

## J5 — Help for self-representation
Keep three layers visibly distinct: MY RECORD / COURT INFORMATION / ANALYSIS & PREPARATION. Court procedure/law must come from current authoritative court sources. Analysis must identify inference, conflicts, missing evidence, and unknowns rather than converting them into facts.

## Operational states
Received → Preserved → Processing → Indexed → Contextualized → Available → Needs Attention. Preservation success must be visible before expensive processing.

## Acceptance tests
1. Voice report creates a durable record and receipt without waiting for PosterityOS.
2. Fresh ChatGPT thread can preserve an attached file into R2/D1 and return its stable Bench Notes reference.
3. Search “court service paperwork” finds the preserved process-server correspondence.
4. Exact searches for 26FDV03796S, 26FDV03804S, and 26CU051584S return supported records even if case_ids_json has not been normalized.
5. “What just came into Bench Notes?” returns the true newest intake.
6. Retrieval returns provenance and a path to the original.
7. PosterityOS can consume the same records without copying originals or constraining direct retrieval.
8. Existing Entrusted passphrase-only access and Bench Notes intake continue to work unchanged.

## Steward gates
Evidence Steward: source immutability and provenance.
Security Steward: private, least-privilege, read-only consumption by default.
Experience Steward: iPhone/Voice flow requires no database or filing vocabulary.
Operations Steward: failure states are visible and recoverable.
Legal-state Steward: procedural states are never collapsed.
Infrastructure Steward: Cloudflare/GitHub remain sufficient; no paid OpenAI hosting is required.

Mission is not constitutionally complete until production evidence passes the acceptance tests, including a fresh-conversation ChatGPT retrieval test.