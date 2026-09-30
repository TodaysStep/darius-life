// Scoped machine seam for the Publishing Desk. Legacy BENCH_API_KEY is never
// accepted here. Tokens and their SHA-256 hashes are provisioned server-side.
import { sha256Hex } from "../../shared/bench-crypto.js";

const ROOT = "/bench/api/v2/";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
});
class Refusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new Refusal(status, code, message); };
const statement = (db, sql, ...values) => db.prepare(sql).bind(...values);
const first = (db, sql, ...values) => statement(db, sql, ...values).first();
const all = async (db, sql, ...values) => (await statement(db, sql, ...values).all()).results;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const fingerprint = value => sha256Hex(JSON.stringify(canonical(value)));
function text(value, field, max = 100000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) refuse(400, "invalid_request", field + " is required and must fit its length limit.");
  return value;
}
function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) refuse(400, "invalid_request", "Unexpected request fields.");
}
function ids(value, field) {
  if (!Array.isArray(value) || !value.length || value.length > 50 || value.some(v => typeof v !== "string" || !/^[\w-]{1,100}$/.test(v)) || new Set(value).size !== value.length) refuse(400, "invalid_request", field + " must name distinct IDs.");
  return [...value].sort();
}

async function authenticate(request, env) {
  const token = (request.headers.get("authorization") || "").match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token) refuse(401, "unauthorized", "A scoped Bench Notes credential is required.");
  let principals;
  try { principals = JSON.parse(env.BENCH_DESK_PRINCIPALS || "[]"); }
  catch { refuse(503, "configuration_unavailable", "Bench Notes credentials are not configured."); }
  if (!Array.isArray(principals)) refuse(503, "configuration_unavailable", "Bench Notes credentials are not configured.");
  const hash = await sha256Hex(token);
  const principal = principals.find(p => p.token_sha256 === hash && !p.revoked_at && Number.isFinite(Date.parse(p.expires_at)) && Date.parse(p.expires_at) > Date.now());
  if (!principal || typeof principal.id !== "string" || typeof principal.actor_id !== "string" || typeof principal.sender_name !== "string" || !Array.isArray(principal.scopes) || !Array.isArray(principal.case_ids)) refuse(401, "unauthorized", "Credential is invalid, expired or revoked.");
  // The caller cannot substitute a sender or another founder.
  if (!env.BENCH_DESK_OWNER_ID || principal.actor_id !== env.BENCH_DESK_OWNER_ID || request.headers.get("x-bench-actor") !== principal.actor_id) refuse(403, "actor_mismatch", "Only the configured Bench Notes owner may use this connection.");
  return principal;
}
function authorize(p, action, caseId) {
  if (!p.scopes.includes(action)) refuse(403, "forbidden_scope", "Credential does not permit this operation.");
  if (caseId && !p.case_ids.includes(caseId)) refuse(403, "forbidden_case", "This case is outside the credential's scope.");
}
async function getCase(db, p, caseId) {
  authorize(p, "cases.read", caseId);
  const row = await first(db, "SELECT id, title, court, case_number FROM cases WHERE id = ?", caseId);
  if (!row) refuse(404, "not_found", "Case not found.");
  return row;
}
async function audience(db, caseId, grantIds) {
  const placeholders = grantIds.map(() => "?").join(",");
  const grants = await all(db, `SELECT id, label, case_ids_json, revoked_at FROM access_grants WHERE id IN (${placeholders})`, ...grantIds);
  return grantIds.map(id => {
    const g = grants.find(row => row.id === id);
    if (!g || g.revoked_at || !JSON.parse(g.case_ids_json || "[]").includes(caseId)) refuse(409, "audience_unavailable", "An intended reader no longer has access to this case.");
    return { id: g.id, label: g.label || g.id };
  });
}

