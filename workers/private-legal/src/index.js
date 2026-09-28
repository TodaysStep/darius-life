// Router for everything this Worker serves on darius.life: the private legal
// area (src/legal.js), the status/projects control panel (src/control.js),
// and both sides of Bench Notes (src/bench-working.js, src/bench-entrusted.js).
// legal.js/control.js/bench-working.js independently verify the Access JWT
// themselves — see src/access.js. bench-entrusted.js is its own auth boundary
// (a passphrase, not Access) — see that file's own header for why.
import { PREFIX as LEGAL_PREFIX, handleLegalPrivate, renderIndex } from "./legal.js";
import { PREFIX as CONTROL_PREFIX, handleControlGet, handleControlPost } from "./control.js";
import { PREFIX as BENCH_PREFIX, handleBenchGet, handleBenchPost } from "./bench-working.js";
import { PREFIX as BENCH_ENTRUSTED_PREFIX, handleBenchEntrustedGet, handleBenchEntrustedPost } from "./bench-entrusted.js";
import { verifyAccessJwt, base64UrlToJson, resetCertsCacheForTests } from "./access.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(LEGAL_PREFIX)) return handleLegalPrivate(request, env, url);

    if (url.pathname.startsWith(CONTROL_PREFIX)) {
      if (request.method === "GET") return handleControlGet(request, env);
      if (request.method === "POST") return handleControlPost(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Order matters: BENCH_ENTRUSTED_PREFIX ("/bench-entrusted/") does not
    // start with BENCH_PREFIX ("/bench/"), so either check first is fine —
    // but keep it that way. Never nest one path inside the other.
    if (url.pathname.startsWith(BENCH_PREFIX)) {
      if (request.method === "GET") return handleBenchGet(request, env, url);
      if (request.method === "POST") return handleBenchPost(request, env, url);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname.startsWith(BENCH_ENTRUSTED_PREFIX)) {
      if (request.method === "GET") return handleBenchEntrustedGet(request, env, url);
      if (request.method === "POST") return handleBenchEntrustedPost(request, env, url);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Kept as _internal (rather than plain named exports) so existing tests that
// import it this way don't need to change just because the code was split
// across access.js/legal.js/control.js.
export const _internal = { verifyAccessJwt, base64UrlToJson, renderIndex, resetCertsCacheForTests };
