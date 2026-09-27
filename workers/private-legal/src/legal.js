// Serves darius.life/legal/private/* from R2. See src/access.js for the Access
// JWT verification this route relies on before ever touching R2.
import { requireAccess } from "./access.js";

export const PREFIX = "/legal/private/";
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const baseHeaders = (contentType) => ({
  "content-type": contentType,
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

export function renderIndex(objects) {
  const items = objects.filter((o) => o.key !== "index.html");
  const list = items.length
    ? `<ul>\n${items.map((o) => `<li><a href="./${encodeURIComponent(o.key)}">${escapeHtml(o.key)}</a></li>`).join("\n")}\n</ul>`
    : "<p>No documents have been placed here.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'none'"><meta name="referrer" content="no-referrer"><title>Active legal proceedings · darius.life</title><link rel="stylesheet" href="/styles.css"></head><body><div class="page"><main><h1 class="section-heading">Active legal proceedings</h1>\n${list}\n</main></div></body></html>`;
}

export async function handleLegalPrivate(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return new Response("Forbidden", { status: 403, headers: baseHeaders("text/plain; charset=utf-8") });

  let key = decodeURIComponent(url.pathname.slice(PREFIX.length));
  if (key === "" || key.endsWith("/")) key += "index.html";

  const obj = await env.PRIVATE_LEGAL.get(key);
  if (!obj) {
    if (key !== "index.html") return new Response("Not Found", { status: 404, headers: baseHeaders("text/plain; charset=utf-8") });
    const listing = await env.PRIVATE_LEGAL.list();
    return new Response(renderIndex(listing.objects), { status: 200, headers: baseHeaders("text/html; charset=utf-8") });
  }
  return new Response(obj.body, { status: 200, headers: baseHeaders(obj.httpMetadata?.contentType || "application/octet-stream") });
}
