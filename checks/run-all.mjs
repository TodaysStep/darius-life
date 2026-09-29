#!/usr/bin/env node
// Every Section 8 requirement of the build brief. Any failure exits non-zero, which stops
// the Cloudflare Pages build, and a stopped build does not deploy.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { sha256, extractText, loadDom, fetchOnce, resolveLink as resolveLinkBase, mapLimit, META_CSP, META_REFERRER, pngDimensions } from "./lib.mjs";

if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" },
  });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CI = process.env.CF_PAGES === "1" || process.env.CI === "true";
const rel = (p) => path.relative(ROOT, p);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJSON = (p) => JSON.parse(read(p));

const REQUIRED = `identity, status.nws, status.personal, resume, terms,
notes.todays-notes, notes.todays-step, notes.founder-notes, notes.line,
legal.blurb, legal.private-login, legal.scenic-drive, legal.trademarks,
legal.pe-act, legal.pro, legal.pro-policy, legal.correspondence, legal.li-privacy,
legal.li-terms, legal.schedule.songsketch, legal.schedule.napkinsketch,
legal.schedule.nurture, legal.law-enforcement, legal.receipt-verify,
legal.identity-distortion,
projects.blurb, projects.living-instruments, projects.todays-notes,
projects.small-step-ventures, projects.memorial-song, projects.meaning-preservation,
projects.dreamstep-press, projects.li-press, projects.hands-on, projects.honest-reading,
projects.songsketch, projects.napkinsketch, projects.business-studio, projects.todays-step,
projects.founder-notes, projects.dreamstep-education, projects.dreamstep-engineering,
projects.lox, projects.posterity-cloud, projects.founding-record,
help.blurb, help.donate, help.food, help.meals-on-wheels, help.founders-letter,
writing.blurb, writing.thesis, writing.dreamstep, writing.educators-exile-1,
writing.todays-step-archive,
footer.press, footer.updated, footer.copyright`
  .split(/[\s,]+/)
  .filter(Boolean);

const PAGE_ORDER = ["identity", "status", "resume", "terms", "notes", "legal", "projects", "help", "writing", "footer"];

// The exact status-LED colours used in src/styles.css — kept here too so check 14
// can allow precisely these and nothing else.
const LED_GREEN = "#1E8E3E";
const LED_GREY = "#8C8C8C";

const DESCRIPTION =
  "Design founder. Built the iTunes Music Store and Apple's early cloud services at Apple. Now building Living Instruments and helping others build their own ventures through Small Step Ventures.";

const STATUS_VOCABULARY = [
  "Heads down.",
  "In deep work, slow to surface.",
  "Focused on a build, not available for check-ins.",
  "Surfacing soon.",
  "Between projects, more reachable than usual.",
  "Handling something. Will update when there's something to say.",
];

const TEXT_EXT = new Set([".html", ".txt", ".css", ".sha256", ".json", ".md", ".xml", ".svg", ".csv", ".ico", ""]);
const walkFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walkFiles(p) : [p];
  });

// ---------------------------------------------------------------- inputs
const results = [];
const manifestRaw = read("content/manifest.json");
const manifest = JSON.parse(manifestRaw);
const allow = readJSON("checks/allowlist.json");
const evidence = readJSON("checks/link-evidence.json");
const indexFile = path.join(DIST, "index.html");
const verifyFile = path.join(DIST, "verify/index.html");
if (!fs.existsSync(indexFile)) {
  console.error("checks: dist/index.html is missing — run `node src/build.mjs` first");
  process.exit(1);
}
const doc = loadDom(indexFile);
const verifyDoc = fs.existsSync(verifyFile) ? loadDom(verifyFile) : null;
const distFiles = walkFiles(DIST);
const htmlFiles = distFiles.filter((f) => f.endsWith(".html"));
const textFiles = distFiles.filter((f) => TEXT_EXT.has(path.extname(f)) || path.basename(f).startsWith("_"));
const termsTxt = fs.existsSync(path.join(DIST, "terms.txt")) ? fs.readFileSync(path.join(DIST, "terms.txt"), "utf8") : null;
const termsLock = read("terms.lock").trim();
const byId = (id) => doc.querySelectorAll(`[data-id="${id}"]`);
const plain = (md) => md.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
const mdLinks = (md) => [...md.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1]);

