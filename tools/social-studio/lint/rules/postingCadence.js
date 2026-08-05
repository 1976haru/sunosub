/**
 * R6 — posting cadence: too many items landing within 24h on the same
 * platform account (spec section 3, severity: warn).
 *
 * `context.currentDate` is resolved via store/lintHistory.js's
 * resolvePostingDate() — the ONE seam the spec asks for so S4 can later
 * swap "set creation date" for a real scheduled timestamp without this
 * rule changing.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES_SCANNED = 2000; // explicit bound

export function collectPlatforms(textpack) {
  const platforms = [];
  if (textpack.youtube) platforms.push('youtube');
  if (textpack.naver) platforms.push('naver');
  if (textpack.facebook) platforms.push('facebook');
  if (textpack.x) platforms.push('x');
  if (textpack.instagram) platforms.push('instagram');
  if (Array.isArray(textpack.shorts) && textpack.shorts.length) platforms.push('shorts');
  return platforms;
}

export function check(textpack, context) {
  const { maxPostsPer24h, currentDate, recentEntries } = context;
  const violations = [];
  const notes = [];
  const platforms = collectPlatforms(textpack);

  if (!currentDate) {
    notes.push('R6-postingCadence: setName에서 날짜를 읽을 수 없어 발행 간격을 계산하지 못했습니다.');
    return { violations, checkedCount: 1, notes };
  }
  if (!recentEntries || recentEntries.length === 0) {
    notes.push('R6-postingCadence: 비교할 과거 발행 기록이 없습니다(첫 실행).');
    return { violations, checkedCount: 1, notes };
  }

  const scanned = recentEntries.slice(0, MAX_ENTRIES_SCANNED);
  let checkedCount = 0;

  for (const platform of platforms) {
    checkedCount += 1;
    const within = scanned.filter((e) => {
      if (!e.platforms?.includes(platform)) return false;
      const otherDate = Date.parse(e.postingDate);
      return Number.isFinite(otherDate) && Math.abs(otherDate - currentDate.getTime()) < WINDOW_MS;
    });
    const count = within.length + 1; // +1 for the current set itself
    if (count > maxPostsPer24h) {
      violations.push({
        rule: 'R6-postingCadence',
        severity: 'warn',
        path: platform,
        message: `${platform} 계정에 24시간 내 예정된 항목이 ${count}건입니다 (임계 ${maxPostsPer24h}건).`,
        value: count,
        threshold: maxPostsPer24h,
        comparedWith: { setNames: within.map((e) => e.setName) },
        excerpt: within.map((e) => e.setName).join(', '),
      });
    }
  }

  return { violations, checkedCount: Math.max(checkedCount, 1), notes };
}
