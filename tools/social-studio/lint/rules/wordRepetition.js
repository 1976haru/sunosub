/**
 * R7 — in-caption word repetition (spec section 3, severity: warn).
 *
 * Stemming heuristic per spec: "조사·어미가 붙은 형태도 같은 것으로 본다
 * (어간 앞 2음절 이상 일치로 판정)" — no morphological analyzer (무설치
 * 원칙), just "same first-2-syllable prefix counts as the same word". This
 * is deliberately crude (a real analyzer would separate a genuinely
 * different word that happens to share a 2-character prefix), which is why
 * this rule is warn, not error — a human reviews the flagged excerpt.
 *
 * Scoped to Korean syllable blocks only (not Latin letters): a "2-syllable"
 * prefix is a meaningful, information-dense unit in Korean, but the same
 * rule applied to 2 English LETTERS produces nonsense groupings — running
 * against the real sample set surfaced exactly this: "Never"/"Neon"/
 * "Neighborhood" (from song titles kept verbatim in {titleEn} slots)
 * grouped as "repeats of Ne", and naver.bodyHtml's own `<li>` tags counted
 * as the word "li" repeated 36 times. Neither is caption repetition.
 */

import { extractProseFields, buildExcerpt } from '../similarity.js';

const TOKEN_PATTERN = /[가-힣]+/g;
const MAX_TOKENS_PER_ITEM = 3000; // explicit bound

function stemKey(token) {
  return token.length >= 2 ? token.slice(0, 2) : token;
}

export function check(textpack, context) {
  const { maxNounRepeat } = context;
  const items = extractProseFields(textpack);
  const violations = [];
  let checkedCount = 0;

  for (const item of items) {
    checkedCount += 1;
    const tokens = (item.text.match(TOKEN_PATTERN) || []).slice(0, MAX_TOKENS_PER_ITEM);
    const buckets = new Map(); // stemKey -> { count, examples: Set }

    for (const token of tokens) {
      if (token.length < 2) continue;
      const key = stemKey(token);
      if (!buckets.has(key)) buckets.set(key, { count: 0, examples: new Set() });
      const bucket = buckets.get(key);
      bucket.count += 1;
      bucket.examples.add(token);
    }

    for (const [key, bucket] of buckets) {
      if (bucket.count >= maxNounRepeat) {
        violations.push({
          rule: 'R7-wordRepetition',
          severity: 'warn',
          path: item.path,
          message: `"${key}"로 시작하는 단어가 ${bucket.count}회 반복됩니다 (임계 ${maxNounRepeat}회): ${[...bucket.examples].join(', ')}`,
          value: bucket.count,
          threshold: maxNounRepeat,
          comparedWith: { stem: key, forms: [...bucket.examples] },
          excerpt: buildExcerpt(item.text),
        });
      }
    }
  }

  return { violations, checkedCount: Math.max(checkedCount, 1) };
}
