// Shared by the checks and by `npm run lock`. Text is extracted from the built HTML,
// independently of how src/build.mjs produced it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";

export const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// Brief v2.1 section 8 check 13. Applied zone-wide by a Cloudflare Response Header
// Transform Rule (cloudflare/rules.md) — not checkable from a build, only live
// (checks/live.mjs). The <meta> versions are the fallback that holds even if the
// page is somehow reached without passing through Cloudflare; frame-ancestors,
// form-action and base-uri are dropped there because the CSP spec ignores them
// when delivered via <meta> rather than a real header.
export const REQUIRED_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};
export const META_CSP = "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'";
export const META_REFERRER = "no-referrer";

const BLOCK = new Set([
  "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
  "SECTION", "HEADER", "FOOTER", "MAIN", "BLOCKQUOTE",
]);

// Rendered text: blocks separated by a blank line, <br> as a newline, whitespace collapsed.
// With skipDynamic, spans marked data-dynamic (status, project state, build date) are left out.
export function extractText(el, { skipDynamic = false } = {}) {
  let out = "";
  const walk = (n) => {
    if (n.nodeType === 3) {
      out += n.data.replace(/\s+/g, " ");
      return;
    }
    if (n.nodeType !== 1) return;
    if (skipDynamic && n.hasAttribute("data-dynamic")) return;
    if (n.tagName === "BR") {
      out += "\n";
      return;
    }
    const block = BLOCK.has(n.tagName);
    if (block) out += "\n\n";
    for (const c of n.childNodes) walk(c);
    if (block) out += "\n\n";
  };
  walk(el);
  return out.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const loadDom = (file) => new JSDOM(fs.readFileSync(file, "utf8")).window.document;

export const itemHash = (doc, id) => {
  const el = doc.querySelector(`[data-id="${id}"]`);
  return el ? sha256(extractText(el, { skipDynamic: true })) : null;
};

// One line per section and per item keeps manifest diffs reviewable.
export function formatManifest(m) {
  const line = (o) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
  return `{\n  "sections": [\n${m.sections.map((s) => `    ${line(s)}`).join(",\n")}\n  ],\n  "items": [\n${m.items.map((i) => `    ${line(i)}`).join(",\n")}\n  ]\n}\n`;
}

export const LINKCHECK_UA = "Mozilla/5.0 (compatible; darius-life-linkcheck/1.0; +https://darius.life)";

// Cloudflare bot walls: either flagged by header, or a block page served by Cloudflare itself.
export async function isChallenge(r) {
  if (r.status !== 403 && r.status !== 503) return false;
  if ((r.headers.get("cf-mitigated") ?? "").includes("challenge")) return true;
  if (!/cloudflare/i.test(r.headers.get("server") ?? "")) return false;
  return /challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare/.test(await r.text());
}

export async function fetchOnce(url, redirect) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    return await fetch(url, { redirect, signal: ctl.signal, headers: { "user-agent": LINKCHECK_UA, accept: "text/html,*/*" } });
  } finally {
    clearTimeout(t);
  }
}

// A bot wall is not a dead link, and not proof of a live one: require the caller's own
// evidence (e.g. an author's RSS feed listing the URL) before treating it as resolved.
export async function resolveLink(url, { onChallenge } = {}) {
  let last = "no response";
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const first = await fetchOnce(url, "manual");
      if (await isChallenge(first)) return onChallenge ? onChallenge(url) : { url, ok: false, detail: "bot-walled; no verification method provided" };
      if (first.status >= 200 && first.status < 300) return { url, ok: true };
      if (first.status >= 300 && first.status < 400) {
        const final = await fetchOnce(url, "follow");
        if (final.status >= 200 && final.status < 300) return { url, ok: true };
        if (await isChallenge(final)) return onChallenge ? onChallenge(url) : { url, ok: false, detail: "bot-walled; no verification method provided" };
        last = `redirects to a page answering HTTP ${final.status}`;
        if (final.status < 500) break;
        continue;
      }
      last = `HTTP ${first.status}`;
      if (first.status < 500 && first.status !== 429) break;
    } catch (e) {
      last = e.cause?.code || e.name || e.message;
    }
  }
  return { url, ok: false, detail: last };
}

export async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export function writeLocks(root) {
  const manifestPath = path.join(root, "content/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const doc = loadDom(path.join(root, "dist/index.html"));
  for (const item of manifest.items) {
    const h = itemHash(doc, item.id);
    if (!h) throw new Error(`lock: ${item.id} is not rendered in dist/index.html`);
    item.sha256 = h;
  }
  const text = formatManifest(manifest);
  fs.writeFileSync(manifestPath, text);
  fs.writeFileSync(path.join(root, "manifest.lock"), `${sha256(text)}\n`);
  const terms = fs.readFileSync(path.join(root, "dist/terms.txt"), "utf8");
  fs.writeFileSync(path.join(root, "terms.lock"), `${sha256(terms)}\n`);
  console.log("lock: item hashes, manifest.lock and terms.lock written");
}
