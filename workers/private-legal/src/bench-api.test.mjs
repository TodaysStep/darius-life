import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBenchApi } from "./bench-api.js";
import { createFakeD1 } from "../../shared/test-fake-d1.mjs";

const API_KEY = "test-bench-api-key";

function setup() {
  const fakeD1 = createFakeD1();
  return { env: { BENCH_API_KEY: API_KEY, BENCH_NOTES: fakeD1.BENCH_NOTES }, fakeD1 };
}

const apiRequest = (path, { method = "GET", key = API_KEY, body } = {}) =>
  new Request(`https://darius.life/bench/api/${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const call = (env, path, opts) => handleBenchApi(apiRequest(path, opts), env, new URL(`https://darius.life/bench/api/${path}`));

test("a request with no bearer token, or the wrong one, is unauthorized and touches nothing", async () => {
  const { env, fakeD1 } = setup();
  const noAuth = await handleBenchApi(new Request("https://darius.life/bench/api/cases"), env, new URL("https://darius.life/bench/api/cases"));
  assert.equal(noAuth.status, 401);
  const wrongAuth = await call(env, "cases", { key: "wrong-key" });
  assert.equal(wrongAuth.status, 401);
  assert.equal(fakeD1.tables.cases.length, 0);
});

test("publishing a case, an entry, and a document lands directly in the D1 tables the UI reads", async () => {
  const { env, fakeD1 } = setup();
  const caseRes = await call(env, "cases", { method: "POST", body: { title: "Family matter", court: "Superior Court" } });
  assert.equal(caseRes.status, 201);
  const { id: caseId } = await caseRes.json();
  assert.equal(fakeD1.tables.cases[0].title, "Family matter");

  const entryRes = await call(env, `cases/${caseId}/entries`, { method: "POST", body: { entryDate: "2026-09-28", fact: "Hearing held.", commentary: "Private note." } });
  assert.equal(entryRes.status, 201);
  const { id: entryId } = await entryRes.json();
  assert.equal(fakeD1.tables.docket_entries[0].fact, "Hearing held.");
  assert.equal(fakeD1.tables.docket_entries[0].case_label, "Family matter");

  const docRes = await call(env, `cases/${caseId}/documents`, { method: "POST", body: { title: "Motion PDF", storageRef: "https://example.com/motion", entryId } });
  assert.equal(docRes.status, 201);
  assert.equal(fakeD1.tables.documents[0].entry_id, entryId);
});

test("a document whose storageRef is not an http(s) address is refused, not stored", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });
  const res = await call(env, "cases/case-1/documents", { method: "POST", body: { title: "Motion", storageRef: "javascript:alert(1)" } });
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.documents.length, 0);
});

test("an internal error never echoes the raw exception message back to the caller", async () => {
  const { env, fakeD1 } = setup();
  // Force ops.ts-style breakage: a case row missing the column addEntry needs.
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter" });
  const brokenDb = { ...env.BENCH_NOTES, prepare: () => { throw new Error("no such column: case_label_typo"); } };
  const res = await handleBenchApi(apiRequest("cases/case-1/entries", { method: "POST", body: { entryDate: "2026-09-28", fact: "F" } }), { ...env, BENCH_NOTES: brokenDb }, new URL("https://darius.life/bench/api/cases/case-1/entries"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "internal_error");
  assert.ok(!JSON.stringify(body).includes("case_label_typo"));
});

test("sharing an entry through the API sets shared_at, same as the human toggle would", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "X", entry_date: "2026-09-28", fact: "F", shared_at: null, source: "manual" });
  const res = await call(env, "entries/entry-1/share", { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.ok(fakeD1.tables.docket_entries[0].shared_at);
});

test("creating a guest grant through the API hashes the passphrase and never stores it raw", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });
  const res = await call(env, "grants", { method: "POST", body: { passphrase: "a-real-passphrase", caseIds: ["case-1"], label: "Attorney" } });
  assert.equal(res.status, 201);
  const grant = fakeD1.tables.access_grants[0];
  assert.notEqual(grant.code_hash, "a-real-passphrase");
  assert.ok(!("passphrase" in grant));
});

test("a malformed JSON body is a 400, not a 500, and writes nothing", async () => {
  const { env, fakeD1 } = setup();
  const req = new Request("https://darius.life/bench/api/cases", { method: "POST", headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: "{not json" });
  const res = await handleBenchApi(req, env, new URL("https://darius.life/bench/api/cases"));
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.cases.length, 0);
});

test("an unknown route under the prefix is a 404", async () => {
  const { env } = setup();
  const res = await call(env, "not-a-real-route");
  assert.equal(res.status, 404);
});
