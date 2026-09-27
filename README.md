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

## Change your status

1. Edit `data/status.json` and set `personal` to one of these lines, exactly:
   - `Heads down.`
   - `In deep work, slow to surface.`
   - `Focused on a build, not available for check-ins.`
   - `Surfacing soon.`
   - `Between projects, more reachable than usual.`
   - `Handling something. Will update when there's something to say.`
2. Commit and push. GitHub Actions rebuilds and publishes it.

## Pause or resume a project

1. Edit `data/projects.json` and set the project to `"paused"` or `"active"`.
2. Commit and push. The page shows `○ Paused` or `● Active` beside that project.

These two files are the only content that changes without changing a lock file.

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

`npm run build` runs all 18 checks in Section 8 of the brief against the
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