async function check(n, name, fn) {
  let problems;
  try {
    problems = await fn();
  } catch (e) {
    problems = [`check crashed: ${e.stack || e.message}`];
  }
  if (problems === "SKIP" || problems?.skip) {
    results.push({ n, name, status: "SKIP", problems: [problems.skip || "skipped"] });
  } else {
    results.push({ n, name, status: problems.length ? "FAIL" : "PASS", problems });
  }
}

// ---------------------------------------------------------------- 1
await check(1, "Manifest completeness", () => {
  const p = [];
  const ids = manifest.items.map((i) => i.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) p.push(`duplicate ids: ${dupes.join(", ")}`);
  const lo = ids.indexOf("writing.educators-exile-1");
  const hi = ids.indexOf("writing.todays-step-archive");
  const added = ids.filter((id, i) => !REQUIRED.includes(id) && !(i > lo && i < hi && /^writing\.[a-z0-9-]+$/.test(id)));
  if (added.length) p.push(`unlisted ids: ${added.join(", ")} (only writing.* entries between writing.educators-exile-1 and writing.todays-step-archive may be added)`);
  const core = ids.filter((id) => REQUIRED.includes(id));
  if (core.join() !== REQUIRED.join()) {
    const missing = REQUIRED.filter((id) => !ids.includes(id));
    p.push(missing.length ? `missing ids: ${missing.join(", ")}` : "required ids are out of order");
  }
  const lock = read("manifest.lock").trim();
  if (sha256(manifestRaw) !== lock) p.push("content/manifest.json does not match manifest.lock");
  for (const id of ids) {
    const n = byId(id).length;
    if (n !== 1) p.push(`${id} rendered ${n} times (expected once)`);
  }
  for (const el of doc.querySelectorAll("[data-id]")) {
    if (!ids.includes(el.getAttribute("data-id"))) p.push(`rendered item not in manifest: ${el.getAttribute("data-id")}`);
  }
  for (const a of doc.querySelectorAll("a")) {
    if (!a.closest("[data-id]")) p.push(`link outside any manifest item: ${a.getAttribute("href")}`);
  }
  const headings = manifest.sections.filter((s) => s.heading).map((s) => s.heading);
  const h2 = [...doc.querySelectorAll("h2")].map((h) => h.textContent.trim());
  if (h2.join("|") !== headings.join("|")) p.push(`section headings ${JSON.stringify(h2)} differ from manifest ${JSON.stringify(headings)}`);
  const stray = doc.body.cloneNode(true);
  stray.querySelectorAll("[data-id], h2").forEach((e) => e.remove());
  const leftover = stray.textContent.replace(/\s+/g, " ").trim();
  if (leftover) p.push(`text rendered outside manifest items: "${leftover.slice(0, 120)}"`);
  return p;
});

// ---------------------------------------------------------------- 2
await check(2, "Terms integrity", () => {
  const p = [];
  const el = byId("terms")[0];
  if (!el) return ["terms block not rendered"];
  const rendered = extractText(el);
  if (termsTxt === null) return ["dist/terms.txt missing"];
  if (rendered !== termsTxt) p.push("rendered terms differ from /terms.txt");
  if (sha256(termsTxt) !== termsLock) p.push(`sha256(/terms.txt)=${sha256(termsTxt)} but terms.lock=${termsLock}`);
  const item = manifest.items.find((i) => i.id === "terms");
  if (item?.sha256 !== termsLock) p.push("manifest terms hash differs from terms.lock");
  const published = fs.existsSync(path.join(DIST, "terms.sha256")) ? fs.readFileSync(path.join(DIST, "terms.sha256"), "utf8") : "";
  if (published !== `${termsLock}  terms.txt\n`) p.push("/terms.sha256 does not publish terms.lock");
  if (termsTxt.split("\n\n").length !== 3) p.push("terms must be exactly three paragraphs");
  return p;
});

