// Shared by the checks and by `npm run lock`. Text is extracted from the built HTML,
// independently of how src/build.mjs produced it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";

export const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

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
