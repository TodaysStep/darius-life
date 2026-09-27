# Headers GitHub Pages cannot send

GitHub Pages serves the public page as plain static files and does not
support a `_headers` mechanism, so none of the following can be set there:

- `Strict-Transport-Security`
- `X-Content-Type-Options`
- `X-Frame-Options`
- `Permissions-Policy`
- The `frame-ancestors`, `form-action`, and `base-uri` directives of
  `Content-Security-Policy` (the CSP spec ignores them when delivered via
  `<meta>` rather than a real header)

`src/template.html` and `src/verify.html` set what a `<meta>` tag actually can:
`default-src`/`style-src`/`font-src`/`img-src`/`script-src` and
`Referrer-Policy`. `checks/run-all.mjs` (check 13) verifies those meta tags
at build time, since that's all a build can check.

The real, complete header set — all six headers, for every response on
`darius.life`, including the private-legal Worker's — comes from a
zone-level Cloudflare Response Header Transform Rule, applied once the whole
domain is proxied through Cloudflare. See `cloudflare/rules.md` for the exact
rule and `docs/handoff-2026-09-27.md` for why the domain is proxied at all
(brief version 2.1, superseding an earlier design that avoided any Cloudflare
dependency for the public page). `checks/live.mjs` verifies the live headers
against the real site, since a build can't see a zone-level rule.
