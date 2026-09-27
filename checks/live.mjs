#!/usr/bin/env node
// Section 10 acceptance checks, run against the REAL deployed site — not local build
// output. This is the final job of .github/workflows/deploy.yml (gates the workflow —
// brief v2.1 check 18, so this script's own exit code must fail it) and runs again,
// unattended, once daily via .github/workflows/verify-live.yml.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { sha256, resolveLink, fetchOnce, mapLimit, REQUIRED_HEADERS, META_CSP, pngDimensions } from "./lib.mjs";

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJSON = (p) => JSON.parse(read(p));

const PUBLIC = "https://darius.life";
const GITHUB_PAGES_IPS = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];

const results = [];
async function check(name, fn) {
  let problems;
  try {
    problems = await fn();
  } catch (e) {
    problems = [e.cause?.code ? `${e.cause.code}: ${e.message}` : e.message || String(e)];
  }
  if (problems?.skip) results.push({ name, status: "SKIP", problems: [problems.skip] });
  else results.push({ name, status: problems.length ? "FAIL" : "PASS", problems });
}

// -------------------------------------------------------------- acceptance 1
await check("darius.life loads over HTTPS through Cloudflare (acceptance 1)", async () => {
  const r = await fetchOnce(`${PUBLIC}/`, "manual");
  const p = [];
  if (r.status !== 200) p.push(`HTTP ${r.status}`);
  if (!r.headers.get("cf-ray")) p.push('no cf-ray header — not passing through Cloudflare yet (see "DNS records proxied" in docs/handoff)');
  return p;
});

await check("www.darius.life redirects 301 to the apex (acceptance 1)", async () => {
  const r = await fetchOnce("https://www.darius.life/", "manual");
  if (r.status !== 301) return [`expected 301, got HTTP ${r.status}`];
  const loc = r.headers.get("location");
  return loc?.replace(/\/$/, "") === PUBLIC ? [] : [`redirects to "${loc}", not ${PUBLIC}/`];
});

// -------------------------------------------------------------- acceptance 2 + 4
let liveDoc = null;
await check("darius.life page fetched and parsed", async () => {
  const r = await fetchOnce(`${PUBLIC}/`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  liveDoc = new JSDOM(await r.text()).window.document;
  return [];
});

await check("every manifest ID is visible on the live page (acceptance 2)", () => {
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

await check("<meta> CSP/referrer fallback present (kept per brief v2.1 check 13)", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const csp = liveDoc.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute("content");
  const ref = liveDoc.querySelector('meta[name="referrer" i]')?.getAttribute("content");
  const p = [];
  if (csp !== META_CSP) p.push(`meta CSP is "${csp}"`);
  if (ref !== "no-referrer") p.push(`meta referrer is "${ref}"`);
  return p;
});

// -------------------------------------------------------------- acceptance 3
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
  return body === `${lock}  terms.txt\n` ? [] : [`/terms.sha256 is "${body.trim()}"`];
});

