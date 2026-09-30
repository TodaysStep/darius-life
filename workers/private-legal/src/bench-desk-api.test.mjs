import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqliteD1 } from "../../shared/test-sqlite-d1.mjs";
import { sha256Hex, signSession } from "../../shared/bench-crypto.js";
import { handleBenchApi } from "./bench-api.js";
import { listDeskUpdates, renderDeskUpdates } from "../../shared/bench-entrusted-view.js";
import { handleBenchEntrustedGet } from "../../confidential/src/bench-entrusted.js";
const OWNER = "owner-user", KEY = "test-scoped-secret";
async function setup(scopes = ["cases.read", "updates.read", "updates.prepare", "updates.share", "updates.withdraw"]) {
  const db = createSqliteD1();
  db.sqlite.exec("INSERT INTO cases (id,title) VALUES ('case-1','Family matter'),('case-2','Other case')");
  db.sqlite.prepare("INSERT INTO access_grants (id,code_hash,case_ids_json,label) VALUES (?,?,?,?)").run("grant-a","hash-a",'["case-1"]',"Reader A");
  db.sqlite.prepare("INSERT INTO access_grants (id,code_hash,case_ids_json,label) VALUES (?,?,?,?)").run("grant-b","hash-b",'["case-1"]',"Reader B");
  const env = { BENCH_NOTES: db.BENCH_NOTES, BENCH_DESK_OWNER_ID: OWNER, BENCH_API_KEY: "legacy", ENTRUSTED_COOKIE_SECRET: "test-cookie",
    BENCH_DESK_PRINCIPALS: JSON.stringify([{ id: "desk", actor_id: OWNER, sender_name: "Michael Darius", token_sha256: await sha256Hex(KEY), scopes, case_ids: ["case-1"], expires_at: "2099-01-01T00:00:00Z" }]) };
  return { ...db, env };
}
function call(env, path, body, actor = OWNER, key = KEY) {
  const url = new URL("https://darius.life/bench/api/v2/" + path);
  return handleBenchApi(new Request(url, { method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + key, "x-bench-actor": actor, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) }), env, url);
}
const note = { operation_id: "prepare-1", case_id: "case-1", subject: "Hearing date confirmed", change_summary: "The next date is now on the record.", body: "The full update.\n\nNo response is required.", audience_ids: ["grant-a"] };
async function prepared(env) { const r = await call(env, "updates", note); assert.equal(r.status, 201); return r.json(); }
const approval = e => ({ operation_id: "share-1", digest: e.digest, approved_subject: e.subject, approved_audience_ids: ["grant-a"], founder_words: "Share this exact note with Reader A." });
test("credentials are scoped, owner-bound, expiring and fail closed before any write", async () => {
  const { env, sqlite } = await setup(["cases.read"]);
  assert.equal((await call(env, "updates", note)).status, 403);
  assert.equal((await call(env, "cases", undefined, "other-user")).status, 403);
  assert.equal((await call(env, "cases", undefined, OWNER, "legacy")).status, 401);
  const principal = JSON.parse(env.BENCH_DESK_PRINCIPALS); principal[0].expires_at = "2020-01-01"; env.BENCH_DESK_PRINCIPALS = JSON.stringify(principal);
  assert.equal((await call(env, "cases")).status, 401);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_updates").get().n, 0);
});
test("read lists expose only configured cases and audience labels, never passphrase hashes", async () => {
  const { env } = await setup();
  const cases = await (await call(env, "cases")).json();
  assert.deepEqual(cases.cases.map(c => c.id), ["case-1"]);
  const readers = await (await call(env, "cases/case-1/audience")).json();
  assert.equal(readers.audience.length, 2);
  assert.doesNotMatch(JSON.stringify(readers), /hash-a|code_hash|case_ids_json/);
  assert.equal((await call(env, "cases/case-2/audience")).status, 403);
});
test("preparing preserves the full original, is idempotent, and exposes nothing to guests", async () => {
  const { env, sqlite } = await setup();
  const e = await prepared(env);
  assert.equal(e.body, note.body); assert.equal(e.state, "prepared");
  const again = await (await call(env, "updates", note)).json(); assert.equal(again.id, e.id);
  assert.equal((await call(env, "updates", { ...note, body: "Changed" })).status, 409);
  assert.equal((await listDeskUpdates(env.BENCH_NOTES, ["case-1"], "grant-a")).length, 0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_audit").get().n, 1);
  assert.throws(() => sqlite.prepare("UPDATE bench_desk_updates SET body='changed'").run(), /immutable_update/);
});
test("sharing requires exact edition and audience approval; only named guests receive it", async () => {
  const { env, sqlite } = await setup(); const e = await prepared(env);
  assert.equal((await call(env, "updates/" + e.id + "/share", { ...approval(e), approved_audience_ids: ["grant-b"] })).status, 409);
  assert.equal((await call(env, "updates/" + e.id + "/share", { ...approval(e), digest: "bad" })).status, 409);
  const first = await (await call(env, "updates/" + e.id + "/share", approval(e))).json();
  const again = await (await call(env, "updates/" + e.id + "/share", approval(e))).json();
  assert.deepEqual(again, first);
  assert.equal(first.notifications_sent, false); assert.equal(first.read_receipt, null);
  assert.equal((await listDeskUpdates(env.BENCH_NOTES, ["case-1"], "grant-a")).length, 1);
  assert.equal((await listDeskUpdates(env.BENCH_NOTES, ["case-1"], "grant-b")).length, 0);
  assert.equal((await listDeskUpdates(env.BENCH_NOTES, ["case-2"], "grant-a")).length, 0);
  const token = await signSession({ gid: "grant-a" }, env.ENTRUSTED_COOKIE_SECRET, 3600);
  const url = new URL("https://confidential.darius.life/entrusted/");
  const page = await handleBenchEntrustedGet(new Request(url, { headers: { cookie: "bench_entrusted_session=" + token } }), env, url);
  const html = await page.text();
  assert.match(html, /A Bench Note for you/); assert.match(html, /Hearing date confirmed/);
  assert.match(html, /Michael Darius/); assert.match(html, /What changed/);
  sqlite.prepare("UPDATE access_grants SET revoked_at='now' WHERE id='grant-a'").run();
  const revoked = await handleBenchEntrustedGet(new Request(url, { headers: { cookie: "bench_entrusted_session=" + token } }), env, url);
  assert.doesNotMatch(await revoked.text(), /Hearing date confirmed/);
});
test("audience changes invalidate approval, including retries of a completed share", async () => {
  const { env, sqlite } = await setup(); const e = await prepared(env);
  sqlite.prepare("UPDATE access_grants SET case_ids_json='[]' WHERE id='grant-a'").run();
  assert.equal((await call(env, "updates/" + e.id + "/share", approval(e))).status, 409);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_releases").get().n, 0);
});
test("withdraw removes availability but retains the original, release and audit", async () => {
  const { env, sqlite } = await setup(); const e = await prepared(env);
  await call(env, "updates/" + e.id + "/share", approval(e));
  const r = await call(env, "updates/" + e.id + "/withdraw", { ...approval(e), operation_id: "withdraw-1", founder_words: "Withdraw this exact note." });
  assert.equal(r.status, 200);
  assert.equal((await listDeskUpdates(env.BENCH_NOTES, ["case-1"], "grant-a")).length, 0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_updates").get().n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_releases").get().n, 1);
  assert.equal((await call(env, "updates/" + e.id + "/share", { ...approval(e), operation_id: "share-new" })).status, 409);
});
test("audit failure rolls back note and retry ledger together", async () => {
  const { env, sqlite } = await setup();
  sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON bench_desk_audit BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.equal((await call(env, "updates", note)).status, 503);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_updates").get().n, 0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM bench_desk_operations").get().n, 0);
});
test("recipient presentation escapes supplied text and has no tracking or forced response", () => {
  const html = renderDeskUpdates([{ id: "note-1", subject: "<script>alert(1)</script>", sender_name: "<img>", case_label: "Case", change_summary: "A & B", body: "<b>original</b>", shared_at: "2026-09-30T14:00:00.000Z" }]);
  assert.doesNotMatch(html, /<script|<img|<b>/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /read.receipt|Mark.*read|Reply|required/);
});
test("legacy write credential no longer provides an alternate sharing door", async () => {
  const { env } = await setup(); const url = new URL("https://darius.life/bench/api/cases/case-1/notes");
  const r = await handleBenchApi(new Request(url, { method: "POST", headers: { authorization: "Bearer legacy" }, body: JSON.stringify({ body: "not approved" }) }), env, url);
  assert.equal(r.status, 410);
});
