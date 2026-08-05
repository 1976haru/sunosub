/**
 * R5 — banned/exaggerated phrases (spec section 3, severity: warn).
 * `context.phrases` is already the merged `_shared` + per-channel list from
 * data/bannedPhrases.json (socialLint.js does the merge).
 */

import { extractProseFields, buildExcerpt } from '../similarity.js';

const MAX_SCANS = 5000; // explicit bound on the items × phrases scan

export function check(textpack, context) {
  const { phrases } = context;
  const violations = [];
  const items = extractProseFields(textpack);
  let checkedCount = 0;
  let scans = 0;

  scanLoop:
  for (const item of items) {
    for (const phrase of phrases) {
      if (scans >= MAX_SCANS) break scanLoop;
      scans += 1;
      checkedCount += 1;
      const index = item.text.indexOf(phrase);
      if (index === -1) continue;
      violations.push({
        rule: 'R5-bannedPhrases',
        severity: 'warn',
        path: item.path,
        message: `금지 표현 "${phrase}"이(가) 포함되어 있습니다.`,
        value: 1,
        threshold: 0,
        comparedWith: { phrase },
        excerpt: buildExcerpt(item.text.slice(Math.max(0, index - 20))),
      });
    }
  }

  return { violations, checkedCount: Math.max(checkedCount, 1) };
}
