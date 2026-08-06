/**
 * TASK-S5 — Atom Publishing Protocol entry XML for Hatena Blog's scheduled
 * publishing.
 *
 * Namespaces and endpoint format confirmed against the official docs
 * (fetched during implementation, see docs section in the completion
 * report): Atom = http://www.w3.org/2005/Atom, app =
 * http://www.w3.org/2007/app, hatenablog =
 * http://www.hatena.ne.jp/info/xmlns#hatenablog. The scheduled-publish
 * element (hatenablog:scheduled) was added to the docs 2026-02-24 — not a
 * legacy/unsupported feature, contrary to older blog posts about this API.
 *
 * No XML parser dependency was added for validation (무설치 원칙) — since
 * this module is the only thing that ever builds this XML, a hand-rolled
 * tag-balance + required-element check is enough to catch a real bug in
 * the generator itself, which is what validateEntryXml() is for.
 */

const ATOM_NS = 'http://www.w3.org/2005/Atom';
const APP_NS = 'http://www.w3.org/2007/app';
const HATENABLOG_NS = 'http://www.hatena.ne.jp/info/xmlns#hatenablog';

const MAX_TAG_SCAN = 500; // explicit bound on the well-formedness tag scan

export function buildEntryEndpoint(hatenaId, blogId) {
  return `https://blog.hatena.ne.jp/${encodeURIComponent(hatenaId)}/${encodeURIComponent(blogId)}/atom/entry`;
}

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds the scheduled-draft Atom entry XML. `updatedIso` MUST already be a
 * future timestamp with an explicit offset (e.g. +09:00) — this function
 * does not itself enforce that; publish/hatena.js's preflight checks do,
 * before this is ever called for a real submission.
 */
export function buildEntryXml({ title, contentHtml, hatenaId, updatedIso, category }) {
  if (!title || !contentHtml || !hatenaId || !updatedIso || !category) {
    throw new Error('buildEntryXml: title, contentHtml, hatenaId, updatedIso, category가 모두 필요합니다.');
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<entry xmlns="${ATOM_NS}"
       xmlns:app="${APP_NS}"
       xmlns:hatenablog="${HATENABLOG_NS}">
  <title>${escapeXml(title)}</title>
  <author><name>${escapeXml(hatenaId)}</name></author>
  <content type="text/html">${escapeXml(contentHtml)}</content>
  <updated>${updatedIso}</updated>
  <category term="${escapeXml(category)}" />
  <app:control>
    <app:draft>yes</app:draft>
    <hatenablog:scheduled>yes</hatenablog:scheduled>
  </app:control>
</entry>`;
}

/**
 * Hand-rolled well-formedness + required-element check (no XML parser
 * dependency). Returns { valid, errors }.
 */
export function validateEntryXml(xml, { now = new Date() } = {}) {
  const errors = [];

  if (!xml.trim().startsWith('<?xml')) {
    errors.push('XML 선언이 없습니다.');
  }

  // Balanced-tag scan: every opening tag must have a matching close, in order.
  const tagPattern = /<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g;
  const stack = [];
  let match;
  let scanCount = 0;
  while ((match = tagPattern.exec(xml)) && scanCount < MAX_TAG_SCAN) {
    scanCount += 1;
    const [full, tagName, selfClosing] = match;
    if (full.startsWith('<?')) continue;
    if (selfClosing === '/') continue; // self-closing, e.g. <category .../>
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== tagName) {
        errors.push(`태그 짝이 맞지 않습니다: </${tagName}> (열린 태그: ${top ?? '없음'})`);
      }
    } else {
      stack.push(tagName);
    }
  }
  if (stack.length > 0) errors.push(`닫히지 않은 태그가 있습니다: ${stack.join(', ')}`);

  const requiredPatterns = [
    { name: 'title', pattern: /<title>.*?<\/title>/s },
    { name: 'author/name', pattern: /<author><name>.*?<\/name><\/author>/s },
    { name: 'content', pattern: /<content type="text\/html">/ },
    { name: 'updated', pattern: /<updated>([^<]+)<\/updated>/ },
    { name: 'category', pattern: /<category term="[^"]*"\s*\/>/ },
    { name: 'app:draft=yes', pattern: /<app:draft>yes<\/app:draft>/ },
    { name: 'hatenablog:scheduled=yes', pattern: /<hatenablog:scheduled>yes<\/hatenablog:scheduled>/ },
  ];
  for (const { name, pattern } of requiredPatterns) {
    if (!pattern.test(xml)) errors.push(`필수 요소가 없습니다: ${name}`);
  }

  const updatedMatch = xml.match(/<updated>([^<]+)<\/updated>/);
  if (updatedMatch) {
    const updatedDate = new Date(updatedMatch[1]);
    if (Number.isNaN(updatedDate.getTime())) {
      errors.push(`updated 값이 올바른 날짜가 아닙니다: ${updatedMatch[1]}`);
    } else if (updatedDate.getTime() <= now.getTime()) {
      errors.push(`updated가 미래 시각이 아닙니다: ${updatedMatch[1]}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Extracts the published entry's URL from Hatena's Atom response (best-effort regex — no XML parser dependency). */
export function extractEntryUrl(responseXml) {
  const match = responseXml.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/);
  return match ? match[1] : null;
}
