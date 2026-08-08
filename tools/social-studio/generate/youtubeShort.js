/**
 * TASK-S1 — per-song shorts/TikTok text.
 *
 * Section 3② of the brief: the per-song `youtube` block written by S0
 * (pass-through of Suno Weaver Studio's own English title/description/tags)
 * is used AS-IS — it's real data, not something to regenerate — and only
 * the Korean pieces it doesn't have (a Korean title, a short Korean
 * description) are filled in from templates/{channelId}/shorts.json.
 */

import { loadTemplateFile, selectTemplateWithinLimit } from './slotFiller.js';
import { rotatedSlice } from './rotation.js';

const DEFAULT_HASHTAG_COUNT = 5; // within the spec's "3~5개" range and equal to platformLimits.tiktok.hashtagMax

function buildSongSlots(song, setSlots) {
  return {
    ...setSlots,
    titleKo: song.titleLocalized,
    titleEn: song.title,
    emotionFromKo: song.emotionArc.parsed ? song.emotionArc.from.ko ?? '' : '',
    emotionToKo: song.emotionArc.parsed ? song.emotionArc.to.ko ?? '' : '',
  };
}

function buildOneShort(song, templates, setSlots, setName, hashtagPool) {
  const slots = buildSongSlots(song, setSlots);
  const salt = `shorts-${song.trackNo}`;

  const titlePick = selectTemplateWithinLimit(templates, slots, setName, `${salt}-title`, { role: 'title' }, { maxRetries: 5 });
  const descPick = selectTemplateWithinLimit(templates, slots, setName, `${salt}-desc`, { role: 'description' }, { maxRetries: 5 });

  const hashtags = rotatedSlice(setName, salt, hashtagPool.shorts, DEFAULT_HASHTAG_COUNT);

  return {
    trackNo: song.trackNo,
    title: song.youtube?.title || song.title, // original English metadata preferred, per spec 3②
    titleKo: titlePick.withinLimit ? titlePick.text : null,
    description: song.youtube?.description || null,
    descriptionKo: descPick.withinLimit ? descPick.text : null,
    tagsEn: song.youtube?.tags || [],
    hashtags,
    warning: !titlePick.withinLimit ? `트랙 ${song.trackNo}의 쇼츠 한국어 제목을 만들지 못했습니다.` : null,
  };
}

/**
 * Picks the "top" songs for scope:'top3'. TASK-S7: Suno Weaver Studio's v2
 * export adds a per-song qualityScore — when at least one song in the set
 * carries one, it becomes the ranking key (stable sort, so ties keep trackNo
 * order — this is why the all-zero real sample still slices identically to
 * the old behavior). v1 sets have no qualityScore at all, so this falls back
 * to the original "상위 = trackNo 오름차순" rule untouched.
 */
export function pickTopSongs(songs, count) {
  const hasScores = songs.some((s) => typeof s.qualityScore === 'number');
  if (!hasScores) return songs.slice(0, count);
  return [...songs]
    .sort((a, b) => (b.qualityScore ?? -Infinity) - (a.qualityScore ?? -Infinity))
    .slice(0, count);
}

/**
 * @param {'top3'|'all'} scope - default 'top3' (spec 3②: "기본은 상위 3곡").
 *   "상위"는 trackNo 오름차순 — 별도 인기도/순위 데이터가 없으므로 세트
 *   순서를 그대로 신뢰한다. qualityScore가 있으면 그 값을 우선한다(위 참조).
 */
export function generateYoutubeShorts(normalized, { channelId, hashtagPool, scope = 'top3' } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'shorts');
  const setSlots = {
    channelLabel: normalized.set.channelLabel,
    conceptLabel: normalized.set.conceptLabel || '',
    seasonKo: normalized.set.seasonHint?.ko ?? '',
  };

  const songs = scope === 'all' ? normalized.songs : pickTopSongs(normalized.songs, 3);
  const shorts = songs.map((song) => buildOneShort(song, templates, setSlots, setName, hashtagPool));
  const warnings = shorts.map((s) => s.warning).filter(Boolean);

  return {
    shorts: shorts.map(({ warning, ...rest }) => rest),
    warnings,
    usedTitles: songs.map((s) => s.titleLocalized),
  };
}
