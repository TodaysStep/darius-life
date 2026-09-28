// A tiny in-memory D1 substitute for tests — not a real SQL engine, just
// enough of INSERT/SELECT/UPDATE to run the handful of statement shapes
// bench-working.js and bench-entrusted.js actually emit. Deliberately
// generic (parses the SQL text) rather than one hardcoded branch per call
// site, so it stays correct if a statement's exact whitespace changes.
const norm = (sql) => sql.replace(/\s+/g, " ").trim();
const FAKE_NOW = "2026-09-28T12:00:00.000Z";

function evalCond(cond, row, args) {
  cond = cond.trim();
  let m;
  if ((m = cond.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i))) return row[m[1]] != null;
  if ((m = cond.match(/^(\w+)\s+IS\s+NULL$/i))) return row[m[1]] == null;
  if ((m = cond.match(/^(\w+)\s+IN\s+\(([^)]*)\)$/i))) {
    const n = m[2].split(",").length;
    const values = args.splice(0, n);
    return values.includes(row[m[1]]);
  }
  if ((m = cond.match(/^(\w+)\s*=\s*\?$/))) return row[m[1]] === args.shift();
  throw new Error(`fake-d1: unsupported WHERE condition "${cond}"`);
}

function evalWhere(where, row, args) {
  if (!where) return true;
  const tokens = where.split(/\s+(AND|OR)\s+/i);
  let result = evalCond(tokens[0], row, args);
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i].toUpperCase();
    const next = evalCond(tokens[i + 1], row, args);
    result = op === "AND" ? result && next : result || next;
  }
  return result;
}

function applyOrderBy(rows, orderBy) {
  if (!orderBy) return rows;
  const specs = orderBy.split(",").map((s) => {
    const parts = s.trim().replace(/\s+COLLATE\s+NOCASE/i, "").trim().split(/\s+/);
    return { col: parts[0], dir: (parts[1] || "ASC").toUpperCase(), nocase: /COLLATE\s+NOCASE/i.test(s) };
  });
  return [...rows].sort((a, b) => {
    for (const { col, dir, nocase } of specs) {
      let av = a[col], bv = b[col];
      if (nocase && typeof av === "string") av = av.toLowerCase();
      if (nocase && typeof bv === "string") bv = bv.toLowerCase();
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === "DESC" ? -cmp : cmp;
    }
    return 0;
  });
}

export function createFakeD1() {
  const tables = {
    cases: [], docket_entries: [], patterns: [], glossary_terms: [],
    documents: [], entrusted_notes: [], access_grants: [], ingest_items: [], document_recordings: [],
    resources: [], recording_documents: [], prep_sessions: [], scripture_verses: [], daily_verses: [],
  };

  // Every table but these is keyed by its own `id` primary key.
  // recording_documents is a plain many-to-many join table — composite key
  // (recording_id, document_id), no id column at all. daily_verses is
  // keyed by its own `date` instead — see the schema's own comment on it.
  const TABLES_WITHOUT_ID = new Set(["recording_documents", "daily_verses"]);

  function exec(sqlRaw, boundArgs) {
    const sql = norm(sqlRaw);
    const args = [...boundArgs];

    let m;
    if ((m = sql.match(/^INSERT(?: OR (REPLACE))? INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i))) {
      const [, replace, table, colsRaw] = m;
      const cols = colsRaw.split(",").map((c) => c.trim());
      const row = {};
      cols.forEach((c, i) => { row[c] = args[i]; });
      if (!("id" in row) && !TABLES_WITHOUT_ID.has(table)) throw new Error(`fake-d1: INSERT into ${table} missing id`);
      if (table === "cases") { row.status ??= "open"; row.created_at ??= FAKE_NOW; row.updated_at ??= FAKE_NOW; }
      if (table === "docket_entries") { row.source ??= "manual"; row.entry_kind ??= "note"; row.created_at ??= FAKE_NOW; row.updated_at ??= FAKE_NOW; }
      if (table === "patterns" || table === "glossary_terms") { row.created_at ??= FAKE_NOW; row.updated_at ??= FAKE_NOW; }
      if (table === "documents" || table === "entrusted_notes" || table === "access_grants" || table === "resources") row.created_at ??= FAKE_NOW;
      if (table === "documents") { row.shared_at ??= null; row.filing_status ??= "drafted"; }
      if (table === "document_recordings") row.content_type ??= "note";
      if (table === "access_grants") row.revoked_at ??= null;
      if (table === "prep_sessions") { row.case_id ??= null; row.event_date ??= null; row.context ??= null; row.pressure_test ??= null; row.pressure_test_updated_at ??= null; row.created_at ??= FAKE_NOW; row.updated_at ??= FAKE_NOW; }
      if (table === "scripture_verses" || table === "daily_verses") row.created_at ??= FAKE_NOW;
      if (replace) {
        // Only daily_verses actually uses OR REPLACE today — keyed by its
        // own `date` rather than `id`, same exception as TABLES_WITHOUT_ID.
        const keyCol = table === "daily_verses" ? "date" : "id";
        tables[table] = tables[table].filter((r) => r[keyCol] !== row[keyCol]);
      }
      tables[table].push(row);
      return { results: [], success: true };
    }

    if ((m = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/i))) {
      const [, table, setClause, where] = m;
      // '?' placeholders in SET come before those in WHERE, positionally.
      const setArgsNeeded = (setClause.match(/\?/g) || []).length;
      const setArgs = args.splice(0, setArgsNeeded);
      const whereArgs = args; // whatever's left belongs to WHERE
      const assignments = setClause.split(",").map((s) => {
        const [col, exprRaw] = s.split("=").map((x) => x.trim());
        return { col, expr: exprRaw };
      });
      let changes = 0;
      for (const row of tables[table]) {
        if (!evalWhere(where, row, [...whereArgs])) continue;
        let sIdx = 0;
        for (const { col, expr } of assignments) {
          if (expr === "NULL") row[col] = null;
          else if (expr === "?") row[col] = setArgs[sIdx++];
          else if (/^strftime\(/i.test(expr)) row[col] = FAKE_NOW;
          else row[col] = expr;
        }
        changes++;
      }
      return { results: [], success: true, meta: { changes } };
    }

    if ((m = sql.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (.+))?$/i))) {
      const [, , table, where, orderBy] = m;
      let rows = tables[table].filter((row) => evalWhere(where, row, [...args]));
      rows = applyOrderBy(rows, orderBy);
      return { results: rows, success: true };
    }

    if ((m = sql.match(/^DELETE FROM (\w+)(?: WHERE (.+))?$/i))) {
      const [, table, where] = m;
      const before = tables[table].length;
      tables[table] = tables[table].filter((row) => !evalWhere(where, row, [...args]));
      return { results: [], success: true, meta: { changes: before - tables[table].length } };
    }

    throw new Error(`fake-d1: unsupported statement: ${sql}`);
  }

  return {
    tables,
    BENCH_NOTES: {
      prepare(sql) {
        // D1's real API allows calling all()/first()/run() directly on a
        // prepared statement with no bind() at all (fine when the SQL has no
        // placeholders) — mirror that here, not just the bind()-then-call path.
        return {
          bind(...boundArgs) {
            return {
              all: async () => exec(sql, boundArgs),
              first: async () => exec(sql, boundArgs).results[0] ?? null,
              run: async () => exec(sql, boundArgs),
            };
          },
          all: async () => exec(sql, []),
          first: async () => exec(sql, []).results[0] ?? null,
          run: async () => exec(sql, []),
        };
      },
    },
  };
}
