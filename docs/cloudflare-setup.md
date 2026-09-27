# Hosting setup for darius.life (brief version 2.1)

The whole domain — public page and private legal area alike — ends up on
`darius.life`, fronted by Cloudflare as a proxy. **Order matters**: bring the
public page up DNS-only first, confirm GitHub issues its own certificate,
*then* switch to proxied. Proxying before that breaks GitHub's certificate
issuance. Do the platform Worker step first regardless — it currently claims
`darius.life` and would run in front of whatever you attach next.

## 1. Redeploy the platform gateway Worker

Commit `4ea88c4d3` (and `36fcb20d8`) in `TodaysStep/posteritycloud-infra`
removes the darius.life routes.

```
cd edge/host-metadata-gateway
npx wrangler login
npx wrangler deploy
```

Then in the dashboard: Workers & Pages → `host-metadata-gateway` → Settings →
Domains & Routes. Delete any route on `darius.life` or `*.darius.life` still
listed.

## 2. Public page — GitHub Pages, DNS-only first

Builds from `TodaysStep/darius-life` on every push to `main`, via
`.github/workflows/deploy.yml`'s `build` + `deploy-pages` jobs.

1. Repo → Settings → Secrets and variables → Actions → New repository
   secret: `PROTECTED_STRINGS` — your mailing address and phone number, one
   per line. Without it check 9 fails and nothing deploys. (Diagnostic: a
   correctly-resolved secret shows as `***`, not blank, in the workflow's own
   `env:` log dump for the `npm run build` step.)
2. Repo → Settings → Pages → Build and deployment → Source: **GitHub
   Actions**.
3. DNS (below) pointed at GitHub Pages, **DNS-only** — do not proxy yet.
4. Push to `main` (or re-run the workflow). It builds `dist/`, which already
   contains a `CNAME` file for `darius.life` written by `src/build.mjs`.
5. Once DNS resolves and the workflow succeeds, GitHub issues its own
   certificate automatically. Settings → Pages → **Enforce HTTPS** becomes
   checkable once that certificate exists — check it.
6. Confirm unproxied:
   ```
   curl -sI https://darius.life/          # 200
   curl -sI https://www.darius.life/      # redirects to https://darius.life/
   ```
   Only once this is 200 should you proceed to step 5 (DNS cutover to
   Proxied) below.

## 3. Private legal area + control panel — Cloudflare Worker + R2, same domain

No separate hostname. `workers/private-legal` serves two paths on
`darius.life` directly:

- `/legal/private/*` — the private legal area, reading from an R2 bucket; the
  documents themselves never enter this repo, which is public.
- `/control/*` — Darius's own control panel for his personal status and every
  project's status (no code, no GitHub editing; see `cloudflare/rules.md`'s
  "Control panel" section for how it works).

1. R2 → Create bucket: `darius-life-private`.
2. Zero Trust → Access → Applications → Add → Self-hosted:
   - Name: `darius.life private legal area`
   - Paths: `darius.life/legal/private/*` **and** `darius.life/control/*` —
     both on this one application, same policy. Neither is the whole domain
     (the public page must stay ungated).
   - Policy: Allow, Include → Emails → the specific addresses Darius enters
   - Login method: One-time PIN
3. Copy that application's AUD tag, and the account's Access team domain
   (Zero Trust → Settings → Custom Pages, or the team's
   `<team-name>.cloudflareaccess.com` shown throughout the Zero Trust
   dashboard). Set both in `workers/private-legal/wrangler.toml`'s `[vars]`:
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. The Worker independently re-verifies
   the Access JWT against these for both paths — a wrong value fails closed
   (403, never 200), so get them right before the first deploy.
4. Repo → Settings → Secrets and variables → Actions → add
   `CLOUDFLARE_API_TOKEN` (a token scoped to Workers/R2 edit on this account),
   `CLOUDFLARE_ACCOUNT_ID`, and `GITHUB_COMMIT_TOKEN` (a fine-grained GitHub
   PAT scoped to only this repo, Contents: Read and write — the control panel
   uses it to commit `data/status.json`/`data/projects.json` on Darius's
   behalf). These drive `deploy-worker` (`.github/workflows/deploy.yml`,
   `cloudflare/wrangler-action@v4`) — `GITHUB_COMMIT_TOKEN` specifically is
   uploaded to the Worker as an encrypted secret on every deploy, never baked
   into the bundle.
5. Push to `main`. The `deploy-worker` job runs `wrangler deploy` from
   `workers/private-legal`, which reads its `[[routes]]` block
   (both paths) and attaches them to the zone directly — no dashboard step
   needed for the routes themselves.
6. Put legal documents in the R2 bucket (dashboard upload, or `wrangler r2
   object put darius-life-private/<key> --file=...`) — never in this repo.
7. Visit `https://darius.life/control/` (logged in via Access) to confirm the
   control panel loads and shows the current status and every project.

## 4. DNS

At the `darius.life` zone in Cloudflare — see `cloudflare/rules.md` for the
full table. Summary:

- `darius.life`: four `A` records to `185.199.108.153`, `.109.153`,
  `.110.153`, `.111.153`, plus the matching four `AAAA` records — **DNS-only**
  until step 2.6 above confirms 200, **then Proxied**.
- `www.darius.life`: `CNAME` to `todaysstep.github.io` — same DNS-only-then-
  Proxied sequencing.
- Everything else (MX, SPF, DKIM, DMARC, the verification TXT records) is
  untouched — see `docs/cutover-2026-09-27.md` for the recorded before-state.

Once proxied: SSL/TLS → **Full (strict)**, and apply the Response Header
Transform Rule and the www→apex Redirect Rule from `cloudflare/rules.md`.
Also confirm off: Web Analytics, Browser Insights, Zaraz, Rocket Loader,
Email Address Obfuscation (the last two inject their own JavaScript into
responses if left on, which matters given this site's whole design is zero
JavaScript).

## 5. After it is live

- Remove the `CNAME` file from `TodaysStep/todaysstep.github.io` if it still
  has one for `darius.life`, so that repo stops claiming a domain it doesn't
  serve.
- Send a message to `homecorrespondence@darius.life` and confirm it arrives.
- Set up branch protection on `main` requiring the `build` job to pass (brief
  section 9.1).
- Run `node checks/live.mjs` (or wait for its daily scheduled run,
  `.github/workflows/verify-live.yml`) against the live site — confirms
  headers, the private area's access gate, the direct-origin-refuses-it
  check, and every other Section 10 acceptance check that only a live site
  can prove.
