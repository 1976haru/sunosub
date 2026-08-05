/**
 * TASK-S1 — Instagram / X / Facebook text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplateFile, selectTemplateWithinLimit, selectDistinctTemplates } from './slotFiller.js';
import { pickIndex, rotatedSlice } from './rotation.js';
import { buildSetSlots } from './youtubeSet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_STYLE_PATH = path.join(__dirname, '..', 'data', 'channelStyle.json');
const MAX_LYRIC_LINE_SCAN = 200;

function loadChannelStyle(channelId) {
  const raw = fs.readFileSync(CHANNEL_STYLE_PATH, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  return data.channels?.[channelId] ?? data.default;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

export function generateInstagram(normalized, { channelId, hashtagPool, limits, youtubeUrl } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'instagram');
  const slots = buildSetSlots(normalized, { youtubeUrl });
  const warnings = [];

  const captionPick = selectTemplateWithinLimit(templates, slots, setName, 'ig-caption', null, {
    maxLength: limits.instagram.captionMax,
    maxRetries: 5,
  });
  if (!captionPick.withinLimit) warnings.push('인스타그램 캡션을 글자수 제한 안에서 만들지 못했습니다.');

  const hashtags = rotatedSlice(setName, 'ig-hashtags', hashtagPool.hashtags, limits.instagram.hashtagMax);

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

export function generateX(normalized, { channelId, limits, youtubeUrl } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'x');
  const slots = buildSetSlots(normalized, { youtubeUrl });
  const warnings = [];

  let main = null;
  if (!youtubeUrl) {
    warnings.push('유튜브 URL이 없어 X 본문을 생성하지 않았습니다.');
  } else {
    const mainPick = selectTemplateWithinLimit(templates, slots, setName, 'x-main', { role: 'main' }, {
      measure: (text) => effectiveXLength(text, limits.x.urlLength),
      maxLength: limits.x.postMax,
      maxRetries: 5,
    });
    if (!mainPick.withinLimit) warnings.push('X 본문을 글자수 제한 안에서 만들지 못했습니다(URL 23자 계산 포함).');
    main = mainPick.withinLimit ? mainPick.text : null;
  }

  let thread = [];
  try {
    thread = selectDistinctTemplates(templates, slots, setName, 'x-thread', 3, { role: 'thread' }).map((t) => t.text);
  } catch {
    warnings.push('X 스레드 후속 글을 만들지 못했습니다.');
  }

  const lyricPick = pickLyricQuote(normalized, setName);
  const lyricQuote = lyricPick?.quote ?? null;
  if (!lyricQuote) warnings.push('인용할 가사 줄을 찾지 못했습니다.');

  return {
    main,
    thread,
    lyricQuote,
    lyricQuoteTrackNo: lyricPick?.trackNo ?? null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

export function generateFacebook(normalized, { channelId, limits, youtubeUrl } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'facebook');
  const slots = buildSetSlots(normalized, { youtubeUrl });
  const style = loadChannelStyle(channelId);
  const warnings = [];

  const bodyPick = selectTemplateWithinLimit(templates, slots, setName, 'fb-body', null, {
    maxLength: limits.facebook.postMax,
    maxRetries: 5,
  });
  if (!bodyPick.withinLimit) warnings.push('페이스북 본문을 글자수 제한 안에서 만들지 못했습니다.');

  const body = bodyPick.withinLimit
    ? bodyPick.text.split('\n').join(style.facebookParagraphBreak)
    : null;

  return { body, warnings };
}
