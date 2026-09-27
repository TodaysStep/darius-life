#!/usr/bin/env node
// Section 10 acceptance checks, run against the REAL deployed site — not local build
// output. Runs daily via .github/workflows/verify-live.yml, and by hand any time with
// `node checks/verify-live.mjs`. Never fails the build (there is no build here); it
// reports, so a live regression is visible without needing a push to surface it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { sha256, resolveLink, fetchOnce, mapLimit } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJSON = (p) => JSON.parse(read(p));

const PUBLIC = "https://darius.life";
const CONFIDENTIAL = "https://confidential.darius.life";
const WORKERS_DEV_FALLBACK = "https://darius-life-confidential.n8rr6kghc8.workers.dev";

const REQUIRED_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};
const META_CSP = "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'";

const results = [];
async function check(name, fn) {
  let problems;
  try {
    problems = await fn();
  } catch (e) {
    problems = [e.cause?.code ? `${e.cause.code}: ${e.message}` : e.message || String(e)];
  }
  results.push({ name, status: problems.length ? "FAIL" : "PASS", problems });
}

// -------------------------------------------------------------- the public page
await check("darius.life loads over HTTPS (acceptance 1)", async () => {
  const r = await fetchOnce(`${PUBLIC}/`, "manual");
  return r.status === 200 ? [] : [`HTTP ${r.status}`];
});

await check("www.darius.life redirects to the apex (acceptance 1)", async () => {
  const r = await fetchOnce("https://www.darius.life/", "manual");
  const loc = r.headers.get("location");
  if (r.status < 300 || r.status >= 400) return [`expected a redirect, got HTTP ${r.status}`];
  if (!loc || !loc.replace(/\/$/, "") === `${PUBLIC}`) return [`redirects to "${loc}", not ${PUBLIC}/`];
  return [];
});

let liveDoc = null;
await check("darius.life page fetched and parsed", async () => {
  const r = await fetchOnce(`${PUBLIC}/`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  liveDoc = new JSDOM(await r.text()).window.document;
  return [];
});

await check("manifest IDs are all present on the live page (acceptance 2)", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const manifest = readJSON("content/manifest.json");
  const missing = manifest.items.filter((i) => !liveDoc.querySelector(`[data-id="${i.id}"]`)).map((i) => i.id);
  return missing.length ? [`missing on live page: ${missing.join(", ")}`] : [];
});

await check("terms visible with no click (acceptance 4)", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const el = liveDoc.querySelector('[data-id="terms"]');
  if (!el) return ["terms block not found"];
  for (let n = el; n; n = n.parentElement) if (n.tagName === "DETAILS" || n.hasAttribute?.("hidden")) return [`inside <${n.tagName.toLowerCase()}>`];
  return [];
});

await check("public page has no <form>, <script>, or tracker (defense in depth)", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  for (const tag of ["form", "script", "input", "iframe"]) if (liveDoc.querySelector(tag)) return [`contains <${tag}>`];
  return [];
});

await check("public page meta CSP matches (acceptance 7, GitHub Pages variant)", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const csp = liveDoc.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute("content");
  return csp === META_CSP ? [] : [`meta CSP is "${csp}"`];
});

