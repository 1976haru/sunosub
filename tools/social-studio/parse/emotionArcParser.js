/**
 * TASK-S0 — emotionArc grammar parser.
 *
 * Suno Weaver Studio's emotionArc field follows one fixed grammar:
 *   {시작감정구} {전이동사} (into|toward) {도착감정구}
 * e.g. "sleepy heaviness opening into steady comfort"
 *
 * We do NOT hardcode the transition-verb list here — it's read from
 * data/lexicon/{lang}/transitions.json so a new verb can be added by editing
 * JSON, not code. A string that doesn't fit the grammar (or whose verb isn't
 * in the dictionary yet) is never silently passed through: it comes back
 * with parsed:false and the caller is expected to log it, not guess.
 */

import { normalizePhrase, lookupExact } from './lexicon.js';

const JOINER_PATTERN = /\s+(into|toward)\s+/i;

/**
 * @param {string} raw - the emotionArc string as written in the setpack.
 * @param {{version:number, entries:object}} transitionsLexicon - data/lexicon/{lang}/transitions.json, loaded.
 * @param {{version:number, entries:object}} emotionsLexicon - data/lexicon/{lang}/emotions.json, loaded.
 * @returns {{raw, parsed, from, transition, to, joiner}}
 */
export function parseEmotionArc(raw, transitionsLexicon, emotionsLexicon) {
  const text = String(raw ?? '').trim();
  const joinerMatch = text.match(JOINER_PATTERN);
  if (!joinerMatch) {
    return { raw: text, parsed: false, from: null, transition: null, to: null, joiner: null };
  }

  const joiner = joinerMatch[1].toLowerCase();
  const leftPart = text.slice(0, joinerMatch.index).trim();
  const toPhrase = text.slice(joinerMatch.index + joinerMatch[0].length).trim();

  const transitionMatch = findTransitionSuffix(leftPart, transitionsLexicon);
  if (!transitionMatch || !toPhrase) {
    return { raw: text, parsed: false, from: null, transition: null, to: null, joiner: null };
  }

  const fromPhrase = leftPart.slice(0, leftPart.length - transitionMatch.matchedText.length).trim();
  if (!fromPhrase) {
    return { raw: text, parsed: false, from: null, transition: null, to: null, joiner: null };
  }

  return {
    raw: text,
    parsed: true,
    from: toTranslatedPhrase(fromPhrase, emotionsLexicon),
    transition: { en: transitionMatch.matchedText, ko: transitionMatch.ko },
    to: toTranslatedPhrase(toPhrase, emotionsLexicon),
    joiner,
  };
}

function toTranslatedPhrase(phraseEn, emotionsLexicon) {
  const hit = lookupExact(phraseEn, emotionsLexicon);
  return { en: phraseEn, ko: hit ? hit.ko : null };
}

/**
 * Finds the known transition verb ending `leftPart`, preferring the longest
 * dictionary entry (so "lighting up" wins over a hypothetical "up").
 * Transition entries can be multi-word, so we can't just split on the last
 * space — every dictionary key is tried against the tail of leftPart.
 */
function findTransitionSuffix(leftPart, transitionsLexicon) {
  const normalizedLeft = normalizePhrase(leftPart);
  const candidates = Object.keys(transitionsLexicon.entries).sort((a, b) => b.length - a.length);
  for (const key of candidates) {
    if (normalizedLeft === key || normalizedLeft.endsWith(` ${key}`)) {
      // Recover the original-cased substring so `from` reconstruction (which
      // slices the un-normalized leftPart) lines up in length exactly.
      const matchedText = leftPart.slice(leftPart.length - key.length);
      return { matchedText, ko: transitionsLexicon.entries[key].ko ?? transitionsLexicon.entries[key] };
    }
  }
  return null;
}
