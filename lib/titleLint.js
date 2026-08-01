/**
 * TASK CS-v1.7 — the timeline tool's "괄호 제목 AI 채우기" kept returning
 * literal dictionary compounds ("Tide Calendar" -> "물때표") instead of the
 * scene-based titles the channel needs, and prompt tuning alone did not
 * reliably fix it (see routes/timeline.js's /translate-titles comment — a
 * shorter, more focused prompt helped, but nothing in prompting guarantees
 * the model won't regress). This project already learned this lesson once
 * with the genre-diversity linter; the fix there was the same shape: stop
 * trying to make the model never fail, and instead have code catch it when
 * it does.
 *
 * Korean gets the full check (word-count parity + ending pattern), because
 * "1:1 literal compound" is a meaningful, checkable shape in Korean: a
 * literal gloss preserves the source's word count and ends on a bare noun,
 * while a scene-based title almost always adds a verb ending or a
 * connective ("~던", "~하면", "~았다") that a word-for-word gloss wouldn't
 * have. Japanese does not have this same word-count correspondence with
 * English compounds (particles and word order differ too much for a
 * reliable signal), so ja only gets the language-agnostic checks: minimum
 * length, the banned-string list, and duplicate detection within a pack.
 */

// Known real failures from CS-v1.7's bug report. An exact match against
// this list is always a literal-translation failure, regardless of any
// other heuristic below.
const BANNED_EXACT = new Set([
  '물때표',
  '앨범 먼지',
  '주전자 모퉁이',
  '봉투 조명',
  '플랫폼 목도리',
  '첫빛의 잔',
  '태양선',
]);

const MIN_LENGTH_NO_SPACES = 6;

// A scene-based Korean title almost always ends on a verb/adjective ending
// or a connective rather than a bare noun or a particle-marked noun phrase.
// This list is deliberately permissive (checks the tail of the string) —
// it only needs to catch the common "literal gloss" shape, not classify
// grammar precisely.
const KO_NARRATIVE_ENDING = /(다|던|때|면|을|를|은|는|이|가|서|고|길|밤|날|아침|저녁|무렵|즈음|사이)$/;

function stripSpaces(text) {
  return String(text || '').replace(/\s/g, '');
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Checks one localized title against its English seed title.
 * Returns { failed: boolean, reasons: string[] }.
 */
export function lintTitle(sourceTitle, localizedTitle, lang) {
  const reasons = [];
  const localized = String(localizedTitle || '').trim();

  // An empty string is the model's explicit "already in target language"
  // signal (see /translate-titles) — never a lint failure.
  if (!localized) return { failed: false, reasons: [] };

  if (BANNED_EXACT.has(localized)) {
    reasons.push('알려진 직역 실패 문자열과 정확히 일치');
  }

  if (stripSpaces(localized).length < MIN_LENGTH_NO_SPACES) {
    reasons.push(`너무 짧음(공백 제외 ${MIN_LENGTH_NO_SPACES}자 미만) — 장면을 담을 수 없음`);
  }

  if (lang === 'ko') {
    const sourceWords = countWords(sourceTitle);
    const localizedWords = countWords(localized);
    const hasNarrativeEnding = KO_NARRATIVE_ENDING.test(localized.replace(/[.,!?"']+$/, ''));
    if (sourceWords > 0 && sourceWords === localizedWords && !hasNarrativeEnding) {
      reasons.push('원제와 어절 수가 같고 서술형 어미/조사가 없음 — 1:1 직역 의심');
    }
  }

  return { failed: reasons.length > 0, reasons };
}

/**
 * Lints a whole localized pack. `sources` and `localized` are parallel
 * arrays (same order/length as the /translate-titles request). Duplicate
 * detection is pack-wide, so it runs here rather than in lintTitle().
 */
export function lintPack(sources, localized, lang) {
  const results = localized.map((title, i) => {
    const { failed, reasons } = lintTitle(sources[i], title, lang);
    return { index: i, title: String(title || '').trim(), failed, reasons: [...reasons] };
  });

  const seen = new Map();
  results.forEach((r) => {
    if (!r.title) return;
    if (!seen.has(r.title)) seen.set(r.title, []);
    seen.get(r.title).push(r.index);
  });
  for (const indices of seen.values()) {
    if (indices.length < 2) continue;
    indices.forEach((i) => {
      results[i].failed = true;
      results[i].reasons.push('팩 내 중복된 제목');
    });
  }

  return results;
}
