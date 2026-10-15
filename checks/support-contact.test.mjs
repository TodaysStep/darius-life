import assert from "node:assert/strict";
import test from "node:test";
import { privacyScanText, SUPPORT_PATH, SUPPORT_RECIPIENT } from "./support-contact.mjs";

const page = `<a class="support" href="${SUPPORT_RECIPIENT}">Support with Apple Cash</a>`;
const number = SUPPORT_RECIPIENT.slice(5);
test("only the one published support destination is excluded from the privacy scan", () => {
  assert.ok(!privacyScanText(SUPPORT_PATH, page).includes(number));
  assert.ok(privacyScanText("dist/index.html", page).includes(number));
  assert.ok(privacyScanText(SUPPORT_PATH, page + `<p>${number}</p>`).includes(number));
  assert.ok(privacyScanText(SUPPORT_PATH, page + page).includes(number));
  assert.ok(privacyScanText(SUPPORT_PATH, page.replace(number, "+19995550101")).includes("+19995550101"));
  assert.ok(privacyScanText(SUPPORT_PATH, page + "<p>PRIVATE ADDRESS SENTINEL</p>").includes("PRIVATE ADDRESS SENTINEL"));
});