await check("/verify shows the same hash and effective date (acceptance 3)", async () => {
  const r = await fetchOnce(`${PUBLIC}/verify`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  const doc = new JSDOM(await r.text()).window.document;
  const lock = read("terms.lock").trim();
  const want = readJSON("content/manifest.json").items.find((i) => i.id === "terms")?.effective;
  const p = [];
  const hash = doc.querySelector('[data-verify="hash"]')?.textContent;
  if (hash !== lock) p.push(`/verify hash is "${hash}"`);
  const got = doc.querySelector('[data-verify="effective"]')?.textContent;
  if (got !== want) p.push(`/verify effective date is "${got}", manifest says "${want}"`);
  return p;
});

// -------------------------------------------------------------- acceptance 5 + 6: the private area
await check('/legal/private/ requires Access login — denies an unauthenticated request (acceptance 5)', async () => {
  const r = await fetchOnce(`${PUBLIC}/legal/private/`, "manual");
  if (r.status === 200) {
    const body = await r.text();
    if (/ACTIVE LEGAL PROCEEDINGS/i.test(body)) return ["served the real page with no Access login — NOT gated"];
  }
  // 302/403 to the Access login, or any non-200, counts as gated. This cannot verify
  // that an ALLOWED email succeeds — that needs a real authenticated session.
  return [];
});

await check("the GitHub origin itself refuses /legal/private/ directly (acceptance 6)", async () => {
  const p = [];
  for (const ip of GITHUB_PAGES_IPS) {
    try {
      const { stdout } = await execFileP("curl", [
        "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--resolve", `darius.life:443:${ip}`,
        "--max-time", "10",
        "https://darius.life/legal/private/",
      ]);
      if (stdout.trim() === "200") {
        p.push(`origin ${ip} answered 200 for /legal/private/ directly — private content is reachable bypassing Cloudflare/Access entirely`);
      }
    } catch (e) {
      p.push(`could not reach origin ${ip} directly: ${e.message}`);
    }
  }
  return p;
});

// -------------------------------------------------------------- acceptance 7
await check("every link on the live page resolves (acceptance 7)", async () => {
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

// -------------------------------------------------------------- acceptance 8: headers
await check("every security header from check 13 is present on darius.life (acceptance 8)", async () => {
  const r = await fetchOnce(`${PUBLIC}/`, "follow");
  const p = [];
  for (const [h, v] of Object.entries(REQUIRED_HEADERS)) {
    const got = r.headers.get(h);
    if (got !== v) p.push(`${h}: expected "${v}", got ${got ? `"${got}"` : "nothing"}`);
  }
  return p;
});

// -------------------------------------------------------------- acceptance 9 (partial — no browser here)
await check("no request leaves darius.life on the page as fetched (acceptance 9, static analysis)", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const p = [];
  for (const el of liveDoc.querySelectorAll("[href], [src]")) {
    if (el.tagName === "A" || (el.tagName === "LINK" && el.getAttribute("rel") === "canonical")) continue;
    const v = el.getAttribute("href") ?? el.getAttribute("src");
    if (v && !v.startsWith("/")) p.push(`<${el.tagName.toLowerCase()}> loads ${v}`);
  }
  for (const tag of ["form", "script", "iframe"]) if (liveDoc.querySelector(tag)) p.push(`contains <${tag}>`);
  return p;
});

// -------------------------------------------------------------- preview/page metadata (link-preview request)
await check("preview and page metadata present on the live page", () => {
  if (!liveDoc) return { skip: "page fetch failed" };
  const meta = (sel) => liveDoc.querySelector(sel)?.getAttribute("content");
  const p = [];
  if (liveDoc.querySelector("title")?.textContent !== "Michael Darius") p.push("title is not exactly \"Michael Darius\"");
  if (liveDoc.querySelector('link[rel="canonical"]')?.getAttribute("href") !== "https://darius.life/") p.push("canonical link missing or wrong");
  for (const prop of ["og:title", "og:type", "og:url", "og:site_name", "og:locale", "og:description", "og:image", "og:image:width", "og:image:height", "og:image:alt"]) {
    if (!meta(`meta[property="${prop}"]`)) p.push(`meta[property="${prop}"] missing`);
  }
  for (const name of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
    if (!meta(`meta[name="${name}"]`)) p.push(`meta[name="${name}"] missing`);
  }
  if (!liveDoc.querySelector('link[rel="icon"][href="/favicon.ico"]')) p.push("favicon.ico <link> missing");
  if (!liveDoc.querySelector('link[rel="icon"][type="image/svg+xml"]')) p.push("favicon.svg <link> missing");
  if (!liveDoc.querySelector('link[rel="apple-touch-icon"]')) p.push("apple-touch-icon <link> missing");
  return p;
});

await check("og:image (og.png) returns 200 on the live site at exactly 1200x630", async () => {
  const r = await fetchOnce(`${PUBLIC}/og.png`, "follow");
  if (r.status !== 200) return [`HTTP ${r.status}`];
  const dim = pngDimensions(Buffer.from(await r.arrayBuffer()));
  return dim.width === 1200 && dim.height === 630 ? [] : [`live og.png is ${dim.width}x${dim.height}, expected 1200x630`];
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
    `## darius.life live verification\n\n${results.map((r) => `- ${r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⏭️" : "❌"} ${r.name}${r.problems?.length ? `\n  - ${r.problems.join("\n  - ")}` : ""}`).join("\n")}\n`,
  );
}
process.exitCode = failed ? 1 : 0;
