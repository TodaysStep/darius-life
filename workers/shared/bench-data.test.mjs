import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrCreateCaseByNumber } from "./bench-data.js";
import { createFakeD1 } from "./test-fake-d1.mjs";

test("a case number matching an existing case attaches to it, never creating a second one", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: "26FDV03796", status: "open", created_at: "t", updated_at: "t" });

  const found = await findOrCreateCaseByNumber(BENCH_NOTES, "26FDV03796", "would-be-new-id");
  assert.equal(found.id, "case-1");
  assert.equal(tables.cases.length, 1);
});

test("an unrecognized case number creates a new case titled from that number", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  const created = await findOrCreateCaseByNumber(BENCH_NOTES, "26FDV03796", "new-id");
  assert.equal(created.id, "new-id");
  assert.equal(tables.cases.length, 1);
  assert.equal(tables.cases[0].case_number, "26FDV03796");
  assert.equal(tables.cases[0].title, "Case 26FDV03796");
});

test("no case number at all creates a new, dated, untitled case rather than guessing", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  const created = await findOrCreateCaseByNumber(BENCH_NOTES, null, "new-id");
  assert.equal(tables.cases.length, 1);
  assert.equal(tables.cases[0].case_number, null);
  assert.match(created.title, /^Untitled — \d{4}-\d{2}-\d{2}$/);
});

test("two uploads with no case number each get their own case, never silently merged", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await findOrCreateCaseByNumber(BENCH_NOTES, null, "id-1");
  await findOrCreateCaseByNumber(BENCH_NOTES, null, "id-2");
  assert.equal(tables.cases.length, 2);
});
