// Presentation only: never interprets source HTML or fetches evidence. Callers
// must authorize every supplied record and media route before rendering it.
import { escapeHtml } from "./bench-style.js";

export function renderEvidenceText(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let pending = [];
  let kind = "paragraph";
  function flush() {
    if (!pending.length) return;
    const body = pending.map(escapeHtml).join("<br>\n");
    blocks.push(kind === "quote" ? `<blockquote><p>${body}</p></blockquote>` : `<p>${body}</p>`);
    pending = [];
  }
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    const next = quote ? "quote" : "paragraph";
    if (kind !== next) flush();
    kind = next;
    pending.push(quote ? quote[1] : line);
  }
  flush();
  return `<div class="evidence-text" style="overflow-wrap:anywhere">${blocks.join("\n")}</div>`;
}

// Only same-origin, root-relative routes are accepted for embedded evidence.
// Never turn an object-storage key or an external URL into a media embed.
export function evidenceMediaRoute(value) {
  const route = String(value ?? "");
  return /^\/(?!\/)/.test(route) && !/[\\\u0000-\u0020\u007f]/.test(route) ? route : null;
}

export function renderEvidenceAudio({ href, title = "Source recording" } = {}) {
  const route = evidenceMediaRoute(href);
  if (!route) return "";
  return `<figure class="evidence-audio"><figcaption>${escapeHtml(title)}</figcaption><audio controls preload="none" style="width:100%" src="${escapeHtml(route)}">Your browser cannot play this recording.</audio><p><a href="${escapeHtml(route)}">Open original recording</a></p></figure>`;
}

// Segment text, speaker names and timestamps remain escaped text. Timestamps
// come from the derivation; absent speakers or times are never invented.
export function renderEvidenceTranscript({ text = "", segments = [], source = "unknown" } = {}) {
  const labels = { auto: "Machine-generated transcript", manual: "Human-edited transcript", original: "Supplied transcript", unknown: "Transcript — origin not specified" };
  const body = Array.isArray(segments) && segments.length
    ? segments.map((segment) => `<section class="transcript-segment">${segment.timestamp != null ? `<p class="transcript-time">${escapeHtml(segment.timestamp)}</p>` : ""}${segment.speaker ? `<p><strong>${escapeHtml(segment.speaker)}</strong></p>` : ""}${renderEvidenceText(segment.text)}</section>`).join("\n")
    : renderEvidenceText(text);
  return `<section class="evidence-transcript" aria-label="Transcript"><h3>Transcript</h3><p class="hint">${Object.hasOwn(labels, source) ? labels[source] : labels.unknown}</p>${body}</section>`;
}
