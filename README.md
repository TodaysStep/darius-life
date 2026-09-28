# darius.life

Michael Darius's personal index. Plain static HTML, built by `src/build.mjs`
from `content/manifest.json` and checked by `checks/run-all.mjs`. `npm run
build` runs both; if any check fails, nothing deploys.

**Not live yet.** See `docs/handoff-2026-09-27.md` for exactly what's still
blocking the first successful deploy and who needs to do what. Once it's
live, `npm run verify-live` (also runs daily via
`.github/workflows/verify-live.yml`) checks the real deployed site against
the brief's Section 10 acceptance checks — separate from `npm run build`,
which only checks local build output.

**Brief version 2.1 architecture.** The public page and the private legal
area share one domain, `darius.life`. This repository is public — nothing in
it may ever be secret (see "The private legal area" below) — so it holds no
access-controlled content at all, only the code that serves it:

| | public page | private legal area |
|---|---|---|
| served from | `dist/` (static files, built by `src/build.mjs`) | R2 bucket `darius-life-private`, never this repo |
| served by | GitHub Pages | Cloudflare Worker `workers/private-legal`, at the same domain's `/legal/private/*` route |
| gated by | nothing — public | Cloudflare Access (one-time PIN), independently re-verified by the Worker itself |
| headers | GitHub Pages sends none; the `<meta>` CSP/referrer-policy fallback in the page covers what a `<meta>` tag can | the same Cloudflare Transform Rule that fronts the public page also covers the Worker's responses |

The whole domain sits behind Cloudflare as a proxy (once DNS-only cutover is
confirmed working — see `cloudflare/rules.md`), which is what injects the
security headers GitHub Pages itself cannot send. This is a deliberate,
approved reversal of an earlier design (splitting hosting across
`confidential.darius.life` specifically to avoid any Cloudflare dependency for
the public page) — see `docs/handoff-2026-09-27.md` for why.

## Change your status, or pause/resume a project

**From your phone, no code:** `https://darius.life/control/`, behind the same
Cloudflare Access login as the private legal area. Pick a status, pick Active
or Paused for each project, tap Save. That writes a real commit to `main` —
the same push event as any manual edit — so it goes through the exact same
build, checks, and deploy as any other change, live within a few minutes. See
`cloudflare/rules.md`'s "Control panel" section for how it works and what it
needs (`workers/private-legal/src/control.js`).

**By hand, if you'd rather:**

1. Edit `data/status.json` and set `personal` to one of these lines, exactly:
   - `Heads down.`
   - `In deep work, slow to surface.`
   - `Focused on a build, not available for check-ins.`
   - `Surfacing soon.`
   - `Between projects, more reachable than usual.`
   - `Handling something. Will update when there's something to say.`

   Or edit `data/projects.json` and set a project to `"paused"` or `"active"`.
2. Commit and push. GitHub Actions rebuilds and publishes it.

These two files are the only content that changes without changing a lock
file — both the control panel and a manual edit write only to them.

## Bench Notes — private case management

Split across two Workers on two hostnames, on purpose, because the two sides
have genuinely different trust requirements. Both bind the same D1 database
(`darius-life-bench-notes`); the split is enforced by which query functions
each Worker's own source tree contains, not by a shared permission check.

**`https://confidential.darius.life/bench/`** (`workers/confidential/`) is
Darius's own docket:

- Cases, each with a chronological **timeline** — dated entries along a
  visible spine, every entry carrying four layers at once (fact, recommended
  direction, his commentary, court takeaways) and any documents attached to
  it specifically.
