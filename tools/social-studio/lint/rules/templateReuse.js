/**
 * R2 — template reuse within the last N weeks, same channel+platform
 * (spec section 3, severity: error, downgraded to warn when the pool is
 * exhausted).
 *
 * `textpack.templateIds` (a flat {itemId: templateId} map) is what this
 * rule needs from S1. As of TASK-S1/S2, textpack.json does NOT carry this
 * field — S1's generators return {id, text} internally but only ever kept
 * `.text` in the final output. Rather than reach back into S1's generation
 * code from S3 (out of this task's "라우팅·호출 등록 1줄" scope), this rule
 * follows the spec's own explicit fallback: report it as skipped, not
 * broken. See docs/social-package-spec.md for the real-run consequence and
 * lint fixtures for full coverage of the actual reuse logic with synthetic
 * templateIds.
 */

export function check(textpack, context) {
  const { weeks, recentEntries, poolSizes = {} } = context;
  const violations = [];
  const notes = [];

  if (!textpack.templateIds || Object.keys(textpack.templateIds).length === 0) {
    notes.push('R2-templateReuse: textpack.json에 templateId가 기록되어 있지 않습니다 — S1 미완료로 보고하고 건너뜁니다.');
    return { violations, checkedCount: 1, notes };
  }

  if (!recentEntries || recentEntries.length === 0) {
    notes.push(`R2-templateReuse: 최근 ${weeks}주 이내 비교할 과거 기록이 없습니다(첫 실행).`);
    return { violations, checkedCount: 1, notes };
  }

  const usedByPlatform = new Map();
  for (const entry of recentEntries) {
    for (const [itemId, templateId] of Object.entries(entry.templateIds || {})) {
      const platform = itemId.split('.')[0];
      if (!usedByPlatform.has(platform)) usedByPlatform.set(platform, new Set());
      usedByPlatform.get(platform).add(templateId);
    }
  }

  let checkedCount = 0;
  for (const [itemId, templateId] of Object.entries(textpack.templateIds)) {
    checkedCount += 1;
    const platform = itemId.split('.')[0];
    const usedSet = usedByPlatform.get(platform);
    if (!usedSet || !usedSet.has(templateId)) continue;

    const poolSize = poolSizes[platform];
    // 무한 재생성 루프 방지 (spec): 쓸 수 있는 템플릿이 이미 전부 최근에
    // 쓰였다면, 재사용 자체를 계속 error로 잡아봐야 다시 생성해도 또
    // 걸릴 뿐이다 — warn으로 낮추고 "추가 필요"를 알린다.
    const exhausted = Number.isFinite(poolSize) && usedSet.size >= poolSize;
    // value/threshold are binary here (재사용 0회만 허용) rather than a
    // graded metric like R1's similarity score — pool-size context (which
    // may be unknown) goes in comparedWith, so threshold always stays a
    // real number instead of null (completion condition #7).
    violations.push({
      rule: 'R2-templateReuse',
      severity: exhausted ? 'warn' : 'error',
      path: itemId,
      message: exhausted
        ? `템플릿 부족 — 추가 필요 (${platform} 템플릿 ${poolSize}개가 최근 ${weeks}주 안에 모두 사용됨, templateId=${templateId})`
        : `templateId "${templateId}"가 최근 ${weeks}주 안에 ${platform}에서 이미 사용되었습니다.`,
      value: 1,
      threshold: 0,
      comparedWith: { templateId, platform, weeks, poolSize: poolSize ?? null },
      excerpt: `templateId=${templateId}`,
    });
  }

  return { violations, checkedCount: Math.max(checkedCount, 1), notes };
}