// ---------------------------------------------------------------- 3
await check(3, "Verbatim copy", () => {
  const p = [];
  for (const item of manifest.items) {
    const el = byId(item.id)[0];
    if (!el) continue; // reported by check 1
    const text = extractText(el, { skipDynamic: true });
    if (!item.sha256) p.push(`${item.id}: no approved hash`);
    else if (sha256(text) !== item.sha256) p.push(`${item.id}: rendered text differs from its approved hash`);
    for (const part of [item.label, item.note && plain(item.note), item.text && plain(item.text)].filter(Boolean)) {
      if (!text.includes(part.trim())) p.push(`${item.id}: "${part.slice(0, 60)}" is not rendered verbatim`);
    }
    if (item.source && !text.includes(extractTextFromMd(item.source))) p.push(`${item.id}: ${item.source} is not rendered verbatim`);
    const declared = [item.href, ...mdLinks(item.note ?? ""), ...mdLinks(item.text ?? ""), ...(item.source ? mdLinks(read(item.source)) : [])].filter(Boolean).sort();
    const rendered = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href")).sort();
    if (declared.join("\n") !== rendered.join("\n")) p.push(`${item.id}: links ${JSON.stringify(rendered)} differ from manifest ${JSON.stringify(declared)}`);
  }
  return p;
});
function extractTextFromMd(src) {
  return read(src).replace(/\r\n/g, "\n").trim().split(/\n{2,}/).map((b) => plain(b)).join("\n\n");
}

// ---------------------------------------------------------------- 4
await check(4, "Terms visibility", () => {
  const p = [];
  const el = byId("terms")[0];
  if (!el) return ["terms block not rendered"];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const tag = n.tagName.toLowerCase();
    if (["details", "template", "noscript", "dialog"].includes(tag)) p.push(`terms are inside <${tag}>`);
    if (n.hasAttribute("hidden")) p.push(`terms ancestor <${tag}> has the hidden attribute`);
    if (n.getAttribute("aria-hidden") === "true") p.push(`terms ancestor <${tag}> is aria-hidden`);
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute("style") ?? "")) p.push(`terms ancestor <${tag}> is hidden by inline style`);
  }
  const css = read("src/styles.css");
  if (/display\s*:\s*none|visibility\s*:\s*hidden|content-visibility|opacity\s*:\s*0(?![.\d])/i.test(css)) p.push("styles.css contains a hiding rule");
  const legal = doc.querySelector('[data-section="legal"]');
  if (!legal || !(el.compareDocumentPosition(legal) & 4)) p.push("terms do not appear before the Legal section");
  return p;
});

// ---------------------------------------------------------------- 5
await check(5, "Page order", () => {
  const order = [...doc.querySelectorAll("[data-section]")].map((e) => e.getAttribute("data-section"));
  return order.join() === PAGE_ORDER.join() ? [] : [`sections render as ${order.join(" > ")}; required ${PAGE_ORDER.join(" > ")}`];
});

// ---------------------------------------------------------------- 6
await check(6, "Every link resolves", async () => {
  const p = [];
  const pages = [
    [doc, indexFile],
    [verifyDoc, verifyFile],
  ].filter(([d]) => d);
  const hrefs = new Set();
  for (const [d, file] of pages) {
    for (const a of d.querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("mailto:")) {
        const addr = decodeURIComponent(href.slice(7).split("?")[0]).toLowerCase();
        if (!allow.mailto.includes(addr)) p.push(`mailto address not approved: ${addr}`);
      } else if (href.startsWith("#")) {
        if (!d.getElementById(href.slice(1))) p.push(`${rel(file)}: in-page anchor ${href} has no target`);
      } else if (href.startsWith("/")) {
        const target = path.join(DIST, href.endsWith("/") ? `${href}index.html` : href);
        if (!fs.existsSync(target)) p.push(`${href} is not in the build output`);
      } else if (href.startsWith("https://")) {
        hrefs.add(href);
      } else {
        p.push(`${rel(file)}: link is not https, mailto, or same-site: ${href}`);
      }
    }
  }
  if (process.env.LINKCHECK === "skip" && !CI) return { skip: `LINKCHECK=skip (local only); ${hrefs.size} https links not fetched` };
  const outcomes = await mapLimit([...hrefs], 6, (u) => resolveLinkBase(u, { onChallenge: challenged }));
  for (const o of outcomes) {
    if (!o.ok) p.push(`${o.url}: ${o.detail}`);
    else if (o.note) console.log(`  link note: ${o.url} — ${o.note}`);
  }
  return p;
});

