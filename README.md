# darius.life

Michael Darius's personal index. Plain static HTML, built by `src/build.mjs`
from `content/manifest.json` and checked by `checks/run-all.mjs`. Cloudflare
Pages runs `npm run build`; if any check fails, nothing deploys.

This repository must stay private: files in `legal/private/` live here.

## Change your status

1. Edit `data/status.json` and set `personal` to one of these lines, exactly:
   - `Heads down.`
   - `In deep work, slow to surface.`
   - `Focused on a build, not available for check-ins.`
   - `Surfacing soon.`
   - `Between projects, more reachable than usual.`
   - `Handling something. Will update when there's something to say.`
2. Commit. Cloudflare Pages rebuilds and publishes it.

## Pause or resume a project

1. Edit `data/projects.json` and set the project to `"paused"` or `"active"`.
2. Commit. The page shows `○ Paused` or `● Active` beside that project.

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

Put documents in `legal/private/`. They publish under `/legal/private/`, which
Cloudflare Access protects (one-time PIN to the addresses in the Access policy).
The build writes an index page listing them unless you provide `index.html`.
They are never linked from the public page, never indexed, and sent with
`Cache-Control: private, no-store`.

The build refuses to publish if your mailing address or phone number (the
`PROTECTED_STRINGS` secret) appears in any output file, including this folder.
A document that must contain them cannot be placed here as-is. Text inside
compressed PDF streams cannot be read by the check.

## Checks

`npm run build` runs all sixteen requirements in Section 8 of the brief. Locally:

- `LINKCHECK=skip npm run build` skips fetching links (never on Cloudflare).
- Without `PROTECTED_STRINGS` set, check 9 is skipped locally and fails on
  Cloudflare.

## Hosting

Cloudflare Pages project `darius-life`: production branch `main`, build command
`npm run build`, output `dist`, Node 20 (`.node-version`). Secret:
`PROTECTED_STRINGS` (production and preview), one string per line.

### Domains and redirects

`darius.life` and `www.darius.life` are attached to the project. `www` to apex is
a zone Redirect Rule (301, path and query kept), because Pages `_redirects` does
not support domain-level redirects.

The platform's gateway Worker must have no route on `darius.life`; see
`.lovable/memory/constraints/darius-life-personal-index.md` in
`TodaysStep/posteritycloud-infra`.

### Cloudflare Access

Self-hosted application covering `/legal/private/*` on every hostname that serves
this project: `darius.life`, `www.darius.life`, `darius-life.pages.dev`, and
`*.darius-life.pages.dev`. Without the `pages.dev` entries the same files are
reachable on the project's own address. Policy: allow the listed emails, one-time
PIN; deny everyone else.

### Email

The zone's MX, SPF, DKIM and DMARC records carry iCloud mail for
`homecorrespondence@`, `hello@` and `confidential@darius.life`. They are recorded in
`docs/cutover-2026-09-27.md` and must not change.