function audit(db, p, action, target, digest, now) {
  return statement(db, "INSERT INTO bench_desk_audit (id, principal_id, actor_id, action, target_id, request_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), p.id, p.actor_id, action, target, digest, now);
}
async function priorOperation(db, p, operationId, digest) {
  const old = await first(db, "SELECT request_digest, response_json, response_status FROM bench_desk_operations WHERE principal_id = ? AND operation_id = ?", p.id, operationId);
  if (!old) return null;
  if (old.request_digest !== digest) refuse(409, "idempotency_conflict", "This operation ID already names a different request.");
  return json(JSON.parse(old.response_json), old.response_status);
}
async function commit(db, p, action, body, digest, writes, payload, target, status = 200) {
  const now = new Date().toISOString();
  try {
    // D1 batch is atomic: mutation, retry result and audit either all commit or
    // all roll back. A losing concurrent retry reads the winning response.
    await db.batch([
      statement(db, "INSERT INTO bench_desk_operations (principal_id, operation_id, request_digest, response_json, response_status, created_at) VALUES (?, ?, ?, ?, ?, ?)", p.id, body.operation_id, digest, JSON.stringify(payload), status, now),
      ...writes, audit(db, p, action, target, digest, now),
    ]);
  } catch (error) {
    const prior = await priorOperation(db, p, body.operation_id, digest);
    if (prior) return prior;
    // A different operation may have released/withdrawn this same edition.
    if (action === "updates.share" || action === "updates.withdraw") {
      const existing = await first(db, action === "updates.share" ? "SELECT shared_at FROM bench_desk_releases WHERE update_id = ?" : "SELECT withdrawn_at FROM bench_desk_withdrawals WHERE update_id = ?", target);
      if (existing) refuse(409, "state_changed", "The note changed during this request. Read its current state before retrying.");
    }
    throw error;
  }
  return json(payload, status);
}
async function updateRead(db, p, id) {
  const row = await first(db, "SELECT * FROM bench_desk_updates WHERE id = ?", id);
  if (!row) refuse(404, "not_found", "Bench Note not found.");
  if (!p.case_ids.includes(row.case_id) || row.actor_id !== p.actor_id) refuse(403, "forbidden_case", "This note is outside the credential's scope.");
  const release = await first(db, "SELECT shared_at FROM bench_desk_releases WHERE update_id = ?", id);
  const withdrawal = await first(db, "SELECT withdrawn_at FROM bench_desk_withdrawals WHERE update_id = ?", id);
  return { id: row.id, case_id: row.case_id, case_label: row.case_label, sender_name: row.sender_name, subject: row.subject, change_summary: row.change_summary, body: row.body,
    audience: JSON.parse(row.audience_json), digest: row.digest, created_at: row.created_at,
    state: withdrawal ? "withdrawn" : release ? "shared" : "prepared", shared_at: release?.shared_at || null, withdrawn_at: withdrawal?.withdrawn_at || null,
    reading_url: "https://confidential.darius.life/entrusted/#bench-note-" + row.id };
}

export async function handleBenchDeskApi(request, env, url) {
  try {
    const p = await authenticate(request, env);
    const db = env.BENCH_NOTES;
    const path = url.pathname.slice(ROOT.length);
    if (request.method === "GET") {
      let payload;
      if (path === "cases") {
        authorize(p, "cases.read");
        const rows = await all(db, "SELECT id, title, court, case_number FROM cases ORDER BY created_at DESC");
        payload = { cases: rows.filter(c => p.case_ids.includes(c.id)) };
      } else if (/^cases\/[\w-]+\/audience$/.test(path)) {
        const caseId = path.split("/")[1];
        await getCase(db, p, caseId);
        const rows = await all(db, "SELECT id, label, case_ids_json, revoked_at FROM access_grants WHERE revoked_at IS NULL");
        payload = { case_id: caseId, audience: rows.filter(g => JSON.parse(g.case_ids_json || "[]").includes(caseId)).map(g => ({ id: g.id, label: g.label || g.id })) };
      } else if (/^updates\/[\w-]+$/.test(path)) {
        authorize(p, "updates.read");
        payload = await updateRead(db, p, path.split("/")[1]);
      } else refuse(404, "not_found", "Operation not found.");
      await audit(db, p, "read." + path.split("/")[0], payload.id || payload.case_id || null, null, new Date().toISOString()).run();
      return json(payload);
    }
    if (request.method !== "POST") refuse(405, "method_not_allowed", "Use the declared operation method.");
    // Bound streaming input, including chunked requests, before JSON parsing.
    const reader = request.body?.getReader();
    if (!reader) refuse(400, "invalid_request", "A JSON body is required.");
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 120000) { await reader.cancel(); refuse(413, "request_too_large", "Bench Note exceeds the request limit."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { refuse(400, "invalid_request", "Body must be valid JSON."); }
    const action = path === "updates" ? "updates.prepare" : /^updates\/[\w-]+\/share$/.test(path) ? "updates.share" : /^updates\/[\w-]+\/withdraw$/.test(path) ? "updates.withdraw" : null;
    if (!action) refuse(404, "not_found", "Operation not found.");
    authorize(p, action);
    text(body?.operation_id, "operation_id", 100);
    const digest = await fingerprint({ action, path, body });
    // Scope and current audience checks precede replay: revocation is immediate.
    if (action === "updates.prepare") {
      fields(body, ["operation_id", "case_id", "subject", "change_summary", "body", "audience_ids"]);
      const caseRow = await getCase(db, p, text(body.case_id, "case_id", 100));
      const subject = text(body.subject, "subject", 300);
      const summary = text(body.change_summary, "change_summary", 2000);
      const content = text(body.body, "body", 100000);
      const readers = await audience(db, caseRow.id, ids(body.audience_ids, "audience_ids"));
      const prior = await priorOperation(db, p, body.operation_id, digest); if (prior) return prior;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const edition = { id, case_id: caseRow.id, case_label: caseRow.title, actor_id: p.actor_id, sender_name: p.sender_name, subject, change_summary: summary, body: content, audience: readers, created_at: now };
      const editionDigest = await fingerprint(edition);
      return await commit(db, p, action, body, digest, [
        statement(db, "INSERT INTO bench_desk_updates (id, case_id, case_label, actor_id, sender_name, subject, change_summary, body, audience_json, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, caseRow.id, caseRow.title, p.actor_id, p.sender_name, subject, summary, content, JSON.stringify(readers), editionDigest, now),
      ], { ...edition, digest: editionDigest, state: "prepared", approval_required: true }, id, 201);
    }
    fields(body, ["operation_id", "digest", "approved_subject", "approved_audience_ids", "founder_words"]);
    const id = path.split("/")[1];
    const edition = await updateRead(db, p, id);
    const readers = await audience(db, edition.case_id, edition.audience.map(g => g.id));
    if (JSON.stringify(readers) !== JSON.stringify(edition.audience)) refuse(409, "audience_changed", "Reader details changed. Prepare a new note for review.");
    const approvedIds = ids(body.approved_audience_ids, "approved_audience_ids");
    if (body.digest !== edition.digest || body.approved_subject !== edition.subject || JSON.stringify(approvedIds) !== JSON.stringify(edition.audience.map(g => g.id).sort())) refuse(409, "approval_mismatch", "Approval must name this exact note, digest and audience.");
    text(body.founder_words, "founder_words", 2000);
    const prior = await priorOperation(db, p, body.operation_id, digest); if (prior) return prior;
    if (action === "updates.share") {
      if (edition.state === "withdrawn") refuse(409, "withdrawn", "A withdrawn note cannot be shared again. Prepare a new note.");
      const now = edition.shared_at || new Date().toISOString();
      const writes = edition.state === "shared" ? [] : [
        statement(db, "INSERT INTO bench_desk_releases (update_id, actor_id, shared_at, approval_json) VALUES (?, ?, ?, ?)", id, p.actor_id, now, JSON.stringify(body)),
      ];
      return await commit(db, p, action, body, digest, writes, { update_id: id, digest: edition.digest, state: "shared", shared_at: now, audience: edition.audience,
        reading_url: edition.reading_url, delivery: "made_available_to_named_readers", notifications_sent: false, read_receipt: null }, id);
    }
    if (edition.state === "prepared") refuse(409, "not_shared", "This note has not been shared.");
    const now = edition.withdrawn_at || new Date().toISOString();
    const writes = edition.state === "withdrawn" ? [] : [
      statement(db, "INSERT INTO bench_desk_withdrawals (update_id, actor_id, withdrawn_at) VALUES (?, ?, ?)", id, p.actor_id, now),
    ];
    return await commit(db, p, action, body, digest, writes, { update_id: id, digest: edition.digest, state: "withdrawn", withdrawn_at: now }, id);
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.code, message: error.message }, error.status);
    // Neither SQL diagnostics nor credential configuration reach the caller.
    console.error("bench-desk-api request failed");
    return json({ error: "unavailable", message: "Bench Notes could not complete this operation. No success is confirmed." }, 503);
  }
}