// A bot wall is not a dead link, and not proof of a live one: require the author's feed
// to list the post, or a recorded proof committed with the link.
async function challenged(url) {
  const host = new URL(url).host;
  const wall = evidence.botWalledHosts[host];
  if (!wall) return { url, ok: false, detail: "answers automated requests with a bot challenge; no verification method is recorded for this host in checks/link-evidence.json" };
  try {
    const feed = await fetchOnce(wall.feed, "follow");
    if (feed.ok && (await feed.text()).includes(url)) return { url, ok: true, note: `bot-walled; listed in ${wall.feed}` };
  } catch {}
  const rec = evidence.recorded[url];
  if (rec) return { url, ok: true, note: `bot-walled; not in the current feed; recorded proof ${rec.provedAt}: ${rec.method}` };
  return { url, ok: false, detail: `bot-walled and not listed in ${wall.feed}; no recorded proof` };
}

// ---------------------------------------------------------------- 7
await check(7, "Destination allowlist", () => {
  const p = [];
  const hrefsOf = (d) => [...d.querySelectorAll("[href], [src]")].map((e) => [e.tagName.toLowerCase(), e.getAttribute("href") ?? e.getAttribute("src")]);
  const RESOURCES = /^\/(styles\.css|favicon\.ico|favicon\.svg|apple-touch-icon\.png|assets\/fonts\/courier-prime\/[\w.-]+\.woff2)$/;
  for (const [tag, href] of hrefsOf(doc)) {
    if (tag === "link" && href === "https://darius.life/") continue; // <link rel="canonical"> — self-referential, not a fetched resource
    if (tag === "a" ? !allow.index.includes(href) : !RESOURCES.test(href)) p.push(`index.html: <${tag}> destination not allowed: ${href}`);
  }
  if (verifyDoc) {
    for (const [tag, href] of hrefsOf(verifyDoc)) {
      if (tag === "a" ? !allow.verify.includes(href) : !RESOURCES.test(href)) p.push(`verify/index.html: <${tag}> destination not allowed: ${href}`);
    }
  }
  const unused = allow.index.filter((h) => !doc.querySelector(`a[href="${h}"]`));
  if (unused.length) p.push(`allowlisted but not rendered (stale allowlist): ${unused.join(", ")}`);
  return p;
});

// ---------------------------------------------------------------- 8
await check(8, "No unresolved values", () => {
  const p = [];
  const BAD = ["LINK_", "WRITING_", "TODO", "TBD", "[", "{{", "}}"];
  for (const f of textFiles) {
    const s = fs.readFileSync(f, "utf8");
    for (const b of BAD) if (s.includes(b)) p.push(`${rel(f)} contains "${b}"`);
    if (/\shref\s*=\s*(""|'')|<a(?![^>]*\shref=)[^>]*>/i.test(s)) p.push(`${rel(f)} has an empty or missing href`);
  }
  return p;
});

// ---------------------------------------------------------------- 9
await check(9, "Address and phone never published", () => {
  const raw = process.env.PROTECTED_STRINGS ?? "";
  const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
  const needles = raw.split(/\r?\n|[|;]/).map(norm).filter(Boolean);
  if (!needles.length) {
    return CI ? ["PROTECTED_STRINGS is not set; the build refuses to publish without it"] : { skip: "PROTECTED_STRINGS not set (local run). On Cloudflare Pages this fails the build." };
  }
  const p = [];
  needles.forEach((n, i) => n.length < 4 && p.push(`protected string #${i + 1} is shorter than 4 letters or digits once spacing is removed`));
  for (const f of distFiles) {
    const buf = fs.readFileSync(f);
    const hay = norm(TEXT_EXT.has(path.extname(f)) ? buf.toString("utf8") : buf.toString("latin1"));
    needles.forEach((n, i) => n.length >= 4 && hay.includes(n) && p.push(`protected string #${i + 1} appears in ${rel(f)}`));
  }
  return p;
});

