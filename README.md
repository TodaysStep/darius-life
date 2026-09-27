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

**Two builds, two hosts, deliberately.** Nothing on the public page is secret —
only the confidential legal area needs real access control, and GitHub Pages
cannot provide that (see "Hosting" below). So `src/build.mjs` writes two
separate outputs from one source repo:

| | public page | confidential legal area |
|---|---|---|
| output | `dist/` | `dist-confidential/` |
| source | everything except `legal/confidential/` | `legal/confidential/` |
| host | GitHub Pages | Cloudflare Pages + Access |
| bill this depends on | none — a different company, free forever | Cloudflare Pages itself is also free; only the account it's on needs to stay in good standing |

This repository does not need to be private — nothing in `dist/` is secret. It
stays private anyway because `legal/confidential/` (documents you place there,
never the built site) does.

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

## The confidential legal area

Put documents in `legal/confidential/`. They build into `dist-confidential/`,
a completely separate output that Cloudflare Pages deploys to
`confidential.darius.life`, behind Cloudflare Access (one-time PIN to the
addresses in the Access policy). They are never copied into `dist/`, so they
can never reach GitHub Pages, which has no access control at all. The build
writes an index page listing them unless you provide `index.html`. Every
response from that host sends `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex`.

The build refuses to publish (either target) if your mailing address or phone
number (the `PROTECTED_STRINGS` secret) appears in any output file. A document
that must contain them cannot be placed here as-is. Text inside compressed PDF
streams cannot be read by the check.

## Checks

`npm run build` runs all sixteen requirements in Section 8 of the brief, against
both outputs. Locally:

- `LINKCHECK=skip npm run build` skips fetching live links. Both CI providers
  (GitHub Actions and Cloudflare Pages) set `CI`/`CF_PAGES`, which the check
  detects and always fetches every link regardless of `LINKCHECK` — the skip
  only ever applies to a local run.
- Without `PROTECTED_STRINGS` set, check 9 is skipped locally and fails under
  either CI provider.

## Hosting

**Public page — GitHub Pages, via GitHub Actions** (`.github/workflows/pages.yml`).
Repo Settings → Pages → Source: **GitHub Actions**. No Cloudflare product is
involved in serving this page at all. Add repo secret `PROTECTED_STRINGS` (same
value as the Cloudflare one below) so the workflow can run check 9.

**Confidential area — Cloudflare Pages project `darius-life-confidential`**:
production branch `main`, build command `npm run build`, output directory
`dist-confidential`, Node 20 (`.node-version`). Secret: `PROTECTED_STRINGS`
(production and preview), one string per line — the build fails without it.

Why two Cloudflare Pages projects don't make sense here (rather than one
project serving both directories): Pages custom domains are per-project, and
`darius.life` and `confidential.darius.life` need to end up on different
hosts entirely (GitHub vs. Cloudflare) — one project can't do that.

### Domains

- `darius.life` and `www.darius.life`: GitHub Pages custom domain (a `CNAME`
  file, written by the build to `dist/CNAME` — see `content/manifest.json`'s
  absence of it; it's static, not manifest-driven, since it never changes).
  GitHub auto-redirects whichever of the two isn't the configured canonical
  domain to the other; no `_redirects` rule is needed or possible on GitHub
  Pages.
- `confidential.darius.life`: Cloudflare Pages custom domain, attached to the
  `darius-life-confidential` project.

The platform's gateway Worker must have no route on either hostname; see
`.lovable/memory/constraints/darius-life-personal-index.md` in
`TodaysStep/posteritycloud-infra`.

### Cloudflare Access

Self-hosted application covering the whole `darius-life-confidential`
project's hostnames: `confidential.darius.life` and
`darius-life-confidential.pages.dev`. Without the `pages.dev` entry the same
files are reachable on the project's own address. Policy: allow the listed
emails, one-time PIN; deny everyone else.

### What GitHub Pages can't do

No custom HTTP response headers — `Strict-Transport-Security`,
`X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy`, and the
`frame-ancestors`/`form-action`/`base-uri` CSP directives, are all header-only
and cannot be replicated in static HTML. `src/template.html` and
`src/verify.html` set what a `<meta>` tag can (`Content-Security-Policy`'s
remaining directives, `Referrer-Policy`); `checks/run-all.mjs` checks those
instead of a headers file for this target. See
`docs/github-pages-header-limits.md`. The confidential area keeps every header
in full, since it stays on Cloudflare Pages.

### Email

The zone's MX, SPF, DKIM and DMARC records carry iCloud mail for
`homecorrespondence@`, `hello@` and `confidential@darius.life`. They are recorded in
`docs/cutover-2026-09-27.md` and must not change.
