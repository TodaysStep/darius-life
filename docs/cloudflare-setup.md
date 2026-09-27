# Cloudflare setup for darius.life

Do these in order. Step 1 must finish before step 4: while the platform Worker
still has a `darius.life/*` route, it answers in front of the Pages site.

## 1. Redeploy the platform gateway Worker

Commit `4ea88c4d3` in `TodaysStep/posteritycloud-infra` removes the darius.life
routes and fixes `livinginstruments.com/posterity/1.0` (a link on this page that
answers 404 today, so the first Pages build would stop on it).

```
cd edge/host-metadata-gateway
npx wrangler login
npx wrangler deploy
```

Then in the dashboard: Workers & Pages → `host-metadata-gateway` → Settings →
Domains & Routes. Delete any route on `darius.life` or `*.darius.life` that is
still listed.

Check:

```
curl -sI https://livinginstruments.com/posterity/1.0   # 301 → https://posterityos.com/posterity/1.0
curl -sI https://posterityos.com/posterity/1.0         # 200
```

## 2. Create the Pages project

Workers & Pages → Create → Pages → Connect to Git → `TodaysStep/darius-life`.

- Project name: `darius-life`
- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: 20 (read from `.node-version`)

## 3. Secret and analytics

Project → Settings → Variables and Secrets → add `PROTECTED_STRINGS` as an
encrypted secret for Production and Preview. Put the mailing address and phone
number in it, one per line, in whatever form they are usually written. The check
ignores case, spacing, and punctuation.

Project → Metrics / Web Analytics: leave off.

Retry the deployment. It must pass all sixteen checks.

## 4. Domains

Project → Custom domains → add `darius.life`, then `www.darius.life`. Cloudflare
replaces the two `CNAME … todaysstep.github.io` records with records for the
Pages project. Leave every MX and TXT record as it is.

## 5. www → apex

Pages `_redirects` cannot redirect by hostname, so this is a zone rule.
`darius.life` zone → Rules → Redirect Rules → Create:

- When: Hostname equals `www.darius.life`
- Then: Dynamic, expression `concat("https://darius.life", http.request.uri.path)`
- Status 301, preserve query string on.

SSL/TLS → Edge Certificates: Always Use HTTPS on, Minimum TLS Version 1.2.

## 6. Private legal area

Zero Trust → Access → Applications → Add → Self-hosted.

- Name: `darius.life private legal`
- Public hostnames, each with path `legal/private`:
  `darius.life`, `www.darius.life`, `darius-life.pages.dev`, `*.darius-life.pages.dev`
- Policy: Allow, Include → Emails → your address(es).
- Login method: One-time PIN.

Without the two `pages.dev` hostnames, the same files are readable at the
project's own address.

## 7. After it is live

- Remove the `CNAME` file from `TodaysStep/todaysstep.github.io` so GitHub stops
  claiming the domain.
- Send a message to `homecorrespondence@darius.life` and confirm it arrives.
- Run the Section 10 acceptance checks against the live site.