// ---------------------------------------------------------------- 10
await check(10, "Status vocabulary", () => {
  const p = [];
  const status = readJSON("data/status.json");
  const keys = Object.keys(status);
  if (keys.join() !== "personal") p.push(`data/status.json must hold exactly one key, "personal"; found ${keys.join(", ")}`);
  if (!STATUS_VOCABULARY.includes(status.personal)) p.push(`personal status "${status.personal}" is not one of the six allowed lines`);
  const projects = readJSON("data/projects.json");
  const projectIds = manifest.items.filter((i) => i.dynamic === "project").map((i) => i.id.slice("projects.".length));
  for (const [k, v] of Object.entries(projects)) {
    if (!projectIds.includes(k)) p.push(`data/projects.json: "${k}" is not a project in the manifest`);
    if (v !== "active" && v !== "paused") p.push(`data/projects.json: "${k}" is "${v}"; use "active" or "paused"`);
  }
  for (const id of projectIds) if (!(id in projects)) p.push(`data/projects.json has no status for "${id}"`);
  const shown = doc.querySelector('[data-dynamic="status"]')?.textContent;
  if (shown !== status.personal) p.push(`page shows status "${shown}" instead of "${status.personal}"`);
  for (const id of projectIds) {
    const want = projects[id] === "paused" ? "Paused" : "Active";
    const got = doc.querySelector(`[data-id="projects.${id}"] [data-dynamic="project"]`)?.textContent.replace(/\s+/g, " ").trim();
    if (got !== want) p.push(`projects.${id} shows "${got}" instead of "${want}"`);
  }
  return p;
});

// ---------------------------------------------------------------- 11
await check(11, "No inbound channel on the site", () => {
  const p = [];
  const BANNED = ["form", "input", "textarea", "iframe", "script", "object", "embed", "img", "picture", "video", "audio", "svg", "canvas", "button", "select"];
  for (const f of htmlFiles) {
    const d = loadDom(f);
    for (const tag of BANNED) if (d.querySelector(tag)) p.push(`${rel(f)} contains <${tag}>`);
    for (const el of d.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) if (/^on/i.test(attr)) p.push(`${rel(f)}: inline handler ${attr} on <${el.tagName.toLowerCase()}>`);
      if (el.tagName !== "A" && !(el.tagName === "LINK" && el.getAttribute("rel") === "canonical")) {
        for (const a of ["href", "src", "srcset", "action", "data", "poster"]) {
          const v = el.getAttribute(a);
          if (v && !v.startsWith("/")) p.push(`${rel(f)}: <${el.tagName.toLowerCase()} ${a}> loads ${v} (only same-site resources are allowed)`);
        }
      }
    }
    if (d.querySelector('meta[http-equiv="refresh" i]')) p.push(`${rel(f)} has a meta refresh`);
  }
  for (const f of distFiles.filter((x) => x.endsWith(".css"))) {
    const css = fs.readFileSync(f, "utf8");
    if (/@import/i.test(css)) p.push(`${rel(f)} uses @import`);
    for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) if (!m[1].startsWith("/")) p.push(`${rel(f)} loads ${m[1]}`);
  }
  return p;
});