- A **glossary** and **pattern-spotting** on judge/opposing-counsel behavior.
- **Documents**, either attached to one timeline entry or general to the
  case, in one of two forms: a **link** Darius pastes in (`storage_ref` is
  that address, validated as http(s) at write time so a pasted
  `javascript:` reference can never reach the entrusted page's `<a href>`),
  or an actual **upload** (`storage_kind = 'upload'`; `storage_ref` is then
  an internal R2 key, never a URL — each side serves the same bytes through
  its own route: `/bench/documents/:id/file` here, Access-gated;
  `/bench-entrusted/documents/:id/file` on the entrusted side, re-deriving
  the exact same shared/case-scoped list `listSharedDocuments` already
  enforces, not a second query that could drift from it). Both bind the
  same R2 bucket the private legal area already used
  (`darius-life-private`), under a `bench-documents/` prefix.
  **Uploading a document is the default way to start a bench note** — the
  case list's first form: pick a file, optionally add your own notes
  (private, never shared), upload. Nothing else. Bench Notes reads the
  document itself (`workers/shared/bench-document-ai.js`, via Cloudflare
  Workers AI — an account capability, no separate key) to say what the
  document is and find its case number in the text, matching an existing
  case by that number or starting a new one — Darius never types a
  description or picks a case. A fact that came from that read, not from
  Darius, is stored with `docket_entries.source` set to `upload-ai` (or
  `upload-unreadable` if the file had no extractable text, e.g. a scanned
  image — the upload still succeeds, just untagged with a real read) rather
  than the default `manual`, and shown with a visible "auto-extracted" tag
  — never presented as indistinguishable from his own typed fact, which the
  schema's own rule says is never inferred or fabricated. Opening that
  entry's **Edit** panel and saving clears the tag: reviewing and correcting
  it is Darius taking authorship, the same as if he'd typed it himself. The
  longer "add a case" form (title, court, case number) is still there,
  further down, for when there's no document yet.
- **A large file used to crash the upload outright.** The original
  handler read the whole file into the Worker's own memory twice
  (`request.formData()`'s multipart parsing, then `file.arrayBuffer()` for
  text extraction) — Workers have a hard, per-isolate 128&nbsp;MB memory
  ceiling, shared across every in-flight request, and exceeding it kills
  the request outright, not a catchable error. Every upload now goes
  through `PUT /bench/blobs/:id` first (`handleBenchPut`), which streams
  `request.body` straight to R2 and never materializes the file in memory
  at all; the finalize step that follows checks the object's size via
  R2's own `head()` — no bytes fetched — and skips analysis entirely
  (`bench-document-ai.js`'s `MAX_ANALYZABLE_BYTES`, 20&nbsp;MB) rather than
  risk the same ceiling a second time trying to read a huge PDF's text.
  This is also why the upload and document pages now load one small,
  first-party script (`bench-client-script.js`, served same-origin at
  `/bench/static/bench.js`) under an explicit `script-src 'self'` CSP
  override — a browser form alone cannot `PUT` a raw body, and every
  other page in Bench Notes keeps the original `script-src 'none'`.
  **The real ceiling above this fix is Cloudflare's own, not this code's:**
  the account's plan caps the request body Cloudflare's edge will even
  forward to the Worker (100&nbsp;MB Free/Pro, 200&nbsp;MB Business, up to
  5&nbsp;GB Enterprise) — a file over that limit is refused before this
  Worker ever sees it, and raising it needs a plan change or R2 multipart
  upload direct from the browser, neither of which is built here.
- **Any number of dated recordings or notes per document**
  (`document_recordings`), added whenever there's more to say, not fixed
  at upload time — reachable from each document's own page (the "notes &
  recordings" link next to it on the case page). Each one is a typed
  note, a recording, or both — never neither. Recording live uses the
  same script and the same streaming `PUT /bench/blobs/:id`: a `● Record`
  button captures audio via `MediaRecorder`, and on stop, uploads it
  exactly like a chosen file. Working-side only, like commentary — never
  shared, never entrusted-visible.
- **Delete**, at every level, added because there was no way to remove a
  mistake or a test entry at all before this pass: a docket entry (its own
  documents become general instead of disappearing with it), a document
  (and its own recordings — every R2 object either owned deleted along
  with the row, best-effort, so a bucket hiccup never blocks the D1
  delete and leaves an entry Darius can't get rid of), a single
  note/recording, and a whole case. Deleting a case is the one place with
  real friction: the case's own title must be typed back exactly before
  anything happens, since it cascades — every entry, document, and
  recording under it, permanently.
- An **entrusted-access management area** on the case list page: every
  guest's passphrase grant, which cases they're scoped to, how many
  documents and timeline entries are actually shared with them (computed
  live, not just the case count), one-click revoke, and a passphrase-change
  form per grant.
- A **preview** (`/bench/preview/:grantId`) that renders the exact same
  `renderEntrustedView` function the real entrusted login calls — not a
  reimplementation that could drift — with a red banner, no session cookie,
  no passphrase, read-only.

Data lives in Cloudflare D1, never this repo. Gated by a pre-existing
Cloudflare Access application ("confidential legal area," policy "Allowed
readers") that already protected this hostname before Bench Notes existed —
reused exactly as-is, no changes made to it. That application protects the
Worker's entire production/preview URL at the edge (not a specific path), so
`bench-working.js` still independently re-verifies the Access JWT itself
(`workers/shared/access.js`) as defense in depth, same as every other gated
route in this repo, even though Access has already checked once.

**`https://darius.life/bench-entrusted/`** (`workers/private-legal/`) is a
**structurally separate** area for guests Darius manually shares with — a
single universal passphrase per grant (`workers/shared/bench-crypto.js`
hashes it; the plaintext is never stored), revocable at any time from the
working side, scoped to specific cases. No Cloudflare Access gate — guests
have no Access identity, and it *can't* live behind confidential.darius.life's
Access application even if it wanted to, since that application gates the
whole Worker regardless of path. It shows the same timeline-and-documents
structure as the working side, limited to whatever's been explicitly shared:

- `workers/shared/bench-entrusted-view.js` is the entire confidentiality
  boundary for `docket_entries`. Its one query into that table selects
  exactly `id, case_id, case_label, entry_date, fact` — never
  `recommended_direction`, `commentary`, or `court_takeaways` — filtered to
  `shared_at IS NOT NULL AND case_id IN (the grant's own scope)`. Both
  `bench-entrusted.js` (a real guest) and `bench-working.js`'s preview
  (Darius, previewing) call this same module, so there is exactly one
  rendering of "what a guest sees," never two that could disagree.
- `patterns` and `glossary_terms` are never reachable from here at all, not
  even a shared/unshared toggle exists for them.

See `workers/shared/schema/bench-notes.sql` for the full data model and its
confidentiality notes, and `workers/shared/bench-entrusted-view.js`'s own
header for exactly how the boundary is enforced.

**"Shareable, but requiring a login"** — Bench Notes already worked this way
before this pass, and still does: nothing on the entrusted side is a bare
link. Every guest, whether reading shared notes or now opening an uploaded
document's own file route, must have signed in with a passphrase first —
that passphrase login *is* the gate, the same one this section describes
above. This pass read "requiring a login" as confirming that model, not
asking for a second, separate account system (usernames, passwords,
password resets) alongside it — Bench Notes has no such system, and adding
one wasn't requested elsewhere in this repo's history. If a real per-guest
account system was actually intended instead of the existing per-grant
passphrase, that's a materially different, larger build and needs saying
explicitly.

**How the working side's Access application was found, for the record
(2026-09-28):** an earlier pass concluded no Cloudflare Access application
existed at all, because `/accounts/{id}/access/apps` returns zero results
with the API token available here — that token genuinely cannot list or
manage Access applications. That conclusion was wrong: the application
already existed, created via the dashboard, protecting a Worker-scoped
destination rather than a path on `darius.life` itself. It surfaced by
requesting the Worker's custom domain directly and reading the real team
domain and AUD tag straight out of the resulting Access login redirect's own
JWT — `dreamstep.cloudflareaccess.com` and the AUD tag hardcoded in
`workers/confidential/wrangler.toml`, not placeholders. The domain itself
had a typo (`condifential.darius.life`) that was corrected to
`confidential.darius.life` via the Workers Custom Domains API the same day;
the old Custom Domain binding is deleted, though a DNS A record under the
typo may still exist — the token here can't reach `/dns_records` to check
or remove it (needs the zone-level **DNS → Edit** permission added).
`/legal/private/*` and `/control/*` on `darius.life` still use a genuinely
different Access application, whose real values are still unconfirmed — see
`workers/private-legal/wrangler.toml`.

**Publishing from ChatGPT — investigated in full, deliberately not built.**
An earlier pass here concluded no real ChatGPT-facing publishing system
existed at all. That was wrong, and was corrected by reading the actual
`posteritycloud-infra` source directly rather than its surrounding docs: a
real, live "Publishing Desk" exists — `supabase/functions/_shared/publishing-desk/`
(`ops.ts`/`mcp-tools.ts`), shared by a web editor and a ChatGPT connector
named "PosterityOS Operations" over MCP with its own OAuth authorization
server. It is documented in full at `docs/publishing-desk/CURRENT-STATE.md`
and `docs/publishing-desk/OPEN-STANDARD.md` in that repo.

It was not used for Bench Notes, on purpose. That desk's whole model is
*publish one immutable edition, to one public destination, by exact
approval* — it has no concept of a guest, a passphrase, or "show this to one
person and no one else." Retrofitting Bench Notes' guest-grant/share model
into it would either weaken guarantees it already relies on for real,
currently-live Founder's Notes and press-release publishing, or force it to
grow a second access-control system next to the one it has. Bench Notes'
own machine API (`workers/private-legal/src/bench-api.js`, below) is the
right seam instead — but it was built as a broad, single-bearer-token
administrative surface, appropriate for a trusted server, not yet appropriate
to hand to an AI agent that can retry, get injected text as data, or be
asked to summarize what it just read. Connecting it to ChatGPT is on hold
until it has real per-operation scoping, idempotent writes, and an audit
trail — none of which exist yet. Bench Notes' own case/timeline/document
forms above remain, for now, the only way content gets in.

## Status and project lights

Every status and project indicator is a small lit, glowing LED next to plain
text naming the same state — never colour alone. New Work Security Protection
is a permanently-lit green LED with a small CSS-drawn padlock (no image, no
inline SVG — the page allows neither); it has no toggle anywhere, in the UI or
in code. Personal status is a lit green LED beside the current line. Each
project is green for Active, grey for Paused. The two LED colours are the
page's one deliberate exception to its own two-colour budget — check 14
(`checks/run-all.mjs`) allows exactly those two hex values and nothing else.

## Everything else

Every other change to what the page says is a change to `content/` and must be
locked in the same commit:

```
npm install
npm run lock
```

`npm run lock` rebuilds, writes each item's hash into `content/manifest.json`,
and rewrites `manifest.lock` and `terms.lock`. The commit that changes the words
also changes the locks, so every version stays in Git history.

- New link: add its exact URL to `checks/allowlist.json` too, or the build stops.
- New terms text: also set `effective` on the `terms` item in the manifest to the
  date it takes effect. `/verify` shows that date.
- New article (Section 11 of the brief): add a `writing.*` item to the manifest
  after `writing.educators-exile-1` and before `writing.todays-step-archive`, add
  its URL to the allowlist, then `npm run lock`.

### Medium articles

Medium answers every automated request with a Cloudflare challenge, including a
request for a post that does not exist, so a Medium link cannot be checked by
fetching it. The build accepts a Medium link only when the post is listed in
`https://medium.com/feed/@darius`, or when `checks/link-evidence.json` records a
proof for that exact URL. The feed holds the ten newest posts, so a new article
passes on its own; an older one needs a recorded proof.

## Link preview and icons

`og.png`, `apple-touch-icon.png`, `favicon.ico`, and `favicon.svg` are generated
fresh every build by `src/generate-images.mjs` — never hand-drawn, never
fetched, so they can never drift from the page they represent. All four are
the site's own two colours (`#F6F3EE` background, `#111111` text/mark) and its
own font (Courier Prime), decompressed at build time from the `.woff2` files
in `assets/fonts/` since the SVG-to-PNG renderer (`@resvg/resvg-js`) can only
load raw TTF/OTF, not WOFF2. `<title>`, the meta description, Open Graph tags,
Twitter Card tags, the icon `<link>`s, and `<link rel="canonical">` are static
in `src/template.html` — check 20 (`checks/run-all.mjs`) fails the build if
any of them is missing or doesn't match exactly, and if `og.png` or
`apple-touch-icon.png` isn't exactly the required pixel size.
`checks/live.mjs` separately confirms the live page serves the same tags and
that `https://darius.life/og.png` actually returns 200 — a build can't check
that against a URL that doesn't exist yet on a first deploy.

## The private legal area

Documents live only in the R2 bucket `darius-life-private` — never in this
repo, which is public. `workers/private-legal` serves them at
`darius.life/legal/private/*`: it independently verifies the
`Cf-Access-Jwt-Assertion` header (RS256 signature against the Access team's
published JWKS, `exp`/`nbf`, `aud`) before touching R2 at all, rather than
trusting that Cloudflare Access alone already gated the request. It writes an
index page listing the bucket's objects unless one provides its own
`index.html`. Every response sends `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex`. See `workers/private-legal/src/index.test.mjs` for
the 8 tests covering the JWT verification (a real signed token, then seven
ways to break it).

The build refuses to publish the public page if your mailing address or phone
number (the `PROTECTED_STRINGS` secret) appears in any tracked or generated
file. Check 17 (`checks/run-all.mjs`) separately fails the build outright if
any `legal/private/*` path is ever tracked in git or written into `dist/`,
since that content must never leave R2.

## Checks

`npm run build` runs all 20 checks in Section 8 of the brief against the
build output. Locally:

- `LINKCHECK=skip npm run build` skips fetching live links. Both CI providers
  (GitHub Actions and Cloudflare) set `CI`/`CF_PAGES`, which the check
  detects and always fetches every link regardless of `LINKCHECK` — the skip
  only ever applies to a local run.
- Without `PROTECTED_STRINGS` set, check 9 is skipped locally and fails under
  CI.
- `node checks/live.mjs` (`npm run verify-live`) checks the real deployed
  site instead of build output — headers, the private area's access gate,
  the direct-origin check — none of which a local build can verify.

## Hosting

Both the public page and the private legal area are served on `darius.life`
itself, fronted by Cloudflare as a reverse proxy — see `cloudflare/rules.md`
for the exact zone configuration (DNS, the Response Header Transform Rule,
the Access application) and its required ordering (DNS-only until GitHub
issues its certificate, proxied only after).

**Public page — GitHub Pages, via GitHub Actions**
(`.github/workflows/deploy.yml`, job `build` + `deploy-pages`). Repo Settings
→ Pages → Source: **GitHub Actions**. Repo secret `PROTECTED_STRINGS` (your
mailing address and phone number, one per line) is required for check 9 to
pass.

**Private legal area — Cloudflare Worker `darius-life-private-legal`**, via
the same workflow's `deploy-worker` job (`cloudflare/wrangler-action@v4`,
`workingDirectory: workers/private-legal`). Repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are required. Before the
first deploy, create the R2 bucket `darius-life-private` and set
`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` in `workers/private-legal/wrangler.toml`'s
`[vars]` to the real Cloudflare Access team domain and this Access
application's AUD tag — both fail closed (a wrong value returns 403, never
200).

### Domains

- `darius.life` and `www.darius.life`: GitHub Pages custom domain (a `CNAME`
  file, written by the build to `dist/CNAME`) for the public page; the same
  hostname's `/legal/private/*` path routes to the Worker instead, per the
  Worker's own `[[routes]]` block in `workers/private-legal/wrangler.toml`.
  `www` redirects to the apex via a Cloudflare Redirect Rule (`cloudflare/rules.md`)
  now that the domain is proxied, rather than GitHub Pages' own redirect.

The platform's gateway Worker must have no route on `darius.life` or
`*.darius.life`; see
`.lovable/memory/constraints/darius-life-personal-index.md` in
`TodaysStep/posteritycloud-infra`.

### Cloudflare Access

Self-hosted application covering `darius.life/legal/private/*` only — not the
whole domain, since the public page must stay ungated. Policy: allow the
listed emails, one-time PIN; deny everyone else. See `cloudflare/rules.md`.

### What GitHub Pages can't do

No custom HTTP response headers — `Strict-Transport-Security`,
`X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy`, and the
`frame-ancestors`/`form-action`/`base-uri` CSP directives are all header-only
and cannot be replicated in static HTML. `src/template.html` and
`src/verify.html` set what a `<meta>` tag can (`Content-Security-Policy`'s
remaining directives, `Referrer-Policy`) as a fallback that still applies even
if the Transform Rule below were ever misconfigured; `checks/run-all.mjs`
(check 13) checks those meta tags at build time. The real, complete header
set is a zone-level Cloudflare Response Header Transform Rule
(`cloudflare/rules.md`), applying to both the GitHub Pages origin and the
private-legal Worker — `checks/live.mjs` verifies it live, since it can't be
checked from build output. See `docs/github-pages-header-limits.md`.

### Email

The zone's MX, SPF, DKIM and DMARC records carry iCloud mail for
`homecorrespondence@`, `hello@` and `confidential@darius.life`. They are recorded in
`docs/cutover-2026-09-27.md` and must not change.
