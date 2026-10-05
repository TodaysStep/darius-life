import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvidenceText, renderEvidenceAudio, renderEvidenceTranscript } from './bench-rich-text.js';
import { renderEntrustedView } from './bench-entrusted-view.js';

test('preserves paragraphs, line breaks, explicit headings and quotations', () => {
  const html = renderEvidenceText('# Heading\r\n\r\nFirst paragraph.\nContinuation.\n\n> Exact quotation.\n> Second line.\n\nLast paragraph.');
  assert.match(html, /<h3>Heading<\/h3>/);
  assert.match(html, /<p>First paragraph\.<br>\nContinuation\.<\/p>/);
  assert.match(html, /<blockquote><p>Exact quotation\.<br>\nSecond line\.<\/p><\/blockquote>/);
  assert.match(html, /<p>Last paragraph\.<\/p>/);
});
test('source markup and markdown links never become executable HTML', () => {
  const html = renderEvidenceText('# <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n> [click](javascript:alert(1))');
  assert.doesNotMatch(html, /<img|<script|<a /);
  assert.match(html, /&lt;script&gt;/);
});
test('entrusted facts and authored notes use structured text without private commentary', () => {
  const html = renderEntrustedView([], [{case_label:'Case', body:'Note one\n\nNote two', created_at:'2026-10-04'}], [{case_label:'Case', fact:'First\n\n> Quotation', entry_date:'2026-10-04', commentary:'SECRET'}]);
  assert.match(html, /<p>Note one<\/p>\n<p>Note two<\/p>/);
  assert.match(html, /<blockquote><p>Quotation<\/p><\/blockquote>/);
  assert.doesNotMatch(html, /SECRET/);
});
test('audio accepts only explicit local authorized routes, never storage keys or public URLs', () => {
  for (const href of ['https://example.com/private.mp3', '//example.com/file', '/\\example.com/file', 'r2/object', 'javascript:alert(1)', '/\n/evil']) assert.equal(renderEvidenceAudio({href}), '');
  const html = renderEvidenceAudio({href:'/entrusted/evidence/123/file', title:'<Source>'});
  assert.match(html, /<audio controls preload="none"/);
  assert.match(html, /&lt;Source&gt;/);
  assert.equal(renderEvidenceAudio(), '');
});
test('transcript labels its origin and preserves supplied speaker/time segments safely', () => {
  const html = renderEvidenceTranscript({source:'auto', segments:[{speaker:'<Speaker>', timestamp:'00:12', text:'Line one\n\nLine two'}]});
  assert.match(html, /Machine-generated transcript/);
  assert.match(html, /&lt;Speaker&gt;/);
  assert.match(html, /00:12/);
  assert.match(html, /<p>Line one<\/p>\n<p>Line two<\/p>/);
  assert.doesNotMatch(renderEvidenceTranscript({text:'Untimed'}), /transcript-time|transcript-segment/);
});
