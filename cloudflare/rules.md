# Cloudflare zone configuration for darius.life

The exact settings brief v2.1 section 9 requires. Applying these is dashboard/API
work outside this repo's build — this file is the record of what "applied" means,
per section 9's own requirement that these be "recorded... as applied."

**As of 2026-09-28, applied and confirmed live** (checked directly against
`https://darius.life/`, not assumed): DNS is proxied, SSL/TLS is Full (strict),
minimum TLS is 1.2, Email Address Obfuscation is off, and HSTS +
X-Content-Type-Options are live with the exact required values. **Also applied and confirmed live on 2026-09-29**: Web Analytics
auto-install for darius.life is disabled (no `cloudflareinsights` beacon in the
page), and a Response Header Transform Rule sets the other four security
headers on all responses. `node checks/live.mjs` passes every check, including
acceptance 8 and 9. **Still not applied**: the www→apex Redirect Rule (moot —
GitHub Pages already 301s www→apex on its own, confirmed live).

## DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `darius.life` | `185.199.108.153` | **Proxied — confirmed live** |
| A | `darius.life` | `185.199.109.153` | **Proxied — confirmed live** |
| A | `darius.life` | `185.199.110.153` | **Proxied — confirmed live** |
| A | `darius.life` | `185.199.111.153` | **Proxied — confirmed live** |
| AAAA | `darius.life` | `2606:50c0:8000::153` | Proxied (assumed, not individually checked) |
| AAAA | `darius.life` | `2606:50c0:8001::153` | Proxied (assumed, not individually checked) |
| AAAA | `darius.life` | `2606:50c0:8002::153` | Proxied (assumed, not individually checked) |
| AAAA | `darius.life` | `2606:50c0:8003::153` | Proxied (assumed, not individually checked) |
| CNAME | `www` | `todaysstep.github.io` | **Proxied — confirmed live** |

MX, SPF (`_spf`/root TXT), DKIM (`sig1._domainkey`, `cf2024-1._domainkey`), and
DMARC (`_dmarc`) records are untouched — see docs/cutover-2026-09-27.md for the
recorded before-state.

## SSL/TLS

- Mode: **Full (strict)** — applied 2026-09-28 via the Zone Settings API,
  confirmed by that same call's response (`"value":"strict"`).
- Always Use HTTPS: **on** (already was)
- Minimum TLS version: **1.2** — applied 2026-09-28, confirmed by the API response.
- HSTS: **on** — `max-age=63072000; includeSubDomains; preload`, applied
  2026-09-28 via the zone's native `security_header` setting (not a Transform
  Rule — that API wasn't reachable with the token in use). Confirmed live:
  `curl -I https://darius.life/` shows the header with exactly this value.
  The same setting's `nosniff` field also produces `X-Content-Type-Options:
  nosniff` — also confirmed live. This is now the source of truth for both
  headers; a future Transform Rule should NOT also set them, to avoid two
  sources disagreeing.

## Redirect Rule — www to apex

- When: Hostname equals `www.darius.life`
- Then: Dynamic redirect, expression `concat("https://darius.life", http.request.uri.path)`
- Status: 301, preserve query string: on

## Response Header Transform Rule — remaining security headers (check 13)

Strict-Transport-Security and X-Content-Type-Options are now set by the native
`security_header` zone setting above — **do not also set them here**, to avoid
two sources of truth disagreeing. This rule only needs to add the other four,
applied to all darius.life responses (both the GitHub Pages origin and the
`/legal/private/*`/`/control/*` Worker):

```
Content-Security-Policy: default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
X-Frame-Options: DENY
```

Applied 2026-09-29 from the dashboard (Rules → Transform Rules → Modify Response
Header, rule "darius.life security headers", all incoming requests, four
"Set static" headers). Confirmed live with `curl -I https://darius.life/`.

## Off (check 12)

- Web Analytics / Browser Insights — **off** as of 2026-09-29 (Web Analytics →
  Manage site → Real User Measurements: Disable). Before that,
  `checks/live.mjs` caught a `cloudflareinsights` beacon being injected.
- Zaraz — not checked.
- Rocket Loader — confirmed **off** (zone setting `rocket_loader`).
- Email Address Obfuscation — applied **off** 2026-09-28 via the Zone Settings
  API, confirmed by that call's response.

Web Analytics/Browser Insights and Rocket Loader specifically inject their own
JavaScript into responses if left on — worth confirming given this site's
whole design is zero JavaScript.

## Access application (section 9.9)

- Type: Self-hosted
- Path: `darius.life/legal/private/*` **and** `darius.life/control/*` — both
  paths on the same application, same policy. `/control/*` is the status/
  projects control panel (see "Control panel" below); it needs exactly the
  same gate, not a separate Access application.
- Policy: Allow — Include: the specific emails Darius enters — one-time PIN
- Everyone else: deny

The Worker (`workers/private-legal`) independently re-verifies the
`Cf-Access-Jwt-Assertion` header against this application's AUD tag and the
account's Access team domain — set those two values in
`workers/private-legal/wrangler.toml`'s `[vars]` before first deploy (both fail
closed — a wrong value returns 403, never 200).

## Control panel (section 9's status/projects control requirement)

`darius.life/control/*` (`workers/private-legal/src/control.js`) lets Darius
change his personal status and every project's status from his phone — no
code, no GitHub UI. It reads and writes `data/status.json` and
`data/projects.json` in this repo directly, via the GitHub Contents API, using
a secret the Worker needs at runtime:

- Create a fine-grained GitHub personal access token: Settings → Developer
  settings → Personal access tokens → Fine-grained tokens → repository access
  limited to **only** `TodaysStep/darius-life`, permission **Contents: Read
  and write**, nothing else.
- Add it as a repository secret named `GH_COMMIT_TOKEN` (same place as
  `CLOUDFLARE_API_TOKEN` etc.) — `.github/workflows/deploy.yml`'s
  `deploy-worker` job uploads it to the Worker as an encrypted secret
  (`wrangler secret put`, via `wrangler-action`'s `secrets` input) on every
  deploy. It is never committed and never appears in a build log.

A submitted change writes a normal commit to `main` (the same as any manual
edit would), which is what actually makes it "live in a few minutes": it goes
through the exact same `deploy.yml` build → checks → deploy pipeline as any
other push, not a bypass of it. If a submitted status line or project value
doesn't match what the build itself would accept, the control panel refuses
it before writing anything — see `workers/private-legal/src/control.test.mjs`.
