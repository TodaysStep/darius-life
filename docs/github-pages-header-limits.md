# Headers GitHub Pages cannot send

GitHub Pages serves this output as plain static files and does not support a
`_headers` mechanism, so none of the following can be set for the public site:

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
instead of a headers file for this target.

The confidential area (`confidential-site/_headers`) stays on Cloudflare Pages
and keeps every header, unaffected by any of this.
