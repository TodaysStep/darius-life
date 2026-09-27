# Hosting setup for darius.life

Two independent setups. Do the platform Worker step first — it currently
claims `darius.life` and would run in front of whatever you attach next.

## 1. Redeploy the platform gateway Worker

Commit `4ea88c4d3` in `TodaysStep/posteritycloud-infra` removes the darius.life
routes and fixes `livinginstruments.com/posterity/1.0` (a link on this page that
answers 404 today, so the first build would stop on it).

```
cd edge/host-metadata-gateway
npx wrangler login
npx wrangler deploy
```

Then in the dashboard: Workers & Pages → `host-metadata-gateway` → Settings →
Domains & Routes. Delete any route on `darius.life` or `*.darius.life` still
listed.

Check:

```
curl -sI https://livinginstruments.com/posterity/1.0   # 301 → https://posterityos.com/posterity/1.0
curl -sI https://posterityos.com/posterity/1.0         # 200
```

## 2. Public page — GitHub Pages

No Cloudflare product serves this. It builds from `TodaysStep/darius-life` on
every push via `.github/workflows/pages.yml`.

1. Repo → Settings → Secrets and variables → Actions → New repository secret:
   `PROTECTED_STRINGS`, same value you'll set on Cloudflare in step 3. Without
   it the workflow fails on check 9.
2. Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Push to `main` (or re-run the workflow). It builds `dist/`, which already
   contains a `CNAME` file for `darius.life` written by `src/build.mjs` — you
   don't need to also type the domain into the Settings → Pages → Custom
   domain field, though doing so too is harmless.
4. Wait for the workflow to finish, then check:
   ```
   curl -sI https://darius.life/          # 200, once DNS (step 4) is live
   curl -sI https://www.darius.life/      # redirects to https://darius.life/
   ```

## 3. Confidential legal area — Cloudflare Pages + Access

A second, separate Pages project, from the same repo, building only
`legal/confidential/`.

1. Workers & Pages → Create → Pages → Connect to Git →
   `TodaysStep/darius-life`.
   - Project name: `darius-life-confidential`
   - Production branch: `main`
   - Build command: `npm run build`
   - Build output directory: `dist-confidential`
   - Node version: 20
2. Project → Settings → Variables and Secrets → add `PROTECTED_STRINGS` as an
   encrypted secret for Production and Preview — the mailing address and
   phone number, one per line, in whatever form they're usually written (the
   check ignores case, spacing, and punctuation). The build fails without it.
3. Project → Metrics / Web Analytics: leave off.
4. Retry the deployment. It must pass all sixteen checks (against both
   `dist/` and `dist-confidential/` — this project's build runs the same
   `npm run build` the GitHub Actions workflow does).
5. Project → Custom domains → add `confidential.darius.life`.
6. Zero Trust → Access → Applications → Add → Self-hosted:
   - Name: `darius.life confidential area`
   - Public hostnames: `confidential.darius.life` and
     `darius-life-confidential.pages.dev` (without the second, the same files
     are reachable at the project's own address, ungated)
   - Policy: Allow, Include → Emails → your address(es)
   - Login method: One-time PIN

## 4. DNS

At the `darius.life` zone in Cloudflare:

- `darius.life` and `www.darius.life`: point at GitHub Pages, **DNS only**
  (grey cloud) — proxying breaks GitHub's own certificate issuance. Apex: four
  `A` records to `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` (or a
  `CNAME` at the apex to `todaysstep.github.io` if your DNS provider supports
  CNAME flattening, as Cloudflare does). `www`: `CNAME` to
  `todaysstep.github.io`.
- `confidential.darius.life`: Cloudflare Pages custom domains attach their own
  DNS automatically when the zone is already on the same Cloudflare account —
  step 3.5 above handles this; no manual record needed.

SSL/TLS → Edge Certificates: Always Use HTTPS on, Minimum TLS Version 1.2.

## 5. After it is live

- Remove the `CNAME` file from `TodaysStep/todaysstep.github.io` if it still
  has one for `darius.life`, so that repo stops claiming a domain it doesn't
  serve.
- Send a message to `homecorrespondence@darius.life` and confirm it arrives.
- Run the Section 10 acceptance checks against the live public site, plus:
  confirm `confidential.darius.life` prompts for Access login and denies an
  email not on the allow list.
