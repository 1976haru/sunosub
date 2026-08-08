/**
 * TASK-S1 — set-video (18-song) YouTube text: titles, description, chapters,
 * hashtags, tags, pinned comment.
 *
 * No sentence here is hardcoded — buildSetSlots() only computes SLOT VALUES
 * (a Korean word/phrase from normalized.json or a dictionary), never a full
 * sentence. All sentences are read from templates/{channelId}/*.json via
 * generate/slotFiller.js. buildSetSlots() is exported because socialPost.js
 * and blogPost.js need the exact same slot context.
 */

import { loadTemplateFile, selectTemplateWithinLimit, fillSlots } from './slotFiller.js';
import { pickDistinctIndices, rotatedSlice } from './rotation.js';
import { rankSceneTerms, loadSceneNounWeights, isSceneNounCategory } from '../parse/setPackLoader.js';
import { pickTopSongs } from './youtubeShort.js';
import { buildSongListText } from './songListFormat.js';

const MAX_TITLE_ATTEMPTS = 200;
const MAX_TAG_TRIM_ITERATIONS = 20;

// ---------------------------------------------------------------------------
// Slot context
// ---------------------------------------------------------------------------

function topByFrequency(values, limit) {
  const counts = new Map();
  const order = [];
  for (const v of values) {
    if (!v) continue;
    if (!counts.has(v)) {
      counts.set(v, 0);
      order.push(v);
    }
    counts.set(v, counts.get(v) + 1);
  }
  return order.sort((a, b) => counts.get(b) - counts.get(a)).slice(0, limit);
}

/** Top Korean time-of-day word (아침/저녁/밤...) from listenerSituation matches — deliberately excludes category:"season" words, which seasonKo already covers. */
function deriveTimeKo(normalized) {
  const times = [];
  for (const song of normalized.songs) {
    for (const term of song.listenerSituation.matchedTerms) {
      if (term.source === 'timewords' && term.category === 'time') times.push(term.ko);
    }
  }
  return topByFrequency(times, 1)[0] ?? '';
}

/** Top "from"-side emotion across the set — the symmetric counterpart to set.dominantEmotions (which is "to"-side only). */
function deriveDominantFromKo(normalized) {
  const fromValues = normalized.songs
    .filter((s) => s.emotionArc.parsed)
    .map((s) => s.emotionArc.from.ko)
    .filter(Boolean);
  return topByFrequency(fromValues, 1)[0] ?? '';
}

/**
 * "Scene noun" slots (sceneNoun1..3 in templates) read best as an actual
 * thing/place ("주전자", "해변 산책로"), not a body part, abstract concept,
 * quantifier, or bare verb form. TASK-S9: which categories those are is now
 * config, not a hardcoded `category !== 'object' && category !== 'place'`
 * check here — this shares setPackLoader.js's isSceneNounCategory() /
 * data/sceneNounWeights.json's excludeCategories with set.sceneNouns (S0),
 * so a category edit (e.g. removing "body" to let "어깨" back in) takes
 * effect in both the report AND the actual template slots at once, not just
 * one of them. Built from the same per-song matchedTerms S0 already
 * recorded (both listenerSituation and, TASK-S8, v2's lyricThemeText — no
 * re-scanning of raw text needed).
 *
 * TASK-S8: this used to be its own plain top-by-frequency count, completely
 * separate from normalized.set.sceneNouns's ranking — a word appearing in
 * nearly every song (table/window/road) would win these slots even after
 * S0's sceneNouns list was fixed to prefer rarer, more scene-specific words,
 * because nothing here ever looked at that fix. Sharing setPackLoader.js's
 * rankSceneTerms()/sceneNounWeights.json closes that gap: the sentences
 * templates actually fill in now use the same rarity weighting the set-level
 * report does. See docs/social-package-spec.md TASK-S8 section for the
 * "손, 창문, 식탁만 계속 나온다" bug this fixes.
 */
function deriveSceneNouns(normalized, limit, excludeSceneNouns) {
  const exclude = excludeSceneNouns instanceof Set ? excludeSceneNouns : new Set(excludeSceneNouns || []);
  const weights = loadSceneNounWeights();
  const termInfo = new Map();
  const track = (matchedTerms, trackNo) => {
    for (const term of matchedTerms) {
      if (!isSceneNounCategory(term.category, weights)) continue;
      if (exclude.has(term.ko)) continue;
      if (!termInfo.has(term.ko)) {
        termInfo.set(term.ko, { songs: new Set(), category: term.category, order: termInfo.size });
      }
      termInfo.get(term.ko).songs.add(trackNo);
    }
  };
  for (const song of normalized.songs) {
    track(song.listenerSituation.matchedTerms, song.trackNo);
    if (song.lyricThemeText) track(song.lyricThemeText.matchedTerms, song.trackNo);
  }
  return rankSceneTerms(termInfo, weights, limit);
}

