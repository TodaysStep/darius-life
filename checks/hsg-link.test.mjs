import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const raw = fs.readFileSync("content/homepage-v2.json", "utf8");
const manifest = JSON.parse(raw);
const oldRaw = fs.readFileSync("content/manifest.json", "utf8");
const canonical = JSON.parse(oldRaw);
const doc = new JSDOM(fs.readFileSync("dist/index.html", "utf8")).window.document;
test("Approved V2 copy is hash-locked and all items appear once", () => {
  assert.equal(manifest.approval, "Sentinel_be2a652d2dec8191ad2952e3c8418f9a");
  assert.equal(sha(raw) + "\n", fs.readFileSync("homepage-v2.lock", "utf8"));
  for (const item of manifest.items) assert.equal(doc.querySelectorAll(`[data-id="${item.id}"]`).length, 1, item.id);
  assert.ok(doc.body.textContent.includes("I lead the work personally."));
  assert.ok(!doc.body.textContent.includes("HOW TO USE DARIUS.LIFE"));
  assert.equal(doc.querySelector('a[href*="recommendations"]'), null);
});
test("Canonical policy source and status data remain independent of the new homepage", () => {
  assert.equal(sha(oldRaw) + "\n", fs.readFileSync("manifest.lock", "utf8"));
  const hsg = canonical.items.find(x => x.id === "status.hsg");
  assert.equal(hsg.href ?? hsg.text, "[Human Stewardship Guidelines](https://humansteward.org/)");
  assert.equal(JSON.parse(fs.readFileSync("data/status.json", "utf8")).personal, "Focused on a build, not available for check-ins.");
  assert.equal(sha(fs.readFileSync("dist/terms.txt", "utf8")) + "\n", fs.readFileSync("terms.lock", "utf8"));
  for (const [label, href] of [["My résumé", "/resume/"], ["My Flight Plan", "/flight-plan/"], ["My thesis", "https://posterityos.com/posterity/1.0/en/contents"]]) {
    assert.equal([...doc.querySelectorAll("a")].find(a => a.textContent === label)?.getAttribute("href"), href);
  }
});
