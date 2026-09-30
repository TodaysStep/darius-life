// Real SQLite statements and transactions, exposed with D1's test-time shape.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function createSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("./schema/bench-notes.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("./schema/bench-desk.sql", import.meta.url), "utf8"));
  const wrap = (sql, values = []) => ({
    bind: (...args) => wrap(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
  });
  return { sqlite, BENCH_NOTES: {
    prepare: sql => wrap(sql),
    batch: async statements => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } };
}
