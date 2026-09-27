// Serves darius.life/legal/private/* from R2. Cloudflare Access is the primary
// gate (self-hosted application on this exact path), but this Worker does not
// trust that alone: it independently verifies the Cf-Access-Jwt-Assertion header
// itself before touching R2, per brief v2.1 section 9.9. Any verification
// failure returns 403 and reads nothing — fail closed, never fail open.

const CERTS_CACHE_TTL_MS = 5 * 60 * 1000;
let certsCache = null; // { fetchedAt: number, keys: Map<string, CryptoKey> }

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const base64UrlToJson = (b64url) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));

async function getSigningKeys(teamDomain) {
  const now = Date.now();
  if (certsCache && now - certsCache.fetchedAt < CERTS_CACHE_TTL_MS) return certsCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`fetching Access certs failed: HTTP ${res.status}`);
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  certsCache = { fetchedAt: now, keys: map };
  return map;
}

// Verifies signature, expiry, and audience. Returns the decoded payload, or throws.
async function verifyAccessJwt(token, teamDomain, expectedAud) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = base64UrlToJson(headerB64);
  if (header.alg !== "RS256") throw new Error(`unexpected alg "${header.alg}"`);
  const payload = base64UrlToJson(payloadB64);

  const keys = await getSigningKeys(teamDomain);
  const key = keys.get(header.kid);
  if (!key) throw new Error("unknown signing key");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error("signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) throw new Error("token expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new Error("token not yet valid");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(expectedAud)) throw new Error("aud mismatch");
  return payload;
}

const PREFIX = "/legal/private/";
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const baseHeaders = (contentType) => ({
  "content-type": contentType,
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

function renderIndex(objects) {
  const items = objects.filter((o) => o.key !== "index.html");
  const list = items.length
    ? `<ul>\n${items.map((o) => `<li><a href="./${encodeURIComponent(o.key)}">${escapeHtml(o.key)}</a></li>`).join("\n")}\n</ul>`
    : "<p>No documents have been placed here.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'"><meta name="referrer" content="no-referrer"><title>Active legal proceedings · darius.life</title><link rel="stylesheet" href="/styles.css"></head><body><div class="page"><main><h1 class="section-heading">Active legal proceedings</h1>\n${list}\n</main></div></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return new Response("Not Found", { status: 404 });

    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return new Response("Forbidden", { status: 403, headers: baseHeaders("text/plain; charset=utf-8") });
    try {
      await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    } catch {
      return new Response("Forbidden", { status: 403, headers: baseHeaders("text/plain; charset=utf-8") });
    }

    let key = decodeURIComponent(url.pathname.slice(PREFIX.length));
    if (key === "" || key.endsWith("/")) key += "index.html";

    const obj = await env.PRIVATE_LEGAL.get(key);
    if (!obj) {
      if (key !== "index.html") return new Response("Not Found", { status: 404, headers: baseHeaders("text/plain; charset=utf-8") });
      const listing = await env.PRIVATE_LEGAL.list();
      return new Response(renderIndex(listing.objects), { status: 200, headers: baseHeaders("text/html; charset=utf-8") });
    }
    return new Response(obj.body, { status: 200, headers: baseHeaders(obj.httpMetadata?.contentType || "application/octet-stream") });
  },
};

export const _internal = {
  verifyAccessJwt,
  base64UrlToJson,
  renderIndex,
  resetCertsCacheForTests: () => {
    certsCache = null;
  },
};
