/**
 * R9 — cross-platform hashtag/tag overlap within the SAME set (TASK-S8,
 * severity: warn). Distinct from R3 (hashtagOverlap.js), which compares one
 * platform's CURRENT hashtags against that SAME platform's OWN past weeks.
 * R9 compares different PLATFORMS of the same set against each other, right
 * now — the thing that broke when every platform drew from one shared pool
 * (templates/_shared/hashtags.json, since split into
 * templates/{channelId}/hashtags/{youtube,youtube-tags,instagram,naver}.json
 * — see docs/social-package-spec.md TASK-S8 section).
 *
 * Overlap ratio = |intersection| / min(|A|, |B|) — an overlap coefficient,
 * not Jaccard, since the two pools being compared are drawn from
 * differently-sized platform limits (naver.tags has 10, instagram.hashtags
 * has 30) and "half of the smaller pool" is the more useful red flag than
 * a size-skewed Jaccard would be.
 */

const PLATFORM_TAG_FIELDS = [
  { path: 'youtube.hashtags', get: (tp) => tp.youtube?.hashtags },
  { path: 'youtube.tags', get: (tp) => tp.youtube?.tags },
  { path: 'instagram.hashtags', get: (tp) => tp.instagram?.hashtags },
  { path: 'naver.tags', get: (tp) => tp.naver?.tags },
];

export function check(textpack, context) {
  const { threshold } = context;
  const violations = [];
  let checkedCount = 0;

  const groups = PLATFORM_TAG_FIELDS
    .map((f) => ({ path: f.path, items: f.get(textpack) }))
    .filter((g) => Array.isArray(g.items) && g.items.length > 0);

  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      checkedCount += 1;
      const a = new Set(groups[i].items);
      const b = new Set(groups[j].items);
      let overlap = 0;
      for (const x of a) if (b.has(x)) overlap += 1;
      const denom = Math.min(a.size, b.size);
      const ratio = denom === 0 ? 0 : overlap / denom;

      if (ratio > threshold) {
        violations.push({
          rule: 'R9-crossPlatformHashtagOverlap',
          severity: 'warn',
          path: `${groups[i].path}<->${groups[j].path}`,
          message: `${groups[i].path}와(과) ${groups[j].path}의 해시태그/태그가 ${(ratio * 100).toFixed(0)}% 겹칩니다 (임계 ${(threshold * 100).toFixed(0)}%).`,
          value: Number(ratio.toFixed(4)),
          threshold,
          comparedWith: { a: groups[i].path, b: groups[j].path, overlapCount: overlap, sizeA: a.size, sizeB: b.size },
          excerpt: [...a].filter((x) => b.has(x)).slice(0, 5).join(' '),
        });
      }
    }
  }

  return { violations, checkedCount: Math.max(checkedCount, 1) };
}
