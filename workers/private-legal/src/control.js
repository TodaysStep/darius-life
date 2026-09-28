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
  :root { color-scheme: light; }
  body { margin: 0; background: #F6F3EE; color: #111111; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .page { max-width: 42em; margin: 0 auto; padding: 1.5em 1.2em 4em; }
  h1 { font-size: 1.3em; margin: 0 0 0.2em; }
  h2 { font-size: 1em; margin: 1.6em 0 0.6em; border-top: 1px solid #11111133; padding-top: 1em; }
  p.hint { font-size: 0.9em; opacity: 0.75; margin: 0 0 1.2em; }
  fieldset { border: none; margin: 0; padding: 0; }
  label.opt { display: flex; align-items: center; gap: 0.6em; padding: 0.7em 0.5em; border-radius: 0.4em; }
  label.opt:active { background: #11111112; }
  input[type="radio"] { width: 1.3em; height: 1.3em; margin: 0; flex: none; }
  .proj { margin: 1.1em 0; }
  .proj > .name { font-weight: bold; display: block; margin-bottom: 0.3em; }
  .choices { display: flex; gap: 1em; }
  .choices label.opt { flex: 1; justify-content: center; border: 1px solid #11111133; }
  button { font: inherit; font-weight: bold; width: 100%; padding: 0.9em; margin-top: 2em; background: #111111; color: #F6F3EE; border: none; border-radius: 0.4em; }
  button:active { opacity: 0.85; }
  a { color: #111111; }
  .note { font-size: 0.9em; margin-top: 1.5em; }
</style>
</head><body><div class="page">${body}</div></body></html>`;

function renderForm(personalCurrent, projectItems, projectsCurrent) {
  const statusOptions = STATUS_VOCABULARY.map(
    (line) => `<label class="opt"><input type="radio" name="personal" value="${escapeHtml(line)}"${line === personalCurrent ? " checked" : ""}> ${escapeHtml(line)}</label>`,
  ).join("\n");

  const projectRows = projectItems
    .map((item) => {
      const id = item.id.slice("projects.".length);
      const current = projectsCurrent[id] === "paused" ? "paused" : "active";
      return `<div class="proj">
  <span class="name">${escapeHtml(item.label)}</span>
  <div class="choices">
    <label class="opt"><input type="radio" name="project:${escapeHtml(id)}" value="active"${current === "active" ? " checked" : ""}> Active</label>
    <label class="opt"><input type="radio" name="project:${escapeHtml(id)}" value="paused"${current === "paused" ? " checked" : ""}> Paused</label>
  </div>
</div>`;
    })
    .join("\n");

  return PAGE(
    "Control",
    `<h1>darius.life control</h1>
<p class="hint">Change your status or any project's status. Tap Save — it's live on darius.life within a few minutes, the same way any other change to the site goes live.</p>
<form method="post" action="${PREFIX}">
<h2>Personal status</h2>
<fieldset>${statusOptions}</fieldset>
<h2>Projects</h2>
${projectRows}
<button type="submit">Save</button>
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
