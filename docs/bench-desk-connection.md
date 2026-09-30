# Bench Notes / Publishing Desk private connection

Prepared 2026-09-30. Not a live activation receipt.

Bench Notes has one owner: Michael Darius. Other founders, Access readers,
guests and stewards cannot manage or share this docket. A future platform
for others' own dockets requires separate authorization and design.

## Experience and boundary

The scoped machine seam at https://darius.life/bench/api/v2/ prepares an
immutable note: subject, what changed, full plain text, server-bound sender,
case, date and exact guest grant IDs. Preparing never shares. Sharing
requires exact subject, digest, audience and the owner's actual approval.
Guests see their notes first as dated letters at
https://confidential.darius.life/entrusted/. Access requires BOTH a named
grant and its current case scope. Revocation blocks existing sessions.
Withdrawal removes availability while retaining the original and audit.
The owner's preview uses the identical scoped query and renderer.

Existing shared entries/documents/notes retain their guest semantics.
The legacy machine key retains read access but writes return 410, closing
the unscoped alternate write door. The supplied handoff reports no caller;
source inspection cannot prove all external callers.

No email, SMS, invitation, push, read tracking or compelled response is
implemented. A share receipt means made available to named readers, never
delivered, read, filed, issued or served.

## Secure configuration

Store these through provider secret stores, never chat or committed source.

GitHub Actions secrets in this repo:
BENCH_OWNER_EMAIL (actual owner Cloudflare Access email),
BENCH_DESK_OWNER_ID (exact owner Supabase user ID),
BENCH_DESK_PRINCIPALS (JSON configuration below).
Existing Cloudflare deployment credentials stay in Actions.

Supabase secrets for BOTH founder-api and publishing-desk:
BENCH_DESK_OWNER_ID, BENCH_DESK_READ_TOKEN, BENCH_DESK_PREPARE_TOKEN,
BENCH_DESK_SHARE_TOKEN. Never install the legacy BENCH_API_KEY in the desk.

Generate three independent high-entropy tokens. The Worker receives only
their SHA-256 hashes in BENCH_DESK_PRINCIPALS, a JSON array. Each object has:

| Field | Value |
| --- | --- |
| id | Distinct stable principal ID |
| actor_id | Exact BENCH_DESK_OWNER_ID |
| sender_name | Michael Darius |
| token_sha256 | SHA-256 hex of the corresponding secret |
| scopes | Explicit operation list below |
| case_ids | Explicit existing case IDs, no wildcard |
| expires_at | Explicit future ISO timestamp |
| revoked_at | Null while active; set to revoke |

Read: cases.read, updates.read.
Prepare: cases.read, updates.prepare.
Share: updates.share, updates.withdraw.
The x-bench-actor header must match the credential AND configured owner.
The working docket independently verifies its Access JWT AND owner email.

The deployment workflow refuses missing owner/configuration secrets before
changing production. It applies the additive, repeatable
workers/shared/schema/bench-desk.sql before deploying either Worker.
New tables only; original records are not rewritten.
Worker contract tests run with Node 24; the public build keeps Node 20.

## Retry and activation

Successful reads are audited without bodies. Each write atomically commits
mutation, retry result and audit in one D1 batch. Different content with an
existing operation ID returns 409. Retry an uncertain call identically with
its original operation ID. Prepared notes cannot be edited; a correction
creates a new note. Releases retain their original approval and dates.

1. Securely provision owner identity, scoped case IDs and credentials.
2. Merge/deploy the Worker change; migration precedes either Worker.
3. Deploy the matching founder-api and publishing-desk changes.
4. Refresh the existing connector. Three Bench Notes tools appear only
   when all four desk configuration secrets are present.
5. Verify authenticated case/audience reads. Use an isolated, explicitly
   authorized test case/grant for privacy and retry acceptance.
6. Show the complete real note and intended audience; obtain exact approval
   before sharing. Verify owner preview and authorized guest view.

Local checks: 206 Worker tests and 5 adapter tests passed on Node 24.19.0.
They cover ownership, scoped credentials, real SQLite rollback, repeats,
guest case/grant isolation, HTML escaping and withdrawal.
The read-only readiness workflow uses the existing GitHub deployment
credentials to inspect only the two Workers' binding names and the expected
D1 database metadata. It prints configured/missing flags, never keys,
binding values, or case content. Metadata access is not production acceptance.

Sharing is also checked inside its atomic transaction: concurrent reader
revocation, case-scope or label changes, and withdrawal refuse the new share
without committing a release, retry receipt or audit. Owner withdrawal
remains available after original reader access changes, with exact approval
still bound to the original note and audience.

No full public-site build, live deployment or rendered-browser verification
is claimed. A Chromium executable was unavailable for local visual QA.
