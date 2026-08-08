/**
 * TASK-S1 — Instagram / X / Facebook text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplateFile, selectTemplateWithMinMaxLength, selectDistinctTemplates } from './slotFiller.js';
import { pickIndex, rotatedSlice } from './rotation.js';
import { buildSetSlots } from './youtubeSet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_STYLE_PATH = path.join(__dirname, '..', 'data', 'channelStyle.json');
const MAX_LYRIC_LINE_SCAN = 200;
// TASK-S8 — retry budget for selectTemplateWithMinMaxLength's minLength
// search (instagram caption / X main / facebook body). The pre-existing
// maxLength-only retries elsewhere in this file stay at 5; empirically, 5
// was too tight here against the real template pools — deterministic
// rotation for an actual setName can place every "long enough" template
// just past the 5th slot (verified against both real sample sets), and a
// too-strict budget would fall back to a short template even though a
// longer one existed a few positions later. Still a small explicit bound,
// not unlimited (completion condition #16).
const MIN_LENGTH_MAX_RETRIES = 12;

function loadChannelStyle(channelId) {
  const raw = fs.readFileSync(CHANNEL_STYLE_PATH, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  return data.channels?.[channelId] ?? data.default;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

/**
 * `excludeSceneNouns` — TASK-S8, forwarded to buildSetSlots for R8
 * (intraSetRepetition) regeneration; see youtubeSet.js's buildSetSlots doc.
 */
export function generateInstagram(normalized, { channelId, hashtagPool, limits, youtubeUrl, excludeSceneNouns } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'instagram');
  const slots = buildSetSlots(normalized, { youtubeUrl, excludeSceneNouns });
  const warnings = [];

  const captionPick = selectTemplateWithMinMaxLength(templates, slots, setName, 'ig-caption', null, {
    maxLength: limits.instagram.captionMax,
    minLength: limits.instagram.captionMin ?? 0,
    maxRetries: MIN_LENGTH_MAX_RETRIES,
  });
  if (!captionPick.withinLimit) {
    warnings.push('인스타그램 캡션을 글자수 제한 안에서 만들지 못했습니다.');
  } else if (!captionPick.metMinLength) {
    warnings.push(`인스타그램 캡션이 최소 글자수(${limits.instagram.captionMin}자)에 못 미칩니다: ${captionPick.text.length}자.`);
  }

  const hashtags = rotatedSlice(setName, 'ig-hashtags', hashtagPool.instagram, limits.instagram.hashtagMax);

  return {
    caption: captionPick.withinLimit ? captionPick.text : null,
    hashtags,
    firstComment: hashtags.join(' '),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

/**
 * Effective length: X shortens ANY http(s) URL to its own t.co-style link
 * and always counts that as platformLimits.x.urlLength chars, regardless of
 * the URL's real length (spec 3④) — so this detects a URL substring by
 * pattern rather than requiring the caller to already know its exact value.
 * That matters for S2's pack.html screen: it needs to recompute this count
 * for whatever URL ended up in x.main, including one baked in at S1
 * generation time before the screen ever saw it.
 */
export function effectiveXLength(text, urlLength) {
  const match = text.match(/https?:\/\/\S+/);
  if (!match) return text.length;
  return text.length - match[0].length + urlLength;
}

function pickLyricQuote(normalized, setName) {
  const songIndex = pickIndex(setName, 'x-lyric-song', normalized.songs.length);
  const song = normalized.songs[songIndex];
  const lines = song.lyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_LYRIC_LINE_SCAN);
  if (lines.length === 0) return null;
  const lineIndex = pickIndex(setName, 'x-lyric-line', lines.length);
  return { trackNo: song.trackNo, quote: lines[lineIndex] };
}

