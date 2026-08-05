/**
 * R1 — cross-channel similarity (spec section 3, severity: error).
 *
 * Deliberately pure: `context.candidates` is already-loaded data
 * ([{ setName, channelId, textpack }]), not something this module fetches
 * itself. lint/socialLint.js is the only place that calls
 * store/lintHistory.js's listOtherSetsInSameWeek()/loadTextpackForSet() to
 * build that list — keeping the fetch and the check separate is what makes
 * this rule trivially fixture-testable (spec completion condition #2).
 */

import { jaccardSimilarity, extractProseFields, buildExcerpt } from '../similarity.js';

const MAX_COMPARISONS = 5000; // explicit bound (completion condition #11)

export function check(textpack, context) {
  const { threshold, candidates } = context;
  const violations = [];
  const notes = [];

  if (!candidates || candidates.length === 0) {
    notes.push('R1-crossChannel: 같은 주차의 다른 채널 데이터가 없어 비교하지 못했습니다(첫 실행 또는 이번 주 단일 채널).');
    return { violations, checkedCount: 1, notes };
  }

  const currentItems = extractProseFields(textpack);
  let comparisons = 0;
  let checkedCount = 0;

  comparisonLoop:
  for (const item of currentItems) {
    for (const candidate of candidates) {
      const candidateItems = extractProseFields(candidate.textpack);
      for (const otherItem of candidateItems) {
        if (comparisons >= MAX_COMPARISONS) break comparisonLoop;
        comparisons += 1;
        if (otherItem.path !== item.path) continue; // only compare the same field across channels
        checkedCount += 1;
        const value = jaccardSimilarity(item.text, otherItem.text);
        if (value > threshold) {
          violations.push({
            rule: 'R1-crossChannel',
            severity: 'error',
            path: item.path,
            message: `${candidate.channelId} 채널 ${candidate.setName}의 ${otherItem.path}와 유사도 ${value.toFixed(2)} (임계 ${threshold})`,
            value: Number(value.toFixed(4)),
            threshold,
            comparedWith: { setName: candidate.setName, path: otherItem.path },
            excerpt: buildExcerpt(item.text),
          });
        }
      }
    }
  }

  if (checkedCount === 0) {
    notes.push('R1-crossChannel: 같은 항목 경로를 가진 비교 대상이 없어 비교하지 못했습니다.');
    checkedCount = 1;
  }

  return { violations, checkedCount, notes };
}
