#!/usr/bin/env node
// Renders dist/ from content/manifest.json. Every rendered item comes from the manifest.
// `node src/build.mjs --write-locks` also rewrites item hashes, manifest.lock and terms.lock.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJSON = (p) => JSON.parse(read(p));
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const LINK_OR_BOLD = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

function link(href, html) {
  const internal = href.startsWith("#") ? ' class="internal"' : "";
  return `<a href="${escAttr(href)}"${internal}>${html}</a>`;
}

function inline(md, { plain = false } = {}) {
  let out = "";
  let last = 0;
  for (const m of md.matchAll(LINK_OR_BOLD)) {
    out += esc(md.slice(last, m.index));
    if (m[1] !== undefined) out += plain ? esc(m[1]) : link(m[2], esc(m[1]));
    else out += `<strong>${esc(m[3])}</strong>`;
    last = m.index + m[0].length;
  }
  return out + esc(md.slice(last));
}

const blocks = (md) => md.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
const renderBlocks = (md, opts) =>
  blocks(md)
    .map((b) => `<p>${b.split("\n").map((l) => inline(l, opts)).join("<br>")}</p>`)
    .join("\n");
export const plainText = (md) =>
  blocks(md)
    .map((b) =>
      b
        .split("\n")
        .map((l) => l.replace(LINK_OR_BOLD, (_, t, _h, bold) => t ?? bold))
        .join("\n"),
    )
    .join("\n\n");

const DOT = { active: "●", paused: "○" };
const dot = (ch) => `<span class="dot" aria-hidden="true">${ch}</span>`;

function lastUpdated() {
  try {
    const d = execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  } catch {}
  const d = new Date().toISOString().slice(0, 10);
  console.warn(`build: no git history available; Last updated uses the build date ${d}`);
  return d;
}

function renderItem(item, ctx) {
  const id = `data-id="${item.id}"`;
  const label = () => (item.href ? link(item.href, esc(item.label)) : esc(item.label));
  switch (item.kind) {
    case "identity":
      return `<h1 ${id} data-section="identity">${esc(item.label)}</h1>`;
    case "indicator": {
      const tail =
        item.dynamic === "status"
          ? ` <span data-dynamic="status">${esc(ctx.status.personal)}</span>`
          : inline(item.note ?? "");
      return `<p class="indicator" ${id}>${dot("●")} ${label()}${tail}</p>`;
    }
    case "prose":
      return `<div class="prose" ${id}>\n${renderBlocks(read(item.source))}\n</div>`;
    case "block": {
      const anchor = item.anchor ? ` id="${item.anchor}"` : "";
      return `<div class="block" ${id}>\n<h3${anchor}>${esc(item.label)}</h3>\n${renderBlocks(read(item.source))}\n</div>`;
    }
    case "text": {
      const dyn = item.dynamic === "updated" ? ` <span data-dynamic="updated">${ctx.updated}</span>` : "";
      return `<p ${id}>${inline(item.text)}${dyn}</p>`;
    }
    case "entry": {
      const note = item.note ? ` — ${inline(item.note)}` : "";
      let state = "";
      if (item.dynamic === "project") {
        const s = ctx.projects[item.id.slice("projects.".length)];
        state = ` <span class="state" data-dynamic="project">${dot(DOT[s] ?? "?")} ${s === "paused" ? "Paused" : s === "active" ? "Active" : esc(String(s))}</span>`;
      }
      return `<span ${id}>${label()}${note}${state}</span>`;
    }
    default:
      throw new Error(`manifest item ${item.id} has unknown kind "${item.kind}"`);
  }
}

// Consecutive entries become one list; entries with `parent` nest under it.
function renderSectionItems(items, ctx) {
  const out = [];
  let list = null;
  const flush = () => {
    if (!list) return;
    out.push(
      "<ul>\n" +
        list
          .map((e) => {
            const kids = e.children.length
              ? `\n<ul class="sub">\n${e.children.map((c) => `<li>${renderItem(c, ctx)}</li>`).join("\n")}\n</ul>\n`
              : "";
            return `<li>${renderItem(e.item, ctx)}${kids}</li>`;
          })
          .join("\n") +
        "\n</ul>",
    );
    list = null;
  };
  for (const item of items) {
    if (item.kind === "entry" && item.parent) {
      const host = list?.find((e) => e.item.id === item.parent);
      if (!host) throw new Error(`${item.id}: parent ${item.parent} must directly precede it`);
      host.children.push(item);
    } else if (item.kind === "entry") {
      (list ??= []).push({ item, children: [] });
    } else {
      flush();
      out.push(renderItem(item, ctx));
    }
  }
  flush();
  return out.join("\n");
}

