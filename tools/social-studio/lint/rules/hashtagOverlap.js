/**
 * R3 — hashtag set overlap vs the last N weeks, same channel+platform
 * (spec section 3, severity: warn).
 */

const HASHTAG_PLATFORMS = ['youtube', 'instagram'];

export function check(textpack, context) {
  const { threshold, weeks, recentEntries } = context;
  const violations = [];
  const notes = [];

  if (!recentEntries || recentEntries.length === 0) {
    notes.push(`R3-hashtagOverlap: 최근 ${weeks}주 이내 비교할 과거 해시태그 기록이 없습니다(첫 실행).`);
    return { violations, checkedCount: 1, notes };
  }

  let checkedCount = 0;
  for (const platform of HASHTAG_PLATFORMS) {
    const currentTags = textpack[platform]?.hashtags;
    if (!Array.isArray(currentTags) || currentTags.length === 0) continue;

    const pastSet = new Set();
    for (const entry of recentEntries) {
      for (const tag of entry.hashtags?.[platform] || []) pastSet.add(tag);
    }
    if (pastSet.size === 0) continue;

    checkedCount += 1;
    const currentSet = new Set(currentTags);
    let overlap = 0;
    for (const tag of currentSet) if (pastSet.has(tag)) overlap += 1;
    const ratio = overlap / currentSet.size;

    if (ratio > threshold) {
      violations.push({
        rule: 'R3-hashtagOverlap',
        severity: 'warn',
        path: `${platform}.hashtags`,
        message: `${platform} 해시태그가 최근 ${weeks}주 해시태그와 ${(ratio * 100).toFixed(0)}% 겹칩니다 (임계 ${(threshold * 100).toFixed(0)}%).`,
        value: Number(ratio.toFixed(4)),
        threshold,
        comparedWith: { weeks, overlapCount: overlap, totalCount: currentSet.size },
        excerpt: currentTags.slice(0, 5).join(' '),
      });
    }
  }

  if (checkedCount === 0) {
    notes.push('R3-hashtagOverlap: 비교할 과거 해시태그 데이터가 없습니다.');
    checkedCount = 1;
  }

  return { violations, checkedCount, notes };
}