// ---------------------------------------------------------------- 12
await check(12, "No tracking", () => {
  const p = [];
  const TRACKERS = /cloudflareinsights|beacon\.min\.js|googletagmanager|google-analytics|gtag\(|plausible|fathom|umami|matomo|segment\.io|hotjar|facebook\.net|pixel/i;
  for (const f of textFiles) if (TRACKERS.test(fs.readFileSync(f, "utf8"))) p.push(`${rel(f)} references a tracker`);
  return p;
});

// ---------------------------------------------------------------- 13
// The real headers are a Cloudflare Response Header Transform Rule
// (cloudflare/rules.md) — a dashboard/zone-level object, not a file in this repo,
// so it can't be asserted here. checks/live.mjs verifies it against the live site
// instead. What IS checkable at build time is the <meta> fallback (holds even if
// the page is reached without passing through Cloudflare) and robots.txt.
await check(13, "Security headers (build-time: the <meta> fallback only)", () => {
  const p = [];
  for (const [d, name] of [
    [doc, "index.html"],
    [verifyDoc, "verify/index.html"],
  ]) {
    if (!d) continue;
    const csp = d.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute("content");
    if (csp !== META_CSP) p.push(`${name}: meta CSP must be exactly "${META_CSP}" (found ${csp ? `"${csp}"` : "nothing"})`);
    const ref = d.querySelector('meta[name="referrer" i]')?.getAttribute("content");
    if (ref !== META_REFERRER) p.push(`${name}: <meta name="referrer"> must be "${META_REFERRER}" (found ${ref ? `"${ref}"` : "nothing"})`);
  }
  if (!/^Disallow: \/legal\/private\/$/m.test(read("public/robots.txt"))) p.push("public/robots.txt must disallow /legal/private/");
  return p;
});

// ---------------------------------------------------------------- 14
await check(14, "Accessibility", async () => {
  const p = [];
  const css = read("src/styles.css");
  const colors = [...css.matchAll(/(?<![-\w])color\s*:\s*([^;]+);/g)].map((m) => m[1].trim().toUpperCase());
  const backgrounds = [...css.matchAll(/background(?:-color)?\s*:\s*([^;]+);/g)].map((m) => m[1].trim().toUpperCase());
  // The two status-LED colours (green/grey) and the page's own text colour used as a
  // fill (the lock glyph, the LED dots) are the one deliberate, explicit exception to
  // the page's two-colour budget — approved per the LED status-indicator requirement.
  // Every LED and the lock icon still carries its state in visible text right beside
  // it, so colour is never the only way the status is conveyed (WCAG 1.4.1).
  const LED_EXCEPTIONS = ["#111111", LED_GREEN, LED_GREY];
  if (colors.some((c) => c !== "#111111")) p.push(`text colours other than #111111: ${[...new Set(colors)].join(", ")}`);
  if (backgrounds.some((c) => c !== "#F6F3EE" && !LED_EXCEPTIONS.includes(c))) p.push(`backgrounds other than #F6F3EE or an approved LED colour: ${[...new Set(backgrounds)].join(", ")}`);
  const ratio = contrast("#111111", "#F6F3EE");
  if (ratio < 7) p.push(`contrast ${ratio.toFixed(2)}:1 is below 7:1`);
  if (!/a:focus-visible\s*\{[^}]*outline:\s*2px solid #111111/.test(css)) p.push("links need a visible focus outline");
  if (/outline\s*:\s*(none|0)\b/.test(css)) p.push("styles.css removes an outline");
  const axeSource = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
  for (const f of htmlFiles) {
    const dom = new JSDOM(fs.readFileSync(f, "utf8"), { runScripts: "outside-only", pretendToBeVisual: true });
    const d = dom.window.document;
    if (d.documentElement.getAttribute("lang") !== "en") p.push(`${rel(f)}: <html lang="en"> missing`);
    if (d.querySelectorAll("h1").length !== 1) p.push(`${rel(f)}: ${d.querySelectorAll("h1").length} h1 elements (expected 1)`);
    if (!d.querySelector("main")) p.push(`${rel(f)}: no <main> landmark`);
    if (f === indexFile && !(d.querySelector("header") && d.querySelector("footer"))) p.push("index.html: header and footer landmarks required");
    dom.window.eval(axeSource);
    const r = await dom.window.axe.run(d, { resultTypes: ["violations"], rules: { "color-contrast": { enabled: false } } });
    for (const v of r.violations) p.push(`${rel(f)}: axe ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})`);
    dom.window.close();
  }
  return p;
});

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------- 15
await check(15, "Performance", () => {
  const p = [];
  const resources = [
    indexFile,
    ...[...doc.querySelectorAll("link[href]")]
      .map((l) => l.getAttribute("href"))
      .filter((h) => h.startsWith("/")) // skip <link rel="canonical">, which is self-referential, not fetched
      .map((h) => path.join(DIST, h)),
  ];
  const css = read("src/styles.css");
  for (const m of css.matchAll(/url\("?(\/[^")]+)/g)) resources.push(path.join(DIST, m[1]));
  const unique = [...new Set(resources)];
  const total = unique.reduce((s, f) => s + fs.statSync(f).size, 0);
  console.log(`  page weight: ${total} bytes across ${unique.length} files`);
  if (total >= 150_000) p.push(`page weight ${total} bytes is not under 150 KB`);
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  if (!faces.length || faces.some((f) => !/font-display:\s*optional/.test(f))) p.push("every @font-face needs font-display: optional (no swap, no layout shift)");
  for (const m of css.matchAll(/url\("?(\/[^")]+\.woff2)/g)) {
    if (!doc.querySelector(`link[rel="preload"][href="${m[1]}"][as="font"][crossorigin]`)) p.push(`font ${m[1]} is not preloaded`);
  }
  return p;
});

