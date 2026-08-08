/**
 * R8 — same sceneNoun repeated across too many of THIS SET's OWN platform
 * items (TASK-S8, severity: warn but still drives regeneration).
 *
 * Distinct from R1 (cross-CHANNEL similarity, different sets) and R7
 * (repetition WITHIN one item). This is one set's own text leaning on the
 * same scene word — e.g. "식탁" — in its naver/facebook/x/x-thread posts,
 * because every platform's buildSetSlots() call used to derive the exact
 * same top-3 sceneNoun values (see generate/youtubeSet.js's deriveSceneNouns
 * and docs/social-package-spec.md's TASK-S8 section).
 *
 * `context.normalized` is the full normalized.json for this set (loaded by
 * socialLint.js via store/lintHistory.js's loadNormalizedForSet). The
 * candidate pool is normalized.set.sceneNouns (S0's rarity-ranked top-12),
 * MINUS whatever the current {timeKo} slot value is.
 *
 * Why the top-12, not just the "current" sceneNoun1-3: this rule doubles as
 * the safety net that catches a regeneration attempt (generate/textPack.js's
 * buildRegenerateFn) accidentally trading one repeated word for another —
 * excluding the original top-3 forces the next generation to pick from
 * further down the ranked list, and THAT word needs to be checked too, on
 * the next runLintWithRegeneration() iteration. Restricting to only
 * sceneNoun1-3 would make every reroll invisible to this rule after the
 * first one.
 *
 * Why {timeKo} is excluded: it's deliberately the SAME value across every
 * platform by design (deriveTimeKo() in generate/youtubeSet.js) — that's
 * consistency, not the repetition bug this rule targets. Importing a
 * generator here mirrors R4 (platformRules.js), which already imports
 * generate/socialPost.js's effectiveXLength() for the same reason — only
 * socialLint.js itself keeps the "never imports a generator" rule.
 */

import { buildExcerpt } from '../similarity.js';
import { buildSetSlots } from '../../generate/youtubeSet.js';

const ITEM_PATHS = ['naver.bodyHtml', 'facebook.body', 'x.main', 'x.thread'];
const MAX_SCANS = 5000; // explicit bound on the sceneNouns × items scan

function getItemText(textpack, itemPath) {
  if (itemPath === 'x.thread') {
    return Array.isArray(textpack.x?.thread) ? textpack.x.thread.join(' ') : '';
  }
  const [platform, field] = itemPath.split('.');
  return textpack[platform]?.[field] || '';
}

export function check(textpack, context) {
  const { normalized, maxAcrossPlatforms } = context;
  let sceneNouns = [];
  if (normalized) {
    const timeKo = buildSetSlots(normalized, {}).timeKo;
    const channelLabel = normalized.set.channelLabel || '';
    // A sceneNoun that happens to be a literal substring of the channel's
    // own brand name (e.g. "라디오" inside "굿모닝 추억라디오") will match in
    // nearly every post via {channelLabel} alone, regardless of whether it
    // was ever picked as a scene word — that's an expected brand mention,
    // not the repetition this rule targets, and excluding it from candidacy
    // wouldn't even help (the brand name isn't slot-excludable).
    sceneNouns = (normalized.set.sceneNouns || []).filter((ko) => ko && ko !== timeKo && !channelLabel.includes(ko));
  }
  const violations = [];
  let checkedCount = 0;
  let scans = 0;

  const items = ITEM_PATHS.map((p) => ({ path: p, text: getItemText(textpack, p) })).filter((i) => i.text);

  scanLoop:
  for (const noun of sceneNouns) {
    if (!noun) continue;
    checkedCount += 1;
    const hitItems = [];
    for (const item of items) {
      if (scans >= MAX_SCANS) break scanLoop;
      scans += 1;
      if (item.text.includes(noun)) hitItems.push(item);
    }
    if (hitItems.length > maxAcrossPlatforms) {
      for (const item of hitItems) {
        const idx = item.text.indexOf(noun);
        violations.push({
          rule: 'R8-intraSetRepetition',
          severity: 'warn',
          regenerate: true,
          path: item.path,
          message: `"${noun}"이(가) 같은 세트의 ${hitItems.length}개 항목에 반복 등장합니다 (임계 ${maxAcrossPlatforms}개 초과): ${hitItems.map((h) => h.path).join(', ')}`,
          value: hitItems.length,
          threshold: maxAcrossPlatforms,
          comparedWith: { sceneNoun: noun, items: hitItems.map((h) => h.path) },
          excerpt: buildExcerpt(item.text.slice(Math.max(0, idx - 20))),
        });
      }
    }
  }

  return { violations, checkedCount: Math.max(checkedCount, 1) };
}
