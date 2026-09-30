import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBenchApi } from "./bench-api.js";
import { createFakeD1 } from "../../shared/test-fake-d1.mjs";
test("legacy missing/wrong credentials touch nothing; owner-held legacy key can still read", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  const env = { BENCH_API_KEY: "test-key", BENCH_NOTES };
  const url = new URL("https://darius.life/bench/api/cases");
  for (const key of [null, "wrong"]) {
    const r = await handleBenchApi(new Request(url, { headers: key ? { authorization: "Bearer " + key } : {} }), env, url);
    assert.equal(r.status, 401);
  }
  const r = await handleBenchApi(new Request(url, { headers: { authorization: "Bearer test-key" } }), env, url);
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).cases, []); assert.equal(tables.cases.length, 0);
});
test("legacy writes cannot bypass scoped identity, approval, audit or retries", async () => {
  const { BENCH_NOTES, tables } = createFakeD1(); const env = { BENCH_API_KEY: "test-key", BENCH_NOTES };
  for (const path of ["cases", "cases/case-1/notes", "entries/entry-1/share", "grants", "grants/grant-1/revoke"]) {
    const url = new URL("https://darius.life/bench/api/" + path);
    const r = await handleBenchApi(new Request(url, { method: "POST", headers: { authorization: "Bearer test-key" }, body: "{}" }), env, url);
    assert.equal(r.status, 410);
  }
  assert.equal(tables.cases.length, 0); assert.equal(tables.entrusted_notes.length, 0); assert.equal(tables.access_grants.length, 0);
});