/**
 * TASK-S8 — "대표곡 3곡" slot for longer-form templates (Instagram caption,
 * etc.). Reuses generate/youtubeShort.js's pickTopSongs() (qualityScore
 * descending when present, else trackNo order) so "representative" means
 * the same thing here as it does for shorts selection — one definition, not
 * two independently-invented ones.
 */
function buildTopSongsList(normalized) {
  return pickTopSongs(normalized.songs, 3)
    .map((s, i) => `${i + 1}. ${s.titleLocalized}`)
    .join('\n');
}

/**
 * Slot context shared by every "set-level" platform (youtube set video,
 * instagram, x, facebook, naver). Per-song platforms (shorts) build their
 * own context in generate/youtubeShort.js.
 *
 * `excludeSceneNouns` — TASK-S8 (R8 intraSetRepetition regeneration): a
 * Set/array of ko strings to drop from sceneNoun1-3 candidates before
 * ranking, so a reroll after "this word repeated across platforms" doesn't
 * just pick the exact same word again. Omit for the normal, unrestricted
 * derivation every pre-S8 caller still gets.
 */
export function buildSetSlots(normalized, { youtubeUrl, excludeSceneNouns } = {}) {
  const set = normalized.set;
  const sceneNouns = deriveSceneNouns(normalized, 3, excludeSceneNouns);
  return {
    channelLabel: set.channelLabel || '',
    conceptLabel: set.conceptLabel || '',
    trackCount: String(set.trackCount ?? ''),
    sceneNoun1: sceneNouns[0] ?? '',
    sceneNoun2: sceneNouns[1] ?? '',
    sceneNoun3: sceneNouns[2] ?? '',
    emotionToKo: set.dominantEmotions[0] ?? '',
    emotionFromKo: deriveDominantFromKo(normalized),
    seasonKo: set.seasonHint?.ko ?? '',
    timeKo: deriveTimeKo(normalized),
    topSongsList: buildTopSongsList(normalized),
    youtubeUrl: youtubeUrl || '',
  };
}

// ---------------------------------------------------------------------------
// Titles (3 distinct, each <= platformLimits.youtube.titleMax)
// ---------------------------------------------------------------------------

