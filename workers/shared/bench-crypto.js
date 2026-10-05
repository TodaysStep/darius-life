// Small crypto utilities shared by the working side (which hashes a new
// entrusted passphrase when Darius creates an access grant) and the entrusted
// side (which verifies a submitted passphrase and signs/checks its session
// cookie). This is infrastructure, not data — it never reads or writes any
// table itself, so sharing it doesn't blur the confidentiality boundary
// between bench-working.js and bench-entrusted.js.

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// Signs { ...payload, exp } into "<base64url json>.<base64url hmac>".
export async function signSession(payload, secret, ttlSeconds) {
  const body = JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const bodyB64 = b64url(new TextEncoder().encode(body));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyB64));
  return `${bodyB64}.${b64url(sig)}`;
}

// Verifies signature and expiry. Returns the decoded payload, or null.
export async function verifySession(token, secret) {
  if (typeof token !== "string" || !token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [bodyB64, sigB64] = parts;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sigB64), new TextEncoder().encode(bodyB64));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(bodyB64)));
    if (!payload || typeof payload !== "object" || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
