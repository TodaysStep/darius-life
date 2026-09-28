// Router for confidential.darius.life — the pre-existing, dashboard-created
// Access application ("confidential legal area") gates this Worker's entire
// production/preview URL, at the edge, before any request reaches this code.
// bench-working.js still independently re-verifies the Access JWT itself
// (see src/shared/access.js) — belt and suspenders, same as every other
// gated route in this repo, even though Access has already checked once.
//
// This Worker serves only Bench Notes' working side (Darius's own private
// docket). The entrusted side is deliberately NOT here — see
// workers/private-legal/src/bench-entrusted.js's own header for why it
// cannot live behind this same gate.
import { PREFIX as BENCH_PREFIX, handleBenchGet, handleBenchPost, handleBenchPut } from "./bench-working.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Cloudflare Access sends a browser back to exactly the path it first
    // tried, after login — so visiting the bare hostname with no path at
    // all lands here on "/" post-login, which this Worker has never served
    // (it only ever served /bench/*): a real 404, not a cosmetic one, the
    // first time anyone lands on the bare domain rather than a /bench/ link.
    if (url.pathname === "/") return Response.redirect(`https://${url.host}${BENCH_PREFIX}`, 302);

    if (url.pathname.startsWith(BENCH_PREFIX)) {
      if (request.method === "GET") return handleBenchGet(request, env, url);
      if (request.method === "POST") return handleBenchPost(request, env, url);
      // PUT streams a blob's raw bytes straight to R2 (see bench-working.js's
      // own header) — deliberately not a POST, so the body is never the
      // multipart/form-data request.formData() would otherwise have to
      // buffer whole into the Worker's own 128 MB memory ceiling.
      if (request.method === "PUT") return handleBenchPut(request, env, url);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