// ---------------------------------------------------------------- 16
await check(16, "/verify present", () => {
  if (!verifyDoc) return ["dist/verify/index.html missing"];
  const p = [];
  const text = extractText(verifyDoc.querySelector('[data-verify="terms"]'));
  if (text !== termsTxt) p.push("/verify terms text differs from /terms.txt");
  if (verifyDoc.querySelector('[data-verify="hash"]')?.textContent !== termsLock) p.push("/verify hash differs from terms.lock");
  const eff = verifyDoc.querySelector('[data-verify="effective"]')?.textContent;
  const want = manifest.items.find((i) => i.id === "terms")?.effective;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eff ?? "") || eff !== want) p.push(`/verify effective date "${eff}" must equal the manifest's "${want}"`);
  for (const h of ["/terms.txt", "/terms.sha256"]) if (!verifyDoc.querySelector(`a[href="${h}"]`)) p.push(`/verify does not link ${h}`);
  return p;
});

// ---------------------------------------------------------------- 17
await check(17, "Private documents never on GitHub", () => {
  const p = [];
  const isPrivatePath = (p_) => /(^|\/)legal\/private(\/|$)/.test(p_) && !p_.startsWith("workers/private-legal/");
  let tracked = [];
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (e) {
    return [`could not list git-tracked files: ${e.message}`];
  }
  const trackedOffenders = tracked.filter(isPrivatePath);
  if (trackedOffenders.length) p.push(`tracked in git: ${trackedOffenders.join(", ")}`);
  const distOffenders = distFiles.map((f) => rel(f)).filter(isPrivatePath);
  if (distOffenders.length) p.push(`generated into dist/: ${distOffenders.join(", ")}`);
  return p;
});

// ---------------------------------------------------------------- 18
await check(18, "Live verification gates the workflow", () => {
  const p = [];
  const wf = fs.existsSync(path.join(ROOT, ".github/workflows/deploy.yml")) ? read(".github/workflows/deploy.yml") : null;
  if (!wf) return [".github/workflows/deploy.yml is missing"];
  if (!/checks\/live\.mjs/.test(wf)) p.push("deploy.yml has no job running checks/live.mjs");
  const liveJobMatch = wf.match(/^\s{2}(\S+):\n(?:(?!^\s{2}\S+:).*\n)*?.*checks\/live\.mjs.*$/m);
  if (liveJobMatch) {
    const jobBlock = liveJobMatch[0];
    if (/continue-on-error:\s*true/.test(jobBlock)) p.push("deploy.yml's live-verification job has continue-on-error: true — it must be able to fail the workflow");
  }
  if (!fs.existsSync(path.join(ROOT, "checks/live.mjs"))) p.push("checks/live.mjs is missing");
  return p;
});

// ---------------------------------------------------------------- 19
// No email address or contact path on the public page at all — everything is
// arranged "through correspondence" instead. Independent of check 6/7's mailto
// allowlist, which only catches addresses inside an actual mailto: link; this
// catches an email address written anywhere, in any file, linked or not.
await check(19, "No email address anywhere in the build", () => {
  const p = [];
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  for (const f of textFiles) {
    const found = fs.readFileSync(f, "utf8").match(EMAIL);
    if (found) p.push(`${rel(f)} contains an email address: ${[...new Set(found)].join(", ")}`);
  }
  return p;
});