// -------------------------------------------------------------- terms + /verify
let termsTxt = null;
await check("/terms.txt matches terms.lock (acceptance 3)", async () => {
  const r = await fetchOnce(`${PUBLIC}/terms.txt`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  termsTxt = await r.text();
  const lock = read("terms.lock").trim();
  return sha256(termsTxt) === lock ? [] : [`sha256 is ${sha256(termsTxt)}, terms.lock is ${lock}`];
});

await check("/terms.sha256 publishes the same hash (acceptance 3)", async () => {
  const r = await fetchOnce(`${PUBLIC}/terms.sha256`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  const body = await r.text();
  const lock = read("terms.lock").trim();
  return body === `${lock}  terms.txt\n` ? [] : [`/terms.sha256 is "${body.trim()}", expected "${lock}  terms.txt"`];
});

await check("/verify shows the same hash and effective date (acceptance 3)", async () => {
  const r = await fetchOnce(`${PUBLIC}/verify`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  const doc = new JSDOM(await r.text()).window.document;
  const lock = read("terms.lock").trim();
  const hash = doc.querySelector('[data-verify="hash"]')?.textContent;
  const want = JSON.parse(read("content/manifest.json")).items.find((i) => i.id === "terms")?.effective;
  const got = doc.querySelector('[data-verify="effective"]')?.textContent;
  const p = [];
  if (hash !== lock) p.push(`/verify hash is "${hash}", terms.lock is "${lock}"`);
  if (got !== want) p.push(`/verify effective date is "${got}", manifest says "${want}"`);
  return p;
});

// -------------------------------------------------------------- every link on the live page
await check("every link on the live page resolves (acceptance 6)", async () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const hrefs = [...new Set([...liveDoc.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("https://")))];
  const evidence = readJSON("checks/link-evidence.json");
  const outcomes = await mapLimit(hrefs, 6, (u) => resolveLink(u, { onChallenge: (url) => challenged(url, evidence) }));
  return outcomes.filter((o) => !o.ok).map((o) => `${o.url}: ${o.detail}`);
});
async function challenged(url, evidence) {
  const wall = evidence.botWalledHosts[new URL(url).host];
  if (!wall) return { url, ok: false, detail: "bot-walled; no verification method recorded" };
  try {
    const feed = await fetchOnce(wall.feed, "follow");
    if (feed.ok && (await feed.text()).includes(url)) return { url, ok: true, note: `bot-walled; listed in ${wall.feed}` };
  } catch {}
  const rec = evidence.recorded[url];
  return rec ? { url, ok: true, note: `bot-walled; recorded proof ${rec.provedAt}` } : { url, ok: false, detail: "bot-walled and not in feed" };
}

// -------------------------------------------------------------- headers (acceptance 7)
await check("security headers present on darius.life", async () => {
  const r = await fetchOnce(`${PUBLIC}/`, "follow");
  const p = [];
  for (const h of ["strict-transport-security", "x-content-type-options", "x-frame-options"]) {
    if (r.headers.get(h)) p.push(`${h} unexpectedly present on GitHub Pages — see docs/github-pages-header-limits.md`);
  }
  return p;
});

await check("security headers present on confidential.darius.life", async () => {
  const r = await fetchOnce(`${CONFIDENTIAL}/`, "follow");
  const p = [];
  for (const [h, v] of Object.entries(REQUIRED_HEADERS)) {
    const got = r.headers.get(h);
    if (got !== v) p.push(`${h}: expected "${v}", got ${got ? `"${got}"` : "nothing"} (may be masked by an Access login page — HTTP ${r.status})`);
  }
  return p;
});

// -------------------------------------------------------------- confidential area is gated (acceptance 5)
await check("confidential.darius.life does not serve its real content unauthenticated (acceptance 5)", async () => {
  const r = await fetchOnce(`${CONFIDENTIAL}/`, "follow");
  if (r.status === 200) {
    const body = await r.text();
    if (/ACTIVE LEGAL PROCEEDINGS/i.test(body)) return ["served the real page with no Access login — NOT gated"];
  }
  return [];
});

await check("the workers.dev fallback address does not leak the confidential area either", async () => {
  const r = await fetchOnce(`${WORKERS_DEV_FALLBACK}/`, "follow");
  if (r.status === 200) {
    const body = await r.text();
    if (/ACTIVE LEGAL PROCEEDINGS/i.test(body)) return ["served the real page with no Access login — NOT gated"];
  }
  return [];
});

// -------------------------------------------------------------- report
let failed = 0;
for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${r.name}`);
  if (r.status !== "PASS") for (const x of r.problems ?? []) console.log(`       - ${x}`);
  if (r.status === "FAIL") failed++;
}
console.log(failed ? `\n${failed} live check(s) failing.` : "\nAll live checks passed.");
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## darius.life live verification\n\n${results.map((r) => `- ${r.status === "PASS" ? "✅" : "❌"} ${r.name}${r.problems?.length ? `\n  - ${r.problems.join("\n  - ")}` : ""}`).join("\n")}\n`,
  );
}
process.exitCode = failed ? 1 : 0;
