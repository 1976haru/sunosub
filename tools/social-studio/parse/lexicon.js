/**
 * TASK-S0 — local dictionary lookup layer.
 *
 * All translation in social-studio comes from the flat JSON files under
 * data/lexicon/{lang}/*.json — never from a translation API (forbidden, see
 * docs/social-package-spec.md). A lookup miss is not a bug: it means the
 * dictionary doesn't cover that word yet, and the caller must record it as an
 * unknown term rather than guess. This module never invents a translation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEXICON_ROOT = path.join(__dirname, '..', 'data', 'lexicon');

// Guards every scan loop in this module against a malformed input producing
// an unbounded/infinite loop (TASK-S0 completion condition #9).
const MAX_TOKENS_PER_SCAN = 2000;
const MAX_WINDOW_WORDS = 4;

/** Normalizes a phrase for dictionary-key comparison: lowercase, hyphens -> spaces, collapsed whitespace. */
export function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const normalized = normalizePhrase(text).replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return normalized.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS_PER_SCAN);
}

/** Reads data/lexicon/{lang}/{category}.json. Returns {version, entries} — entries keyed by normalized phrase. */
export function loadLexicon(lang, category) {
  const filePath = path.join(LEXICON_ROOT, lang, `${category}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`사전 파일을 찾을 수 없습니다: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  if (!data || typeof data.entries !== 'object' || data.entries === null) {
    throw new Error(`사전 파일 형식이 올바르지 않습니다 (entries 없음): ${filePath}`);
  }
  const entries = {};
  for (const [key, value] of Object.entries(data.entries)) {
    entries[normalizePhrase(key)] = value;
  }
  return { version: data.version ?? 1, entries };
}

export function loadStopwords() {
  const filePath = path.join(LEXICON_ROOT, 'stopwords.en.json');
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  return new Set((data.words || []).map((w) => normalizePhrase(w)));
}

/** Direct phrase lookup (used for emotionArc from/to/transition — the whole phrase is the key). */
export function lookupExact(phrase, lexicon) {
  const key = normalizePhrase(phrase);
  const entry = lexicon.entries[key];
  return entry ? { ko: entry.ko, category: entry.category ?? null } : null;
}

// Small, fixed set of candidate base forms for a single word (plural / -ing /
// -ed), tried only when the exact surface form has no dictionary entry.
// This is a lookup fallback, never a translation guess: a variant only
// "succeeds" when it hits a real entries[] key someone already wrote a
// Korean translation for (TASK-S7 — "정규화 규칙으로 처리한다", not one
// dictionary entry per inflected form like "blowing"/"blows"). Bounded to a
// handful of fixed-size array pushes, so it adds no unbounded loop.
function morphologicalVariants(word) {
  const variants = [];
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    variants.push(word.slice(0, -1)); // windows -> window
  }
  for (const suffix of ['ing', 'ed']) {
    if (!word.endsWith(suffix) || word.length <= suffix.length + 2) continue;
    const stem = word.slice(0, -suffix.length);
    variants.push(stem); // rolling -> roll
    variants.push(`${stem}e`); // sliding -> slide
    const last = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (last && last === prev && !'aeiou'.includes(last)) {
      variants.push(stem.slice(0, -1)); // stepping -> stepp -> step
    }
  }
  return variants;
}

/**
 * Scans free text (e.g. listenerSituation) for dictionary terms using
 * longest-match-first over a sliding word window, skipping stopwords.
 *
 * `sources` is an ordered list of { name, lexicon }. A term is looked up
 * against every source at each window size (longest window first); when
 * several sources have an entry for the same window, the earlier source in
 * the list wins. This lets a more specific dictionary (e.g. timewords) take
 * priority over a general one (nouns) without double-counting a token.
 *
 * Single-word windows that don't match verbatim also try a small set of
 * morphological variants (see morphologicalVariants()) before giving up.
 *
 * Returns { matchedTerms: [{term, ko, category, source}], unknownTerms: [term] }.
 */
export function scanTextMulti(text, sources, stopwords) {
  const tokens = tokenize(text);
  const matchedTerms = [];
  const unknownTerms = [];
  let i = 0;
  let iterations = 0;
  while (i < tokens.length && iterations < MAX_TOKENS_PER_SCAN) {
    iterations += 1;
    let matched = false;
    const maxWindow = Math.min(MAX_WINDOW_WORDS, tokens.length - i);
    for (let windowSize = maxWindow; windowSize >= 1 && !matched; windowSize -= 1) {
      const candidate = tokens.slice(i, i + windowSize).join(' ');
      const lookupKeys = windowSize === 1 ? [candidate, ...morphologicalVariants(candidate)] : [candidate];
      for (const { name, lexicon } of sources) {
        for (const key of lookupKeys) {
          const entry = lexicon.entries[key];
          if (entry) {
            matchedTerms.push({ term: candidate, ko: entry.ko, category: entry.category ?? null, source: name });
            i += windowSize;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }
    if (matched) continue;
    const word = tokens[i];
    if (!stopwords.has(word)) {
      unknownTerms.push(word);
    }
    i += 1;
  }
  return { matchedTerms, unknownTerms };
}

/**
 * Coverage for one named source only: matches from other sources (e.g. a
 * timewords hit) are excluded from both sides of the ratio, since they were
 * never nouns.json's to resolve. Unknown terms (resolved by nobody) are
 * charged against every source's coverage — see docs/social-package-spec.md
 * for why (keeps the "empty dictionary -> coverage collapses to 0" guarantee
 * from TASK-S0 completion condition #5 independent of the other dictionaries).
 */
export function computeSourceCoverage(matchedTerms, unknownTerms, sourceName) {
  const matchedTokenCount = matchedTerms
    .filter((m) => m.source === sourceName)
    .reduce((sum, m) => sum + m.term.split(' ').length, 0);
  const total = matchedTokenCount + unknownTerms.length;
  if (total === 0) return 1;
  return matchedTokenCount / total;
}
