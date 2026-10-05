// Router for confidential.darius.life — the pre-existing, dashboard-created
// Access application ("confidential legal area") gates this Worker's entire
// production/preview URL, at the edge, before any request reaches this code.
// bench-working.js still independently re-verifies the Access JWT itself
// (see src/shared/access.js) — belt and suspenders, same as every other
// gated route in this repo, even though Access has already checked once.
//
// One hostname, two sections, deliberately separate modules:
//   /bench/*     Darius's own working docket — Access-gated and independently
//                JWT-verified (bench-working.js).
//   /entrusted/* everybody else — a passphrase per grant, no Access identity
//                (bench-entrusted.js). It is its own complete authentication
//                boundary, so the Access application must cover /bench/* only,
//                not this whole hostname/Worker (see docs/cloudflare-setup.md).
import { PREFIX as ENTRUSTED_PREFIX, handleBenchEntrustedGet, handleBenchEntrustedPost } from "./bench-entrusted.js";
import { PREFIX as BENCH_PREFIX, handleBenchGet, handleBenchPost, handleBenchPut } from "./bench-working.js";
import { handleEvidenceRoom } from './bench-evidence-room.js';
import { handleEvidenceApi } from './bench-evidence-api.js';
import { acceptEvidenceEmail, runEvidenceJobs } from '../../shared/bench-evidence.js';
import { queueEvidenceReceipt, runEvidenceReceipts } from '../../shared/bench-evidence-receipts.js';

export default {
  async email(message, env, ctx) {
    const accepted = await acceptEvidenceEmail(message, env);
    if (!accepted.id || accepted.state === 'quarantined') return;
    const automated=message.headers.get('Auto-Submitted');
    if(!automated || automated.toLowerCase()==='no') await queueEvidenceReceipt(env,accepted.id);
    ctx.waitUntil((async()=>{
      await runEvidenceJobs(env,{limit:1});
      await runEvidenceReceipts(env,{limit:2});
    })());
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async()=>{
      await runEvidenceJobs(env,{limit:2});
      await runEvidenceReceipts(env,{limit:2});
    })());
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/evidence-api/')) return handleEvidenceApi(request, env, url);
    if (url.pathname === '/bench/evidence' || url.pathname.startsWith('/bench/evidence/')) return handleEvidenceRoom(request, env, url);

    // Cloudflare Access sends a browser back to exactly the path it first
    // tried, after login — so visiting the bare hostname with no path at
    // all lands here on "/" post-login, which this Worker has never served
    // (it only ever served /bench/*): a real 404, not a cosmetic one, the
    // first time anyone lands on the bare domain rather than a /bench/ link.
    if (url.pathname === "/") return Response.redirect(`https://${url.host}${BENCH_PREFIX}`, 302);

    if (url.pathname.startsWith(BENCH_PREFIX)) {
      if (request.method === "GET") return handleBenchGet(request, env, url);
      // ctx is threaded through only here: several POST routes trigger a
      // case summary regeneration (bench-case-summary.js) via
      // ctx.waitUntil, so the redirect this returns doesn't wait on an AI
      // call — see regenerateCaseSummaryInBackground in bench-working.js.
      if (request.method === "POST") return handleBenchPost(request, env, url, ctx);
      // PUT streams a blob's raw bytes straight to R2 (see bench-working.js's
      // own header) — deliberately not a POST, so the body is never the
      // multipart/form-data request.formData() would otherwise have to
      // buffer whole into the Worker's own 128 MB memory ceiling.
      if (request.method === "PUT") return handleBenchPut(request, env, url);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname.startsWith(ENTRUSTED_PREFIX)) {
      if (request.method === "GET") return handleBenchEntrustedGet(request, env, url);
      if (request.method === "POST") return handleBenchEntrustedPost(request, env, url);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
