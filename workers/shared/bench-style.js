// Shared visual identity for both Bench Notes sides — the working side
// (src/bench-working.js) and the entrusted side (src/bench-entrusted.js).
// Vintage stenographer aesthetic: aged-paper tones, a ticker-tape rule under
// headings, dense monospaced timestamps. Deliberately shared so the two
// sides look like one product even though their code never shares a query.
export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const headers = (contentType) => ({
  "content-type": contentType,
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

// The stenotype image is supplied on a plain white background and is shown
// that way deliberately — no transparent cutout — against a plain white
// span of its own (no border/shadow framing it) so the image's own white
// background blends seamlessly rather than sitting inside a visible box.
//
// Served first-party by the confidential Worker from the BENCH_DOCUMENTS
// R2 binding. The approved image is stored once in R2 and referenced through
// this stable route so access pages and link previews cannot drift back to
// an external image host or a stale repository asset.
export const STENOTYPE_URL = "/entrusted/stenotype.jpg?v=20261004-3";

export const STENOTYPE_ICON = (size = 96) =>
  `<span class="steno-icon" style="width:${size}px;height:${size}px"><img src="${STENOTYPE_URL}" alt="Stenotype machine" width="${size}" height="${size}"></span>`;

const STYLE = `
:root { color-scheme: light; }
.evidence-text { font-family: Georgia, serif; line-height: 1.6; overflow-wrap: anywhere; }
.evidence-text blockquote { border-left: 3px solid #a88642; margin-left: 0; padding-left: 1rem; }
.evidence-text p { margin: .6em 0; }
html {
  background: #E9E0CC;
  color: #2A2318;
}
body {
  margin: 0;
  background: #E9E0CC;
  background-image:
    repeating-linear-gradient(0deg, rgba(17,17,17,0.05) 0 1px, transparent 1px 6px);
  color: #2A2318;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.page { max-width: 40em; margin: 0 auto; padding: 1.2em 1.1em 4em; }
header.bench-header {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 0.5em; margin-bottom: 0.4em;
}
.steno-icon {
  display: inline-flex; flex: none; background: #FFFFFF;
}
.steno-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
h1 { font-size: 1.25em; margin: 0; letter-spacing: 0.01em; }
h1 .tag { display: block; font-size: 0.55em; font-weight: normal; letter-spacing: 0.15em; text-transform: uppercase; color: #2A2318; opacity: 0.65; margin-top: 0.3em; }
h2 {
  font-size: 0.95em; margin: 1.8em 0 0.7em; padding-bottom: 0.4em;
  border-bottom: 2px dotted #2A231855; letter-spacing: 0.04em; text-transform: uppercase;
}
h3 { font-size: 0.8em; margin: 1.1em 0 0.5em; letter-spacing: 0.05em; text-transform: uppercase; color: #2A2318; opacity: 0.75; }
.spine { border-left: 3px solid #2A231855; margin: 0 0 0 0.4em; padding-left: 1.1em; }
.spine .card { position: relative; }
.spine .card::before {
  content: ""; position: absolute; left: -1.5em; top: 1em; width: 0.6em; height: 0.6em;
  border-radius: 50%; background: #2A2318; border: 2px solid #E9E0CC;
}
.preview-banner {
  background: #7A2E1E; color: #F6EFE2; padding: 0.7em 1em; border-radius: 0.3em;
  margin-bottom: 1.2em; display: flex; justify-content: space-between; align-items: center; gap: 1em;
}
.preview-banner a { color: #F6EFE2; font-weight: bold; }
p.hint { font-size: 0.88em; color: #2A2318; opacity: 0.75; margin: 0.6em 0 1.2em; }
.ticker { border-top: 1px dashed #2A231855; margin: 1.6em 0; }
a { color: #5B3A29; }
button, input[type="submit"] {
  font: inherit; font-weight: bold; padding: 0.75em 1em; background: #2A2318; color: #E9E0CC;
  border: none; border-radius: 0.3em; cursor: pointer;
}
button:active, input[type="submit"]:active { opacity: 0.85; }
input[type="text"], input[type="date"], input[type="password"], input[type="file"], textarea, select {
  font: inherit; width: 100%; box-sizing: border-box; padding: 0.6em 0.7em; margin: 0.3em 0 0.9em;
  border: 1px solid #2A231855; border-radius: 0.25em; background: #FBF8F0; color: #2A2318;
}
label { display: block; font-size: 0.85em; font-weight: bold; margin-top: 0.9em; }
label.opt { display: flex; align-items: center; gap: 0.5em; font-weight: normal; padding: 0.4em 0; }
label.opt input[type="checkbox"], label.opt input[type="radio"] { width: 1.1em; height: 1.1em; margin: 0; flex: none; }
textarea { min-height: 4em; resize: vertical; }
.card { background: #FBF8F0; border: 1px solid #2A231833; border-radius: 0.4em; padding: 0.9em 1em; margin: 0.9em 0; }
.entry-date { font-weight: bold; font-size: 0.85em; letter-spacing: 0.05em; }
.entry-layer { margin: 0.5em 0; padding-left: 0.8em; border-left: 3px solid #2A231833; }
.entry-layer .layer-name { display: block; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em; color: #2A2318; opacity: 0.6; margin-bottom: 0.15em; }
.case-row { display: flex; justify-content: space-between; align-items: baseline; padding: 0.7em 0; border-bottom: 1px dashed #2A231855; }
.case-row a { font-weight: bold; text-decoration: none; }
.case-row .status { font-size: 0.78em; color: #2A2318; opacity: 0.7; }
.note { font-size: 0.88em; margin-top: 1.5em; }
.error { color: #7A2E1E; font-weight: bold; }
.upcoming { border-left: 4px solid #7A2E1E; }

/* Entrusted Bench Note envelope — deliberately white, typeset, and spare.
 * This is a court-record access surface, not the working Bench UI. */
.envelope {
  max-width: 34rem; margin: 0 auto; padding: 3.2rem 1.25rem 4rem;
  text-align: center; background: #fff; color: #111;
  font-family: Georgia, "Times New Roman", serif;
}
.envelope .steno-icon { width: 260px !important; height: 210px !important; margin: 0 auto 2rem; background:#fff; }
.envelope .steno-icon img { object-fit: contain; }
.envelope-kicker {
  display:flex; align-items:center; justify-content:center; gap:.9rem;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:.66rem;
  letter-spacing:.24em; text-transform:uppercase; color:#8a6b2d;
}
.envelope-kicker::before,.envelope-kicker::after { content:""; width:4.5rem; height:1px; background:#d8c9a8; }
.envelope h1 {
  margin:1.5rem 0 0; font-size:clamp(2.55rem,10vw,4.7rem); line-height:.9;
  font-weight:500; letter-spacing:.055em; text-transform:uppercase;
}
.envelope .note-no { display:block; margin:.35rem 0 0; color:#9a7835; font-size:.78em; letter-spacing:.12em; }
.envelope .access-mark {
  margin:1.15rem 0 1.9rem; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size:.72rem; letter-spacing:.32em; text-transform:uppercase;
}
.envelope-rule { width:54%; border:0; border-top:1px solid #d8c9a8; margin:0 auto 1.8rem; }
.envelope .confidential-copy { max-width:29rem; margin:0 auto 2.1rem; font-size:1.06rem; line-height:1.55; }
.envelope form { text-align:left; }
.envelope label {
  margin:0 0 .55rem; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:.66rem;
  letter-spacing:.22em; text-transform:uppercase; color:#6f675b;
}
.envelope input[type="password"] {
  margin:0 0 .75rem; padding:1.05rem 1.1rem; border:1px solid #a88642; border-radius:.2rem;
  background:#fff; color:#111; font-family:ui-monospace,"SF Mono",Menlo,monospace;
  letter-spacing:.08em; outline:none;
}
.envelope input[type="password"]:focus { border-color:#111; box-shadow:0 0 0 1px #111; }
.envelope button, .envelope input[type="submit"] {
  width:100%; padding:1.05rem 1.1rem; border:1px solid #a88642; border-radius:.2rem;
  background:#161616; color:#fff; font-family:ui-monospace,"SF Mono",Menlo,monospace;
  font-size:.76rem; font-weight:500; letter-spacing:.22em; text-transform:uppercase;
}
.envelope button::after { content:"  →"; }
.envelope .error { text-align:left; margin:.7rem 0 1rem; }
.envelope-seal {
  margin-top:1.5rem; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:.58rem;
  letter-spacing:.18em; text-transform:uppercase; color:#8b8377;
}
@media (max-width:520px) {
  .page:has(.envelope) { padding:0; max-width:none; }
  .envelope { padding-top:2.1rem; min-height:100vh; box-sizing:border-box; }
  .envelope .steno-icon { width:220px !important; height:175px !important; }
  .envelope-kicker::before,.envelope-kicker::after { width:2rem; }
}

/* Every page declares :root { color-scheme: light } above, which should be
 * enough on its own — but a phone or browser that darkens web content
 * regardless (some Android WebViews' "force dark," some in-app browsers)
 * has been seen to reach this page anyway, fading body text toward gray
 * while leaving backgrounds closer to their authored color, which is the
 * opposite of readable. This block does not add a dark theme: it restates
 * the exact same parchment palette, at the same specificity a
 * prefers-color-scheme: dark match would otherwise win at, so there is
 * nothing left for a heuristic to darken. Every rule above that sets a
 * color or background is repeated here unchanged.
 */
@media (prefers-color-scheme: dark) {
  :root { color-scheme: light; }
  html { background: #E9E0CC; color: #2A2318; }
  body {
    background: #E9E0CC;
    background-image:
      repeating-linear-gradient(0deg, rgba(17,17,17,0.05) 0 1px, transparent 1px 6px);
    color: #2A2318;
  }
  .steno-icon { background: #FFFFFF; }
  h1 .tag, h3, p.hint, .entry-layer .layer-name, .case-row .status { color: #2A2318; }
  .spine .card::before { background: #2A2318; border-color: #E9E0CC; }
  .preview-banner { background: #7A2E1E; color: #F6EFE2; }
  .preview-banner a { color: #F6EFE2; }
  a { color: #5B3A29; }
  button, input[type="submit"] { background: #2A2318; color: #E9E0CC; }
  input[type="text"], input[type="date"], input[type="password"], input[type="file"], textarea, select {
    background: #FBF8F0; color: #2A2318;
  }
  .card { background: #FBF8F0; }
  .error { color: #7A2E1E; }
}
@media print {
  header.bench-header a, form, button, .ticker, p.note, .preview-banner, details summary { display: none !important; }
  body { background: #fff !important; }
  .page { max-width: none; }
}
`;

// img-src explicitly allows https://darius.life — the icon is always hosted
// there (see STENOTYPE_URL above), including on pages served from the
// different confidential.darius.life origin.
export const benchPage = (title, body, { csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'none'" } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · Bench Notes</title>
<style>${STYLE}</style>
</head><body><div class="page">${body}</div></body></html>`;
