# Cloudflare zone configuration for darius.life

The exact settings brief v2.1 section 9 requires. Applying these is dashboard/API
work outside this repo's build — this file is the record of what "applied" means,
per section 9's own requirement that these be "recorded... as applied." As of
2026-09-27 these are NOT yet applied; see docs/handoff-2026-09-27.md.

**Order matters** (section 9.6): create the web DNS records DNS-only, wait for
GitHub to issue its certificate and confirm Enforce HTTPS works, and only then
switch to Proxied. Proxying before that breaks GitHub's certificate issuance —
confirmed the hard way earlier this same night on this exact domain.

## DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `darius.life` | `185.199.108.153` | Proxied (after cutover) |
| A | `darius.life` | `185.199.109.153` | Proxied (after cutover) |
| A | `darius.life` | `185.199.110.153` | Proxied (after cutover) |
| A | `darius.life` | `185.199.111.153` | Proxied (after cutover) |
| AAAA | `darius.life` | `2606:50c0:8000::153` | Proxied (after cutover) |
| AAAA | `darius.life` | `2606:50c0:8001::153` | Proxied (after cutover) |
| AAAA | `darius.life` | `2606:50c0:8002::153` | Proxied (after cutover) |
| AAAA | `darius.life` | `2606:50c0:8003::153` | Proxied (after cutover) |
| CNAME | `www` | `todaysstep.github.io` | Proxied (after cutover) |

MX, SPF (`_spf`/root TXT), DKIM (`sig1._domainkey`, `cf2024-1._domainkey`), and
DMARC (`_dmarc`) records are untouched — see docs/cutover-2026-09-27.md for the
recorded before-state.

## SSL/TLS

- Mode: **Full (strict)**
- Always Use HTTPS: **on**
- Minimum TLS version: **1.2**
- HSTS: **on** — `max-age=63072000; includeSubDomains; preload` (also set by the
  Transform Rule below; Cloudflare's HSTS panel and a Transform Rule can both set
  this header — pick one source of truth so they don't conflict. This repo assumes
  the Transform Rule is that source, since it also sets five other headers HSTS's
  own panel doesn't cover.)

## Redirect Rule — www to apex

- When: Hostname equals `www.darius.life`
- Then: Dynamic redirect, expression `concat("https://darius.life", http.request.uri.path)`
- Status: 301, preserve query string: on

## Response Header Transform Rule — security headers (check 13)

Applies to all darius.life responses (both the GitHub Pages origin and the
`/legal/private/*` Worker). Set (add/overwrite) each of the following:

```
Content-Security-Policy: default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
X-Frame-Options: DENY
```

## Off (check 12)

- Web Analytics
- Browser Insights
- Zaraz
- Rocket Loader
- Email Address Obfuscation

The last two specifically inject their own JavaScript into responses if left on —
worth double-checking given this site's whole design is zero JavaScript.

## Access application (section 9.9)

- Type: Self-hosted
- Path: `darius.life/legal/private/*`
- Policy: Allow — Include: the specific emails Darius enters — one-time PIN
- Everyone else: deny

The Worker (`workers/private-legal`) independently re-verifies the
`Cf-Access-Jwt-Assertion` header against this application's AUD tag and the
account's Access team domain — set those two values in
`workers/private-legal/wrangler.toml`'s `[vars]` before first deploy (both fail
closed — a wrong value returns 403, never 200).
