/**
 * TASK-S3 — text similarity, entirely local (no embedding API, no
 * morphological analyzer — spec section 8's 무설치 원칙). Character 3-gram
 * Jaccard was picked specifically because it needs no installed dictionary
 * and works the same way on Korean, English, and mixed text — the same
 * property that made regex-based checks (not an NLP library) the right call
 * for lib/titleLint.js earlier in this project.
 */

const URL_PATTERN = /https?:\/\/\S+/g;
const HASHTAG_PATTERN = /#\S+/g;
const NUMBER_PATTERN = /\d+/g;
const PUNCT_PATTERN = /[.,!?~…\-–—"'“”‘’(){}\[\]:;·/\\|]/g;

// Explicit bounds (TASK-S3 completion condition #11).
const MAX_TRIGRAM_SOURCE_LENGTH = 20000;

/** Strips URLs/hashtags, folds all digit runs to one marker, drops punctuation, collapses whitespace, lowercases. */
export function normalizeForSimilarity(text) {
  return String(text ?? '')
    .replace(URL_PATTERN, ' ')
    .replace(HASHTAG_PATTERN, ' ')
    .replace(NUMBER_PATTERN, '#')
    .replace(PUNCT_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Character 3-gram set. A string shorter than 3 chars becomes its own single "gram" so short strings still compare. */
export function charTrigrams(normalizedText) {
  const grams = new Set();
  const s = normalizedText.slice(0, MAX_TRIGRAM_SOURCE_LENGTH);
  if (s.length === 0) return grams;
  if (s.length < 3) {
    grams.add(s);
    return grams;
  }
  const limit = s.length - 2;
  for (let i = 0; i < limit; i += 1) {
    grams.add(s.slice(i, i + 3));
  }
  return grams;
}

/**
 * Exact Jaccard similarity of two texts' normalized character-trigram sets.
 * Symmetric by construction (set intersection/union don't care about
 * argument order). Two empty-after-normalization strings return 0, not 1 —
 * "nothing to compare" is not "identical".
 */
export function jaccardSimilarity(textA, textB) {
  const a = normalizeForSimilarity(textA);
  const b = normalizeForSimilarity(textB);
  if (a.length === 0 && b.length === 0) return 0;
  if (a === b) return 1;

  const gramsA = charTrigrams(a);
  const gramsB = charTrigrams(b);
  const [smaller, larger] = gramsA.size <= gramsB.size ? [gramsA, gramsB] : [gramsB, gramsA];

  let intersection = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) intersection += 1;
  }
  const union = gramsA.size + gramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Short, opaque content marker for lintHistory.json — never the raw text (spec section 6/8). Equality-only use (detects verbatim reuse), not a similarity reconstruction. */
export function contentFingerprint(text) {
  const normalized = normalizeForSimilarity(text);
  let hash = 2166136261; // FNV-1a, 32-bit — plenty for a same-run dedup marker, no crypto import needed
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Shared excerpt builder for violation reports — first `radius*2` chars, so a reviewer can see enough context without the whole field (spec's own report example: "해당 부분 앞뒤 40자"). */
export function buildExcerpt(text, radius = 40) {
  const s = String(text ?? '');
  return s.length <= radius * 2 ? s : `${s.slice(0, radius * 2)}…`;
}

/**
 * The fixed set of "prose" fields worth comparing/scanning across R1
 * (cross-channel similarity) and R7 (in-caption repetition) — hashtag/tag
 * arrays and raw URLs are deliberately excluded (spec R1: "해시태그와 URL은
 * 제외하고 본문만 비교한다"), and normalizeForSimilarity strips them again
 * defensively even if a caller passes one in some other codepath.
 */
export function extractProseFields(textpack) {
  const fields = [];
  const push = (path, value) => {
    if (value) fields.push({ path, text: String(value) });
  };

  (textpack.youtube?.titles || []).forEach((t, i) => push(`youtube.titles.${i}`, t));
  push('youtube.description', textpack.youtube?.description);
  push('youtube.pinnedComment', textpack.youtube?.pinnedComment);
  push('naver.title', textpack.naver?.title);
  push('naver.bodyHtml', textpack.naver?.bodyHtml);
  push('facebook.body', textpack.facebook?.body);
  push('x.main', textpack.x?.main);
  if (Array.isArray(textpack.x?.thread) && textpack.x.thread.length) {
    push('x.thread', textpack.x.thread.join(' '));
  }
  push('instagram.caption', textpack.instagram?.caption);
  for (const s of textpack.shorts || []) {
    push(`shorts.${s.trackNo}.titleKo`, s.titleKo);
    push(`shorts.${s.trackNo}.descriptionKo`, s.descriptionKo);
  }
  return fields;
}