// TASK-S8 작업 G — meta.lyricLanguage와 출력 언어가 다르면 가사 인용을 만들지
// 않는다. "영어 가사면 원문 그대로 쓴다"는 S1의 원칙 자체는 맞지만, 시니어
// 대상 한국어 게시물에 영어 한 줄만 툭 나가면 아무도 못 읽는다 — 의역을
// 지어내는 대신 아예 생략하고 이유를 warnings에 남긴다.
const LYRIC_LANGUAGE_BY_OUTPUT = { ko: 'korean', ja: 'japanese' };
const LYRIC_LANGUAGE_LABELS = { english: '영어', korean: '한국어', japanese: '일본어' };

function lyricLanguageMatchesOutput(normalized) {
  const expected = LYRIC_LANGUAGE_BY_OUTPUT[normalized.set.outputLanguage];
  return !expected || expected === normalized.set.lyricLanguage;
}

export function generateX(normalized, { channelId, limits, youtubeUrl, excludeSceneNouns } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'x');
  const slots = buildSetSlots(normalized, { youtubeUrl, excludeSceneNouns });
  const warnings = [];

  let main = null;
  if (!youtubeUrl) {
    warnings.push('유튜브 URL이 없어 X 본문을 생성하지 않았습니다.');
  } else {
    const mainPick = selectTemplateWithMinMaxLength(templates, slots, setName, 'x-main', { role: 'main' }, {
      measure: (text) => effectiveXLength(text, limits.x.urlLength),
      maxLength: limits.x.postMax,
      minLength: limits.x.postMin ?? 0,
      maxRetries: MIN_LENGTH_MAX_RETRIES,
    });
    if (!mainPick.withinLimit) {
      warnings.push('X 본문을 글자수 제한 안에서 만들지 못했습니다(URL 23자 계산 포함).');
    } else if (!mainPick.metMinLength) {
      warnings.push(`X 본문이 최소 글자수(${limits.x.postMin}자)에 못 미칩니다: ${effectiveXLength(mainPick.text, limits.x.urlLength)}자.`);
    }
    main = mainPick.withinLimit ? mainPick.text : null;
  }

  let thread = [];
  try {
    thread = selectDistinctTemplates(templates, slots, setName, 'x-thread', 3, { role: 'thread' }).map((t) => t.text);
  } catch {
    warnings.push('X 스레드 후속 글을 만들지 못했습니다.');
  }

  let lyricQuote = null;
  let lyricQuoteTrackNo = null;
  if (!lyricLanguageMatchesOutput(normalized)) {
    const label = LYRIC_LANGUAGE_LABELS[normalized.set.lyricLanguage] ?? normalized.set.lyricLanguage;
    warnings.push(`가사가 ${label}이므로 인용을 생략했습니다.`);
  } else {
    const lyricPick = pickLyricQuote(normalized, setName);
    lyricQuote = lyricPick?.quote ?? null;
    lyricQuoteTrackNo = lyricPick?.trackNo ?? null;
    if (!lyricQuote) warnings.push('인용할 가사 줄을 찾지 못했습니다.');
  }

  return {
    main,
    thread,
    lyricQuote,
    lyricQuoteTrackNo,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

export function generateFacebook(normalized, { channelId, limits, youtubeUrl, excludeSceneNouns } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'facebook');
  const slots = buildSetSlots(normalized, { youtubeUrl, excludeSceneNouns });
  const style = loadChannelStyle(channelId);
  const warnings = [];

  const bodyPick = selectTemplateWithMinMaxLength(templates, slots, setName, 'fb-body', null, {
    maxLength: limits.facebook.postMax,
    minLength: limits.facebook.postMin ?? 0,
    maxRetries: MIN_LENGTH_MAX_RETRIES,
  });
  if (!bodyPick.withinLimit) {
    warnings.push('페이스북 본문을 글자수 제한 안에서 만들지 못했습니다.');
  } else if (!bodyPick.metMinLength) {
    warnings.push(`페이스북 본문이 최소 글자수(${limits.facebook.postMin}자)에 못 미칩니다: ${bodyPick.text.length}자.`);
  }

  const body = bodyPick.withinLimit
    ? bodyPick.text.split('\n').join(style.facebookParagraphBreak)
    : null;

  return { body, warnings };
}
