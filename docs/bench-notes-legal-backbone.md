# Bench Notes — Legal & Evidence Backbone

Status: operational governance for a private evidence room; not a court docket and not legal advice.

## Three-layer rule
Every court-facing answer must keep these layers visibly separate:
1. MY RECORD — what Bench Notes actually preserves and what a source actually says.
2. COURT INFORMATION — current authoritative rules/forms/instructions from the court or Judicial Council.
3. ANALYSIS & PREPARATION — explanations, comparisons, possible issues, questions, and preparation. Inference is labeled; unknown stays unknown.

## Evidence identity
Every source receives an immutable source identity: original bytes/text, SHA-256, acquisition channel, acquisition timestamp, source metadata, and stable private reference. Derived text, OCR, transcript, summaries, case links, classifications, and AI context are separate records with their own state/version. A correction appends or supersedes derived context; it never rewrites the source.

## Procedural-state vocabulary
Never collapse these states: received; preserved; extracted; indexed; identified; reported; alleged; transmitted; served; proof of service filed; filed; accepted; rejected; lodged; issued; signed; ordered; effective; superseded. A source may assert a state without Bench Notes independently establishing it.

## Court-docket boundary
Bench Notes is an evidence register, not the authoritative court docket. A document in Bench Notes does not become court-filed because it was received, emailed, uploaded, extracted, or associated with a case. Court status must be supported by an authoritative court record or clearly attributed source.

## Provenance chain
SOURCE → PRESERVATION → DERIVATION → CONTEXT → REGISTER → RETRIEVAL → AUTHORIZED PRESENTATION.

Required retrieval fields where available: stable source ID; original hash; source class; received/acquired time; sender/origin; filename/MIME; extraction state; derivation provenance; case relationships with basis/confidence; correction/history; duplicate-delivery relationship; original-return path.

## Evidence preparation backbone
California Courts Self-Help instructs people preparing for restraining-order hearings to gather evidence such as pictures, texts, and emails; bring court papers and copies of evidence; and check with local Self-Help regarding recordings because a transcript may be required. Bench Notes therefore maintains export/readiness metadata without claiming that preservation alone makes material admissible or filed.

For recordings, preserve the original media, preserve/generate a transcript as a derivative, link transcript ↔ original, record transcript method/version, and keep an easy path to both. Never replace the recording with the transcript.

## Remote proceedings
California Rule of Court 3.672 governs covered civil remote proceedings and distinguishes evidentiary hearings/trials. Notice and local procedures matter. Bench Notes may track RA-010/RA-015 and related source records but must not infer that an appearance is authorized merely because a notice was received or preserved.

California Rules 5.496 and 3.1162 contain specific consequences for certain restraining orders when a restrained/responding person appears remotely and receives actual notice of an order after hearing. Bench Notes must never generalize those rules beyond their stated scope; surface the exact rule and case type when relevant.

## Authoritative sources
- California Courts Self-Help: https://selfhelp.courts.ca.gov/
- California Rules of Court: https://courts.ca.gov/cms/rules/index
- San Diego Superior Court: https://sdcourt.ca.gov/

Authoritative court information is retrieved fresh when procedure, deadlines, forms, filing, service, remote appearance, or current local practice matters. Cached guidance is labeled with retrieval date and never silently treated as current law.

## Universal-access behavior
The person may speak naturally. No requirement to know form numbers, database fields, evidence terminology, or case taxonomy. “I’m reporting something” establishes preservation intent. Preserve first, return a short receipt, then contextualize. If placement is uncertain, preserve as unresolved rather than forcing a classification.

Accessibility is part of evidence integrity: preserve voice, offer readable transcripts, plain-language explanations, short receipts, explicit uncertainty, and return paths to originals. Phone-only use must not require desktop administration.

## Court-preparation views
Bench Notes should be able to produce, without changing source records: chronology; evidence-by-claim; source/conflict matrix; missing-evidence list; filing/service-status matrix; exhibit-preparation set; recording/transcript pairs; questions for Self-Help; hearing preparation notes. Each view is derivative and identifies its source records.

## Constitutional checks
Evidence Steward — originals immutable and provenance complete.
Legal-State Steward — no procedural-state collapse.
Security Steward — least privilege and private by default.
Accessibility Steward — Voice/iPhone/plain-language journey works.
Operations Steward — processing failures visible; preservation survives them.
Experience Steward — one action for preservation, no repeated classification questions.
Infrastructure Steward — Cloudflare D1/R2 remains system of record; interfaces are replaceable.

## Current authoritative references checked 2026-10-05
- California Rule of Court 3.672, Remote proceedings.
- California Rule of Court 5.496, Service requirement for proposed restrained persons who appear remotely.
- California Rule of Court 3.1162, Service requirement for respondents who appear remotely.
- California Courts Self-Help, Domestic Violence: Prepare for your restraining order court date.
- California Courts Self-Help, Elder/Dependent Adult Abuse forms and courtroom preparation.
- San Diego Superior Court, Family & Children Forms, including current DV respondent/applicant packets.
