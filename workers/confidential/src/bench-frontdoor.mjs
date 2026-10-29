// Generic identity only. Number-only lookup; no cookies, credentials, or private content.
export async function benchFrontdoor(request, env) {
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method Not Allowed',{status:405,headers:{Allow:'GET, HEAD'}});
  const url = new URL(request.url);
  if (url.pathname === '/bench-frontdoor.css') return new Response(request.method === 'HEAD' ? null : 'html{background:#E9E0CC;color:#29261f;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}body{max-width:36rem;margin:8vh auto;padding:1.5rem;line-height:1.6}img{display:block;background:white;width:220px;height:220px;margin:0 auto 2rem}h1{font-size:1.7rem}a{color:inherit}a.open{display:inline-block;padding:.75rem 1rem;border:1px solid currentColor;margin:.5rem 0}small{display:block;margin-top:2rem}', {headers:{'Content-Type':'text/css; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff'}});
  const id = url.searchParams.get('case');
  const match = url.pathname.match(/^\/note\/([0-9]{1,9})$/);
  let label = 'Bench Notes';
  let target = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '') ? '/bench/case/' + id.toLowerCase() : '/bench/';
  if (match) {
    const number = Number(match[1]);
    if (!number || !env?.BENCH_NOTES) return new Response('Not Found', {status:404});
    const row = await env.BENCH_NOTES.prepare('SELECT share_number FROM docket_entries WHERE share_number = ?').bind(number).first();
    if (!row) return new Response('Not Found', {status:404});
    const formatted = String(row.share_number).padStart(3, '0');
    label = 'Bench Note ' + formatted;
    target = '/bench/note/' + formatted;
  }
  const image = 'https://confidential.darius.life/entrusted/stenotype.jpg?v=20261004-3';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${label}</title><meta name="robots" content="noindex, nofollow"><meta name="description" content="Bench Notes. A confidential record, opened only by its authorized readers."><meta property="og:type" content="website"><meta property="og:site_name" content="Bench Notes"><meta property="og:title" content="${label}"><meta property="og:description" content="A confidential record, opened only by its authorized readers."><meta property="og:image" content="${image}"><meta property="og:image:secure_url" content="${image}"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="447"><meta property="og:image:height" content="447"><meta property="og:image:alt" content="Stenotype machine on a white field"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${label}"><meta name="twitter:image" content="${image}"><link rel="icon" type="image/jpeg" href="${image}"><link rel="apple-touch-icon" href="${image}"><link rel="stylesheet" href="/bench-frontdoor.css?v=20261029"></head><body><main><img src="${image}" width="220" height="220" alt="Stenotype machine"><h1>${label}</h1><p>Confidential access</p><p>A confidential record, opened only by its authorized readers.</p><p><a class="open" href="${target}">Open ${label}</a></p><p>Sign in securely to continue. This page does not display any private notes.</p><small>Entrusted readers: use the specific invitation you received, or <a href="/entrusted/">open entrusted access</a>.</small></main></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}
