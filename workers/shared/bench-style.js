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
// that way deliberately — no transparent cutout — inside a small white card
// so it reads cleanly against the aged-paper page background around it.
export const STENOTYPE_ICON = (size = 56) =>
  `<span class="steno-icon" style="width:${size}px;height:${size}px"><img src="/assets/bench/stenotype.jpg" alt="Stenotype machine" width="${size}" height="${size}"></span>`;

const STYLE = `
:root { color-scheme: light; }
body {
  margin: 0;
  background: #E9E0CC;
  background-image:
    repeating-linear-gradient(0deg, rgba(17,17,17,0.05) 0 1px, transparent 1px 6px);
  color: #2A2318;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.page { max-width: 40em; margin: 0 auto; padding: 1.2em 1.1em 4em; }
header.bench-header { display: flex; align-items: center; gap: 0.8em; margin-bottom: 0.4em; }
.steno-icon {
  display: inline-flex; flex: none; background: #FFFFFF; border: 1px solid #2A231833;
  border-radius: 0.3em; padding: 0.15em; box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}
.steno-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
h1 { font-size: 1.25em; margin: 0; letter-spacing: 0.01em; }
h1 .tag { display: block; font-size: 0.55em; font-weight: normal; letter-spacing: 0.15em; text-transform: uppercase; opacity: 0.65; margin-top: 0.15em; }
h2 {
  font-size: 0.95em; margin: 1.8em 0 0.7em; padding-bottom: 0.4em;
  border-bottom: 2px dotted #2A231855; letter-spacing: 0.04em; text-transform: uppercase;
}
p.hint { font-size: 0.88em; opacity: 0.75; margin: 0.6em 0 1.2em; }
.ticker { border-top: 1px dashed #2A231855; margin: 1.6em 0; }
a { color: #5B3A29; }
button, input[type="submit"] {
  font: inherit; font-weight: bold; padding: 0.75em 1em; background: #2A2318; color: #E9E0CC;
  border: none; border-radius: 0.3em; cursor: pointer;
}
button:active, input[type="submit"]:active { opacity: 0.85; }
input[type="text"], input[type="date"], input[type="password"], textarea, select {
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
.entry-layer .layer-name { display: block; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; margin-bottom: 0.15em; }
.case-row { display: flex; justify-content: space-between; align-items: baseline; padding: 0.7em 0; border-bottom: 1px dashed #2A231855; }
.case-row a { font-weight: bold; text-decoration: none; }
.case-row .status { font-size: 0.78em; opacity: 0.7; }
.note { font-size: 0.88em; margin-top: 1.5em; }
.error { color: #7A2E1E; font-weight: bold; }
`;

export const benchPage = (title, body, { csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'none'" } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · Bench Notes</title>
<style>${STYLE}</style>
</head><body><div class="page">${body}</div></body></html>`;