// ---------------------------------------------------------------- 20
// og:image/twitter:image point at the live URL (checks/live.mjs confirms it
// actually returns 200 post-deploy — a build can't fetch a URL that doesn't
// exist yet on a first deploy, the same chicken-and-egg problem PROTECTED_STRINGS
// and DNS proxying already ran into earlier in this project).
await check(20, "Preview and page metadata", () => {
  const p = [];
  const meta = (sel) => doc.querySelector(sel)?.getAttribute("content");
  const title = doc.querySelector("title")?.textContent;
  if (title !== "Michael Darius") p.push(`<title> is "${title}", expected "Michael Darius"`);
  if (meta('meta[name="description"]') !== DESCRIPTION) p.push(`meta description does not match the approved text`);
  if (doc.querySelector('link[rel="canonical"]')?.getAttribute("href") !== "https://darius.life/") p.push(`<link rel="canonical" href="https://darius.life/"> missing or wrong`);
  const OG = {
    "og:title": "Michael Darius",
    "og:type": "profile",
    "og:url": "https://darius.life/",
    "og:site_name": "darius.life",
    "og:locale": "en_US",
    "og:description": DESCRIPTION,
    "og:image": "https://darius.life/og.png",
    "og:image:width": "1200",
    "og:image:height": "630",
  };
  for (const [prop, want] of Object.entries(OG)) {
    const got = meta(`meta[property="${prop}"]`);
    if (got !== want) p.push(`meta[property="${prop}"] is ${got ? `"${got}"` : "missing"}, expected "${want}"`);
  }
  if (!meta('meta[property="og:image:alt"]')) p.push(`meta[property="og:image:alt"] is missing`);
  const TWITTER = {
    "twitter:card": "summary_large_image",
    "twitter:title": "Michael Darius",
    "twitter:description": DESCRIPTION,
    "twitter:image": "https://darius.life/og.png",
  };
  for (const [name, want] of Object.entries(TWITTER)) {
    const got = meta(`meta[name="${name}"]`);
    if (got !== want) p.push(`meta[name="${name}"] is ${got ? `"${got}"` : "missing"}, expected "${want}"`);
  }
  if (!doc.querySelector('link[rel="icon"][href="/favicon.ico"]')) p.push(`<link rel="icon" href="/favicon.ico"> missing`);
  if (!doc.querySelector('link[rel="icon"][type="image/svg+xml"][href="/favicon.svg"]')) p.push(`<link rel="icon" type="image/svg+xml" href="/favicon.svg"> missing`);
  if (!doc.querySelector('link[rel="apple-touch-icon"][href="/apple-touch-icon.png"]')) p.push(`<link rel="apple-touch-icon" href="/apple-touch-icon.png"> missing`);

  for (const [file, want] of [
    ["og.png", { width: 1200, height: 630 }],
    ["apple-touch-icon.png", { width: 180, height: 180 }],
  ]) {
    const f = path.join(DIST, file);
    if (!fs.existsSync(f)) {
      p.push(`dist/${file} is missing`);
      continue;
    }
    const dim = pngDimensions(fs.readFileSync(f));
    if (dim.width !== want.width || dim.height !== want.height) p.push(`dist/${file} is ${dim.width}x${dim.height}, expected ${want.width}x${want.height}`);
  }
  for (const file of ["favicon.ico", "favicon.svg"]) {
    if (!fs.existsSync(path.join(DIST, file))) p.push(`dist/${file} is missing`);
  }
  return p;
});

// ---------------------------------------------------------------- report
let failed = 0;
for (const r of results.sort((a, b) => a.n - b.n)) {
  console.log(`${r.status.padEnd(4)} ${String(r.n).padStart(2)}. ${r.name}`);
  if (r.status !== "PASS") for (const x of r.problems) console.log(`       - ${x}`);
  if (r.status === "FAIL") failed++;
}
if (failed) {
  console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed. Nothing deploys.`);
  process.exit(1);
}
const skipped = results.filter((r) => r.status === "SKIP").length;
console.log(skipped ? `\nAll checks that ran passed; ${skipped} skipped (local only).` : "\nAll checks passed.");
