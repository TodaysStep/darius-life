import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

// These exercise routing only — handleBenchGet/Post/Put each independently
// verify Access (see bench-working.test.mjs), so a plain unauthenticated
// request that reaches one of them here is enough to prove it was actually
// dispatched, without needing a real token.
const env = {};

test("root serves generic Bench Notes identity without private data or automatic Access redirect", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  const html = await res.text();
  assert.match(html, /Bench Notes — Confidential Access/);
  assert.match(html, /href="\/bench\/"/);
  assert.match(html, /bench-frontdoor.css/);
});
test("same-origin stylesheet is public but contains only generic presentation", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/bench-frontdoor.css"), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/css/);
  assert.match(await res.text(), /#E9E0CC/);
});

test("GET /bench/ is dispatched to the working-side handler (forbidden with no Access token, not 404)", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/bench/"), env);
  assert.equal(res.status, 403);
});

test("POST /bench/ is dispatched too", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/bench/", { method: "POST", body: "x" }), env);
  assert.equal(res.status, 403);
});

test("PUT /bench/blobs/:id is dispatched too — the streaming upload route", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/bench/blobs/x", { method: "PUT", body: "x" }), env);
  assert.equal(res.status, 403);
});

test("an unsupported method under /bench/ is 405, not 404", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/bench/", { method: "DELETE" }), env);
  assert.equal(res.status, 405);
});

test("a genuinely unknown path outside /bench/ (not just the bare root) is a real 404, not silently redirected", async () => {
  const res = await worker.fetch(new Request("https://confidential.darius.life/something-else"), env);
  assert.equal(res.status, 404);
});

