/**
 * TASK-S9 작업 C — 곡 목록 한 줄 조립을 여기 하나로 모은다.
 *
 * "한글제목 (원제)" 형식은 titleLocalized가 실제 번역일 때만 의미가 있다.
 * TASK-S7의 titleLocalized 폴백(원문 없음 → title을 그대로 씀) 상태에서는
 * 두 값이 같아서 "Hold the Morning Light (Hold the Morning Light)"처럼
 * 똑같은 문자열이 괄호 안팎에 반복된다 — 정보가 아니라 잡음이다.
 * `song.titleLocalizedFallback`을 우선 보고, 혹시 그 플래그가 없는 오래된
 * normalized.json이 들어와도 두 값이 문자 그대로 같으면 마찬가지로 괄호를
 * 생략한다(둘 다 만족하지 않아도 안전하게 동작).
 *
 * 유튜브 설명문(youtubeSet.js)·네이버 본문(blogPost.js) 둘 다 이 함수를
 * 쓴다 — 같은 버그를 두 곳에 따로 고치다 하나를 빠뜨리는 일을 막기 위해서다.
 */
/**
 * "titleLocalized (title)" — or just "titleLocalized" when titleLocalized is
 * a TASK-S7 fallback (or, belt-and-suspenders, the two values are simply
 * identical). No trackNo prefix — for a single-song slot value like
 * shorts.json's `{titleWithOriginal}` (generate/youtubeShort.js).
 */
export function formatTitleWithOriginal(song) {
  const isFallback = Boolean(song.titleLocalizedFallback) || song.titleLocalized === song.title;
  return isFallback ? song.titleLocalized : `${song.titleLocalized} (${song.title})`;
}

export function formatSongListLine(song) {
  return `${song.trackNo}. ${formatTitleWithOriginal(song)}`;
}

/** Plain "\n"-joined list, one formatSongListLine() per song — used where the caller wraps each line itself (e.g. blogPost.js's <li>). */
export function buildSongListLines(songs) {
  return songs.map(formatSongListLine);
}

/** "\n"-joined plain-text list (youtube.description). */
export function buildSongListText(songs) {
  return buildSongListLines(songs).join('\n');
}
