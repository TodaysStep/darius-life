// Shared by every Access-gated route across both darius-life-private-legal
// and darius-life-confidential. Cloudflare Access is the primary gate at the
// edge, but nothing here trusts that alone: each route independently
// verifies the Cf-Access-Jwt-Assertion header itself before doing anything
// else, against whichever team domain/AUD its own Worker's env supplies —
// the two Workers use different, unrelated Access applications. Any
// verification failure must result in a 403 with nothing done — fail closed.

const CERTS_CACHE_TTL_MS = 5 * 60 * 1000;
let certsCache = null; // { fetchedAt: number, keys: Map<string, CryptoKey> }

export function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const base64UrlToJson = (b64url) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));

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
export async function verifyAccessJwt(token, teamDomain, expectedAud) {
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

// Verifies the request's Access token against env's team domain/AUD. Returns the
// decoded payload on success, or null on any failure (missing header, bad token,
// wrong audience, expired) — callers should treat null as "403, do nothing else".
export async function requireAccess(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    return await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  } catch {
    return null;
  }
}

export const resetCertsCacheForTests = () => {
  certsCache = null;
};

// Bench Notes has one owner. Being allowed through an Access application
// does not authorize managing or sharing the owner's docket.
export async function requireBenchOwner(request, env) {
  if (!env.BENCH_OWNER_EMAIL) return null;
  const payload = await requireAccess(request, env);
  if (!payload || typeof payload.email !== "string" || payload.email.toLowerCase() !== env.BENCH_OWNER_EMAIL.toLowerCase()) return null;
  return payload;
}
