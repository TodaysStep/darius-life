// darius.life/control/* — lets Darius change his personal status and every
// project's status himself, from his phone, with no code and no GitHub editing.
// Gated by the same Cloudflare Access application as /legal/private/*.
//
// There is no database here. The single source of truth stays what it always
// was: data/status.json and data/projects.json in TodaysStep/darius-life. This
// page reads them live from GitHub on every GET, and a Save writes a real commit
// back to `main` via the GitHub Contents API — the exact same push event a
// manual edit would produce, so it goes through the exact same build, checks,
// and deploy pipeline (.github/workflows/deploy.yml) as any other change. That
// is what makes it live within a few minutes, not instantly: it is a real build,
// not a bypass of one.
import { requireAccess } from "../../shared/access.js";

export const PREFIX = "/control/";

// Must match checks/run-all.mjs's STATUS_VOCABULARY exactly — this is the one
// other place that list is allowed to live, since a control panel that offered
// a line the build would reject is worse than no control panel.
export const STATUS_VOCABULARY = [
  "Heads down.",
  "In deep work, slow to surface.",
  "Focused on a build, not available for check-ins.",
  "Surfacing soon.",
  "Between projects, more reachable than usual.",
  "Handling something. Will update when there's something to say.",
];

const headers = (contentType) => ({
  "content-type": contentType,
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const GITHUB_HEADERS = (env) => ({
  authorization: `Bearer ${env.GH_COMMIT_TOKEN}`,
  accept: "application/vnd.github+json",
  "user-agent": "darius-life-control-panel",
});

export async function ghGetFile(env, path) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`,
    { headers: GITHUB_HEADERS(env) },
  );
  if (!res.ok) throw new Error(`reading ${path} from GitHub failed: HTTP ${res.status}`);
  const json = await res.json();
  return { content: decodeBase64Utf8(json.content), sha: json.sha };
}

export async function ghPutFile(env, path, content, sha, message) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...GITHUB_HEADERS(env), "content-type": "application/json" },
    body: JSON.stringify({ message, content: encodeBase64Utf8(content), sha, branch: env.GITHUB_BRANCH }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`writing ${path} to GitHub failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · darius.life control</title>
<style>
  @font-face { font-family: "Courier Prime"; src: url("/assets/fonts/courier-prime/CourierPrime-Regular.woff2") format("woff2"); font-weight: 400; font-display: optional; }
  @font-face { font-family: "Courier Prime"; src: url("/assets/fonts/courier-prime/CourierPrime-Bold.woff2") format("woff2"); font-weight: 700; font-display: optional; }
  :root { color-scheme: light; --ink: #111111; --paper: #F6F3EE; --rule: rgba(17, 17, 17, 0.4); --hair: rgba(17, 17, 17, 0.18); --green: #1E8E3E; --grey: #8C8C8C; }
  html { background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Courier Prime", "Courier New", Courier, monospace; font-size: 17px; line-height: 1.6; }
  .page { max-width: 46ch; margin: 0 auto; padding: 48px 24px 132px; }
  .eyebrow { margin: 0 0 0.2em; font-size: 0.88em; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
  h1 { font-size: 1.3em; font-weight: 700; line-height: 1.3; margin: 0 0 0.6em; }
  h2 { font-size: 1em; font-weight: 700; line-height: 1.4; letter-spacing: 0.08em; text-transform: uppercase; border-top: 1px solid var(--rule); margin: 2.4em 0 0.6em; padding-top: 1.3em; }
  p { margin: 0 0 1em; }
  p.hint { font-size: 0.9em; opacity: 0.75; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  .led { display: inline-block; width: 0.6em; height: 0.6em; border-radius: 50%; flex: none; }
  .led-green { background: var(--green); box-shadow: 0 0 0.45em 0.08em rgba(30, 142, 62, 0.65); }
  .led-grey { background: var(--grey); box-shadow: 0 0 0.35em 0.06em rgba(140, 140, 140, 0.45); }
  .opt { position: relative; display: block; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .opt input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .list .opt { display: flex; align-items: flex-start; gap: 0.9em; padding: 0.85em 0; border-bottom: 1px solid var(--hair); min-height: 44px; box-sizing: border-box; }
  .list .opt:last-child { border-bottom: 0; }
  .mark { flex: none; width: 1.05em; height: 1.05em; margin-top: 0.3em; border: 1.5px solid var(--ink); border-radius: 50%; box-sizing: border-box; position: relative; }
  .opt input:checked + .mark { border-color: var(--green); }
  .opt input:checked + .mark::after { content: ""; position: absolute; inset: 0.14em; border-radius: 50%; background: var(--green); box-shadow: 0 0 0.45em 0.08em rgba(30, 142, 62, 0.65); }
  .opt input:checked ~ .txt { font-weight: 700; }
  .opt input:focus-visible + .mark, .opt input:focus-visible ~ .seg { outline: 2px solid var(--ink); outline-offset: 3px; }
  .proj { padding: 0.9em 0; border-bottom: 1px solid var(--hair); }
  .proj:last-of-type { border-bottom: 0; }
  .name { display: block; margin: 0 0 0.55em; line-height: 1.4; }
  .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6em; }
  .choices .opt { min-height: 44px; }
  .seg { display: flex; align-items: center; justify-content: center; gap: 0.55em; min-height: 44px; box-sizing: border-box; border: 1px solid var(--rule); border-radius: 0.3em; font-size: 0.94em; }
  .opt input:checked ~ .seg { background: var(--ink); color: var(--paper); border-color: var(--ink); font-weight: 700; }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 14px 24px calc(14px + env(safe-area-inset-bottom)); background: linear-gradient(to bottom, rgba(246, 243, 238, 0), var(--paper) 22%); }
  .bar > div { max-width: 46ch; margin: 0 auto; }
  button { font: inherit; font-weight: 700; letter-spacing: 0.04em; width: 100%; min-height: 50px; background: var(--ink); color: var(--paper); border: 0; border-radius: 0.3em; cursor: pointer; }
  button:active { opacity: 0.85; }
  button:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
  a, a:visited { color: var(--ink); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.18em; }
  a:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
  .note { font-size: 0.9em; margin-top: 1.5em; }
</style>
</head><body><div class="page">${body}</div></body></html>`;

function renderForm(personalCurrent, projectItems, projectsCurrent) {
  const statusOptions = STATUS_VOCABULARY.map(
    (line) => `<label class="opt"><input type="radio" name="personal" value="${escapeHtml(line)}"${line === personalCurrent ? " checked" : ""}><span class="mark" aria-hidden="true"></span><span class="txt">${escapeHtml(line)}</span></label>`,
  ).join("\n");

  const projectRows = projectItems
    .map((item) => {
      const id = item.id.slice("projects.".length);
      const current = projectsCurrent[id] === "paused" ? "paused" : "active";
      return `<div class="proj" role="radiogroup" aria-labelledby="n-${escapeHtml(id)}">
  <span class="name" id="n-${escapeHtml(id)}">${escapeHtml(item.label)}</span>
  <div class="choices">
    <label class="opt"><input type="radio" name="project:${escapeHtml(id)}" value="active"${current === "active" ? " checked" : ""}><span class="seg"><span class="led led-green" aria-hidden="true"></span>Active</span></label>
    <label class="opt"><input type="radio" name="project:${escapeHtml(id)}" value="paused"${current === "paused" ? " checked" : ""}><span class="seg"><span class="led led-grey" aria-hidden="true"></span>Paused</span></label>
  </div>
</div>`;
    })
    .join("\n");

  return PAGE(
    "Control",
    `<p class="eyebrow">darius.life</p>
<h1>Control</h1>
<p class="hint">Change your status or any project's status. Tap Save — it's live on darius.life within a few minutes, the same way any other change to the site goes live.</p>
<form method="post" action="${PREFIX}">
<h2>Personal status</h2>
<fieldset class="list">${statusOptions}</fieldset>
<h2>Projects</h2>
${projectRows}
<div class="bar"><div><button type="submit">Save</button></div></div>
</form>`,
  );
}

function savedPage() {
  return PAGE(
    "Saved",
    `<h1>Saved</h1>
<p>Your change was committed to the site's repository. GitHub Actions is rebuilding and redeploying darius.life now — it's usually live within a few minutes.</p>
<p class="note"><a href="${PREFIX}">Back to control</a> · <a href="https://darius.life/">View darius.life</a></p>`,
  );
}

function errorPage(message) {
  return PAGE(
    "Error",
    `<h1>Something went wrong</h1>
<p>Nothing was saved. ${escapeHtml(message)}</p>
<p class="note"><a href="${PREFIX}">Back to control</a></p>`,
  );
}

const forbidden = () => new Response("Forbidden", { status: 403, headers: headers("text/plain; charset=utf-8") });
const badRequest = (msg) =>
  new Response(errorPage(msg), { status: 400, headers: headers("text/html; charset=utf-8") });

async function readState(env) {
  const [statusFile, projectsFile, manifestFile] = await Promise.all([
    ghGetFile(env, "data/status.json"),
    ghGetFile(env, "data/projects.json"),
    ghGetFile(env, "content/manifest.json"),
  ]);
  const status = JSON.parse(statusFile.content);
  const projects = JSON.parse(projectsFile.content);
  const manifest = JSON.parse(manifestFile.content);
  const projectItems = manifest.items.filter((i) => i.dynamic === "project");
  return { statusFile, projectsFile, status, projects, projectItems };
}

export async function handleControlGet(request, env) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();
  let state;
  try {
    state = await readState(env);
  } catch (e) {
    return new Response(errorPage(e.message), { status: 502, headers: headers("text/html; charset=utf-8") });
  }
  return new Response(renderForm(state.status.personal, state.projectItems, state.projects), {
    status: 200,
    headers: headers("text/html; charset=utf-8"),
  });
}

export async function handleControlPost(request, env) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const form = await request.formData();
  const personal = form.get("personal");
  if (!STATUS_VOCABULARY.includes(personal)) return badRequest('Not one of the six approved status lines.');

  let state;
  try {
    state = await readState(env);
  } catch (e) {
    return new Response(errorPage(e.message), { status: 502, headers: headers("text/html; charset=utf-8") });
  }

  const newProjects = {};
  for (const item of state.projectItems) {
    const id = item.id.slice("projects.".length);
    const v = form.get(`project:${id}`);
    if (v !== "active" && v !== "paused") return badRequest(`Missing or invalid status for "${escapeHtml(item.label)}".`);
    newProjects[id] = v;
  }

  const newStatusContent = JSON.stringify({ personal }, null, 2) + "\n";
  const newProjectsContent = JSON.stringify(newProjects, null, 2) + "\n";

  try {
    await ghPutFile(env, "data/status.json", newStatusContent, state.statusFile.sha, "Update personal status via the darius.life control panel");
    await ghPutFile(env, "data/projects.json", newProjectsContent, state.projectsFile.sha, "Update project statuses via the darius.life control panel");
  } catch (e) {
    return new Response(errorPage(e.message), { status: 502, headers: headers("text/html; charset=utf-8") });
  }

  return new Response(savedPage(), { status: 200, headers: headers("text/html; charset=utf-8") });
}

export const _internal = { renderForm, savedPage, errorPage, decodeBase64Utf8, encodeBase64Utf8 };