export function buildTitles(templates, slots, setName, limits) {
  const order = pickDistinctIndices(setName, 'yt-title', templates.length, templates.length);
  const attempts = Math.min(order.length, MAX_TITLE_ATTEMPTS);
  const results = [];
  const seen = new Set();
  for (let i = 0; i < attempts && results.length < 3; i += 1) {
    const template = templates[order[i]];
    const filled = fillSlots(template.text, slots);
    if (filled === null) continue;
    if (filled.length > limits.youtube.titleMax) continue;
    if (seen.has(filled)) continue;
    seen.add(filled);
    results.push({ id: template.id, text: filled });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

function formatChapterTime(totalSeconds, forceHours) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (forceHours || h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Builds YouTube chapter lines from the (optional) timeline + song list.
 * Enforces every rule YouTube itself requires to recognize chapters (spec
 * section 3①): first at 00:00, >=3 entries, ascending, each >=10s apart.
 * Any violation means NO chapters are emitted (a broken chapter list makes
 * YouTube ignore the whole thing) — returns { chapters: null, warning }.
 */
export function buildChapters(timeline, songs) {
  if (!timeline || !Array.isArray(timeline.tracks) || timeline.tracks.length === 0) {
    return { chapters: null, warning: '타임라인 없음 — 챕터 생략' };
  }

  const songByTrackNo = new Map(songs.map((s) => [s.trackNo, s]));
  const rows = [];
  for (const track of timeline.tracks) {
    const song = songByTrackNo.get(track.trackNo);
    if (!song || typeof track.startSec !== 'number') continue;
    rows.push({ startSec: track.startSec, label: song.titleLocalized });
  }

  if (rows.length < 3) {
    return { chapters: null, warning: `챕터 조건 미충족(최소 3개 필요, ${rows.length}개) — 챕터를 생략했습니다.` };
  }
  if (rows[0].startSec !== 0) {
    return { chapters: null, warning: '첫 챕터가 00:00이 아니어서 챕터를 생략했습니다.' };
  }
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].startSec - rows[i - 1].startSec;
    if (gap < 10) {
      return { chapters: null, warning: `챕터 간격이 10초 미만(${gap}초, ${i}번째)이어서 챕터를 생략했습니다.` };
    }
  }

  const forceHours = rows[rows.length - 1].startSec >= 3600;
  const lines = rows.map((row) => `${formatChapterTime(row.startSec, forceHours)} ${row.label}`);
  return { chapters: lines.join('\n'), warning: null };
}

// ---------------------------------------------------------------------------
// Description (intro -> chapters -> song list -> closing)
// ---------------------------------------------------------------------------

export function buildDescription(templates, slots, songs, chaptersResult, setName, limits) {
  const warnings = [];
  const songListText = buildSongListText(songs);
  const structuralParts = [chaptersResult.chapters, songListText].filter(Boolean);
  const structuralLen = structuralParts.join('\n\n').length;

  const introPick = selectTemplateWithinLimit(templates, slots, setName, 'yt-desc-intro', { role: 'intro' }, {
    measure: (text) => text.length + 2 + structuralLen,
    maxLength: limits.youtube.descMax,
    maxRetries: 5,
  });
  if (!introPick.withinLimit) warnings.push('설명문 도입부가 글자수 제한을 초과해 비웠습니다.');
  const introText = introPick.withinLimit ? introPick.text : '';

  const priorLen = (introText ? introText.length + 2 : 0) + structuralLen;
  const closingPick = selectTemplateWithinLimit(templates, slots, setName, 'yt-desc-closing', { role: 'closing' }, {
    measure: (text) => priorLen + 2 + text.length,
    maxLength: limits.youtube.descMax,
    maxRetries: 5,
  });
  if (!closingPick.withinLimit) warnings.push('설명문 고정 문구가 글자수 제한을 초과해 비웠습니다.');
  const closingText = closingPick.withinLimit ? closingPick.text : '';

  const description = [introText, chaptersResult.chapters, songListText, closingText].filter(Boolean).join('\n\n');
  return { description, warnings };
}

// ---------------------------------------------------------------------------
// Hashtags / tags (from templates/{channelId}/hashtags/*.json pools, not
// templated sentences — TASK-S8 split youtube.json (display hashtags) from
// youtube-tags.json (search-term tags); see textPack.js's loadHashtagPools).
// ---------------------------------------------------------------------------

export function buildHashtags(pool, setName, limits) {
  return rotatedSlice(setName, 'yt-hashtags', pool.youtube, limits.youtube.hashtagCount);
}

export function buildTags(pool, setName, limits) {
  let tags = rotatedSlice(setName, 'yt-tags', pool.youtubeTags, limits.youtube.tagCount);
  let iterations = 0;
  while (tags.join(', ').length > limits.youtube.tagsTotalMax && tags.length > 0 && iterations < MAX_TAG_TRIM_ITERATIONS) {
    tags = tags.slice(0, -1);
    iterations += 1;
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Pinned comment
// ---------------------------------------------------------------------------

export function buildPinnedComment(templates, slots, setName) {
  const pick = selectTemplateWithinLimit(templates, slots, setName, 'yt-pinned', null, { maxRetries: 5 });
  return pick.withinLimit ? pick.text : null;
}

// ---------------------------------------------------------------------------
// Top-level orchestration for this platform
// ---------------------------------------------------------------------------

export function generateYoutubeSet(normalized, { timeline, youtubeUrl, channelId, limits, hashtagPool } = {}) {
  const setName = normalized.set.setName;
  const slots = buildSetSlots(normalized, { youtubeUrl });
  const warnings = [];

  const titleTemplates = loadTemplateFile(channelId, 'youtube-title');
  const titles = buildTitles(titleTemplates, slots, setName, limits);
  if (titles.length === 0) warnings.push('유튜브 제목 후보를 하나도 만들지 못했습니다.');
  // TASK-S8: titleMin is a soft floor — buildTitles() already only accepts
  // titleMax; a short-but-valid title is kept (never blanked), just flagged.
  const titleMin = limits.youtube.titleMin;
  if (typeof titleMin === 'number') {
    const short = titles.filter((t) => t.text.length < titleMin);
    if (short.length > 0) {
      warnings.push(`유튜브 제목 후보 중 ${short.length}개가 최소 글자수(${titleMin}자) 미만입니다.`);
    }
  }

  const chaptersResult = buildChapters(timeline, normalized.songs);
  if (chaptersResult.warning) warnings.push(chaptersResult.warning);

  const descTemplates = loadTemplateFile(channelId, 'youtube-desc');
  const { description, warnings: descWarnings } = buildDescription(
    descTemplates, slots, normalized.songs, chaptersResult, setName, limits
  );
  warnings.push(...descWarnings);

  const hashtags = buildHashtags(hashtagPool, setName, limits);
  const tags = buildTags(hashtagPool, setName, limits);

  const pinnedTemplates = loadTemplateFile(channelId, 'youtube-pinned');
  const pinnedComment = buildPinnedComment(pinnedTemplates, slots, setName);
  if (!pinnedComment) warnings.push('고정 댓글을 글자수 제한 안에서 만들지 못했습니다.');

  return {
    titles: titles.map((t) => t.text),
    description,
    hashtags,
    tags,
    pinnedComment,
    warnings,
    usedTitles: normalized.songs.map((s) => s.titleLocalized), // referenced in the song list — provenance for the hallucination guard
  };
}
