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
import { PREFIX as BENCH_PREFIX, handleBenchGet, handleBenchPost } from "./bench-working.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(BENCH_PREFIX)) {
      if (request.method === "GET") return handleBenchGet(request, env, url);
      if (request.method === "POST") return handleBenchPost(request, env, url);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
