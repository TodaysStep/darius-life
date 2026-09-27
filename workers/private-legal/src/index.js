// Router for everything this Worker serves on darius.life: the private legal
// area (src/legal.js) and the status/projects control panel (src/control.js).
// Both independently verify the Access JWT themselves — see src/access.js.
import { PREFIX as LEGAL_PREFIX, handleLegalPrivate, renderIndex } from "./legal.js";
import { PREFIX as CONTROL_PREFIX, handleControlGet, handleControlPost } from "./control.js";
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

    return new Response("Not Found", { status: 404 });
  },
};

// Kept as _internal (rather than plain named exports) so existing tests that
// import it this way don't need to change just because the code was split
// across access.js/legal.js/control.js.
export const _internal = { verifyAccessJwt, base64UrlToJson, renderIndex, resetCertsCacheForTests };