export function build() {
  const manifest = readJSON("content/manifest.json");
  const ctx = {
    status: readJSON("data/status.json"),
    projects: readJSON("data/projects.json"),
    updated: lastUpdated(),
  };
  const bySection = (s) => manifest.items.filter((i) => i.section === s);
  const heading = (s) => manifest.sections.find((x) => x.id === s)?.heading;

  const section = (s) =>
    `<section data-section="${s}" aria-labelledby="h-${s}">\n<h2 id="h-${s}">${esc(heading(s))}</h2>\n${renderSectionItems(bySection(s), ctx)}\n</section>`;

  const body = [
    "<header>",
    renderItem(bySection("identity")[0], ctx),
    `<div class="indicators" data-section="status">\n${bySection("status").map((i) => renderItem(i, ctx)).join("\n")}\n</div>`,
    `<div data-section="resume">\n${renderSectionItems(bySection("resume"), ctx)}\n</div>`,
    "</header>",
    "<main>",
    ...["terms", "notes", "legal", "projects", "help", "writing"].map(section),
    "</main>",
    `<footer data-section="footer">\n${renderSectionItems(bySection("footer"), ctx)}\n</footer>`,
  ].join("\n");

  const terms = manifest.items.find((i) => i.id === "terms");
  const termsText = plainText(read(terms.source));
  const termsHash = sha256(termsText);

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "verify"), { recursive: true });

  const page = (tpl, vars) => read(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
  fs.writeFileSync(path.join(DIST, "index.html"), page("src/template.html", { BODY: body }));
  fs.writeFileSync(
    path.join(DIST, "verify", "index.html"),
    page("src/verify.html", {
      HEADING: esc(heading("terms")),
      TERMS: renderBlocks(read(terms.source), { plain: true }),
      HASH: termsHash,
      EFFECTIVE: terms.effective,
    }),
  );
  fs.writeFileSync(path.join(DIST, "terms.txt"), termsText);
  fs.writeFileSync(path.join(DIST, "terms.sha256"), `${termsHash}  terms.txt\n`);

  fs.copyFileSync(path.join(ROOT, "src/styles.css"), path.join(DIST, "styles.css"));
  fs.cpSync(path.join(ROOT, "public"), DIST, { recursive: true });
  fs.cpSync(path.join(ROOT, "assets"), path.join(DIST, "assets"), { recursive: true });
  buildPrivateArea();
  return { manifest, termsText, termsHash };
}

// Files placed in legal/private/ publish under /legal/private/, behind Cloudflare Access.
function buildPrivateArea() {
  const src = path.join(ROOT, "legal/private");
  const dest = path.join(DIST, "legal/private");
  fs.mkdirSync(dest, { recursive: true });
  const files = fs.existsSync(src)
    ? fs.readdirSync(src).filter((f) => !f.startsWith(".") && f !== "index.html").sort()
    : [];
  for (const f of files) fs.cpSync(path.join(src, f), path.join(dest, f), { recursive: true });
  if (fs.existsSync(path.join(src, "index.html"))) {
    fs.copyFileSync(path.join(src, "index.html"), path.join(dest, "index.html"));
    return;
  }
  const list = files.length
    ? `<ul>\n${files.map((f) => `<li><a href="./${escAttr(encodeURIComponent(f))}">${esc(f)}</a></li>`).join("\n")}\n</ul>`
    : "<p>No documents have been placed here.</p>";
  fs.writeFileSync(path.join(dest, "index.html"), read("src/private.html").replace("{{LIST}}", list));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build();
  if (process.argv.includes("--write-locks")) {
    const { writeLocks } = await import("../checks/lib.mjs");
    writeLocks(ROOT);
  }
  console.log("build: dist/ written");
}
