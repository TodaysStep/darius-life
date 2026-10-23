import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { JSDOM } from "jsdom";

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const manifest = JSON.parse(fs.readFileSync("content/manifest.json", "utf8"));
const allowed = JSON.parse(fs.readFileSync("checks/allowlist.json", "utf8"));
const html = fs.readFileSync("dist/index.html", "utf8");
const dom = new JSDOM(html).window.document;
const id = "status.hsg";
const status = manifest.items.filter(x=>x.section==="status");
test("The exact link follows, and never replaces, the personal status boundary", () => {
 const p=status.findIndex(x=>x.id==="status.line");
 assert.equal(status[p+1]?.id,id);
 assert.equal(dom.querySelector('[data-id="status.line"]')?.nextElementSibling?.getAttribute("data-id"),id);
 const a=dom.querySelector('[data-id="status.hsg"] a');
 assert.equal(a?.getAttribute("href"),"https://humansteward.org/");
 assert.equal(a?.textContent,"Human Stewardship Guidelines");
 assert.equal(dom.querySelectorAll('a[href="https://humansteward.org/"]').length,1);
});
test("The public document remains hash-locked, allowed, and independent of private status",()=>{
 const raw=fs.readFileSync("content/manifest.json","utf8");
 assert.equal(sha(raw)+"\n",fs.readFileSync("manifest.lock","utf8"));
 assert.equal(status.find(x=>x.id===id)?.sha256,sha("Human Stewardship Guidelines"));
 assert.ok(allowed.index.includes("https://humansteward.org/"));
 assert.equal(manifest.items.filter(x=>x.id===id).length,1);
 assert.equal(dom.querySelector('[data-id="status.personal"] [data-dynamic="status"]')?.textContent,"Focused on a build, not available for check-ins.");
});
