// Router for everything this Worker serves on darius.life: the private legal
// area (src/legal.js), the status/projects control panel (src/control.js),
// Bench Notes' entrusted side (src/bench-entrusted.js), and Bench Notes'
// machine API (src/bench-api.js — the publishing desk's write surface).
// Bench Notes' working-side HTML UI moved to its own Worker on
// confidential.darius.life (workers/confidential/) on 2026-09-28, to reuse
// that hostname's existing Cloudflare Access application rather than gating
// darius.life itself. legal.js/control.js independently verify the Access
// JWT themselves — see src/access.js. bench-entrusted.js and bench-api.js
// are each their own auth boundary (a passphrase; a bearer secret) — see
// their own headers for why neither is behind Access.
import { PREFIX as LEGAL_PREFIX, handleLegalPrivate, renderIndex } from "./legal.js";
import { PREFIX as CONTROL_PREFIX, handleControlGet, handleControlPost } from "./control.js";
// Guests' original address; the entrusted side now lives on confidential.darius.life/entrusted/.
const BENCH_ENTRUSTED_PREFIX = "/bench-entrusted/";
const ENTRUSTED_HOME = "https://confidential.darius.life/entrusted/";
import { PREFIX as BENCH_API_PREFIX, handleBenchApi } from "./bench-api.js";
import { verifyAccessJwt, base64UrlToJson, resetCertsCacheForTests } from "../../shared/access.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(LEGAL_PREFIX)) return handleLegalPrivate(request, env, url);

    if (url.pathname.startsWith(CONTROL_PREFIX)) {
      if (request.method === "GET") return handleControlGet(request, env);
      if (request.method === "POST") return handleControlPost(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname.startsWith(BENCH_ENTRUSTED_PREFIX)) {
      // Bookmarks and links already handed to guests keep working. GET only: a
      // passphrase must never be POSTed to, or redirected through, another address.
      if (request.method === "GET" || request.method === "HEAD") {
        return Response.redirect(ENTRUSTED_HOME + url.pathname.slice(BENCH_ENTRUSTED_PREFIX.length) + url.search, 301);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname.startsWith(BENCH_API_PREFIX)) return handleBenchApi(request, env, url);

    return new Response("Not Found", { status: 404 });
  },
};

// Kept as _internal (rather than plain named exports) so existing tests that
// import it this way don't need to change just because the code was split
// across access.js/legal.js/control.js.
export const _internal = { verifyAccessJwt, base64UrlToJson, renderIndex, resetCertsCacheForTests };
