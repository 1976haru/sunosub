/**
 * TASK-S1 — entry point. Wires every platform generator together, runs the
 * hallucination guard (spec section 6) over every Korean-generated field,
 * and writes out/{setName}/textpack.json + textpack.md.
 *
 * Determinism note: nothing in this file's output may depend on wall-clock
 * time (no `new Date()` in the returned textpack) — completion condition #5
 * requires two runs of the same input to produce byte-identical output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTimelineFile } from '../parse/timelineAdapter.js';
import { generateYoutubeSet } from './youtubeSet.js';
import { generateYoutubeShorts } from './youtubeShort.js';
import { generateInstagram, generateX, generateFacebook } from './socialPost.js';
import { generateNaver, generateHatena } from './blogPost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PLATFORM_LIMITS_PATH = path.join(ROOT, 'data', 'platformLimits.json');
const HASHTAG_POOL_PATH = path.join(ROOT, 'templates', '_shared', 'hashtags.json');
const OUT_ROOT = path.join(ROOT, 'out');

const MAX_LEAK_SCAN_MATCHES = 5000;

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

function loadPlatformLimits() {
  return loadJson(PLATFORM_LIMITS_PATH);
}

function loadHashtagPool() {
  return loadJson(HASHTAG_POOL_PATH);
}

// ---------------------------------------------------------------------------
// Hallucination guard (spec section 6)
// ---------------------------------------------------------------------------

function extractYears(text) {
  return new Set(String(text ?? '').match(/\b(?:19|20)\d{2}\b/g) || []);
}

/** Every year that legitimately appears anywhere in the setpack's own text. */
function buildInputYearSet(normalized) {
  const parts = [normalized.set.setName, normalized.set.generatedAt || '', normalized.set.conceptLabel || '', normalized.set.channelLabel || ''];
  for (const s of normalized.songs) {
    parts.push(s.title, s.titleLocalized, s.lyrics, s.listenerSituation.raw, s.hookPhrase || '', s.stylePrompt || '', s.excludePrompt || '');
    if (s.youtube) parts.push(s.youtube.title || '', s.youtube.description || '', ...(s.youtube.tags || []));
  }
  return extractYears(parts.join('\n'));
}

/** Every English word in a song's original (untranslated) title — the spec's explicit exception for the leak check. */
function buildAllowedEnglishWords(normalized) {
  const words = new Set();
  for (const s of normalized.songs) {
    for (const w of s.title.match(/[A-Za-z][A-Za-z'-]*/g) || []) words.add(w.toLowerCase());
  }
  return words;
}

/**
 * Checks one generated text field for (a) a 4-digit year not present
 * anywhere in the input, and (b) — only when `checkLeak` is true — an
 * English word that isn't a song's own original title, a hashtag, or part
 * of the YouTube URL. On any hit, returns text:null (spec: "해당 항목을
 * 비운 뒤 errors 배열에 기록") plus the reasons.
 */
function checkField(fieldName, text, ctx) {
  if (!text) return { text, errors: [] };
  const errors = [];
  let stripped = text;
  if (ctx.youtubeUrl) stripped = stripped.split(ctx.youtubeUrl).join(' ');
  stripped = stripped.replace(/https?:\/\/\S+/g, ' ');
  // naver.bodyHtml is markup, not prose — tag names (<li>, <!-- IMAGE:cover -->)
  // aren't "untranslated English", they're structure. Strip before scanning,
  // but still return the original (unstripped) text when the field passes.
  if (ctx.isHtml) stripped = stripped.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');

  for (const year of stripped.match(/\b(?:19|20)\d{2}\b/g) || []) {
    if (!ctx.inputYears.has(year)) {
      errors.push(`${fieldName}: 입력 데이터에 없는 연도(${year})가 출력에 등장했습니다.`);
    }
  }

  if (ctx.checkLeak) {
    const pattern = /[A-Za-z][A-Za-z'-]*/g;
    let match;
    let iterations = 0;
    while ((match = pattern.exec(stripped)) && iterations < MAX_LEAK_SCAN_MATCHES) {
      iterations += 1;
      const word = match[0];
      if (stripped[match.index - 1] === '#') continue; // hashtag exception
      if (ctx.allowedEnglishWords.has(word.toLowerCase())) continue; // original-title exception
      errors.push(`${fieldName}: 사전으로 커버되지 않은 영어 단어 "${word}"가 한국어 출력에 등장했습니다.`);
    }
  }

  return errors.length > 0 ? { text: null, errors } : { text, errors: [] };
}

function checkTitleProvenance(usedTitles, normalized) {
  const validTitles = new Set(normalized.songs.flatMap((s) => [s.title, s.titleLocalized]));
  const errors = [];
  for (const title of usedTitles) {
    if (!validTitles.has(title)) {
      errors.push(`곡명 검사: 입력 데이터에 없는 곡 제목 "${title}"이 출력에 등장했습니다.`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function generateTextPack(normalized, options = {}) {
  const channelId = normalized.set.channelId;
  const limits = loadPlatformLimits();
  const hashtagPool = loadHashtagPool();
  const timeline = options.timelinePath ? loadTimelineFile(options.timelinePath) : (options.timeline ?? null);
  const youtubeUrl = options.youtubeUrl || '';

  const warnings = [];
  const errors = [];

  const yt = generateYoutubeSet(normalized, { timeline, youtubeUrl, channelId, limits, hashtagPool });
  const shorts = generateYoutubeShorts(normalized, { channelId, hashtagPool, scope: options.shortsScope || 'top3' });
  const instagram = generateInstagram(normalized, { channelId, hashtagPool, limits, youtubeUrl });
  const x = generateX(normalized, { channelId, limits, youtubeUrl });
  const facebook = generateFacebook(normalized, { channelId, limits, youtubeUrl });
  const naver = generateNaver(normalized, { channelId, hashtagPool, limits, youtubeUrl });
  const hatena = generateHatena(normalized, { channelId });

  warnings.push(...yt.warnings, ...shorts.warnings, ...instagram.warnings, ...x.warnings, ...facebook.warnings, ...naver.warnings, ...hatena.warnings);

  // --- guard 1: song-title provenance ---
  errors.push(...checkTitleProvenance([...yt.usedTitles, ...shorts.usedTitles], normalized));

  // --- guard 2+4: year + untranslated-English-leak, field by field ---
  const ctx = {
    inputYears: buildInputYearSet(normalized),
    allowedEnglishWords: buildAllowedEnglishWords(normalized),
    youtubeUrl,
  };
  const korean = (name, text) => checkField(name, text, { ...ctx, checkLeak: true });
  const passthroughOrKorean = (name, text) => checkField(name, text, { ...ctx, checkLeak: false }); // lyricQuote-style: years still checked, English is expected

  yt.titles = yt.titles.map((t, i) => {
    const r = korean(`youtube.titles[${i}]`, t);
    errors.push(...r.errors);
    return r.text;
  }).filter((t) => t !== null);
  {
    const r = korean('youtube.description', yt.description);
    errors.push(...r.errors);
    yt.description = r.text;
  }
  {
    const r = korean('youtube.pinnedComment', yt.pinnedComment);
    errors.push(...r.errors);
    yt.pinnedComment = r.text;
  }
  for (const s of shorts.shorts) {
    const rt = korean(`shorts[${s.trackNo}].titleKo`, s.titleKo);
    errors.push(...rt.errors);
    s.titleKo = rt.text;
    const rd = korean(`shorts[${s.trackNo}].descriptionKo`, s.descriptionKo);
    errors.push(...rd.errors);
    s.descriptionKo = rd.text;
  }
  {
    const r = korean('instagram.caption', instagram.caption);
    errors.push(...r.errors);
    instagram.caption = r.text;
  }
  {
    const r = korean('x.main', x.main);
    errors.push(...r.errors);
    x.main = r.text;
  }
  x.thread = x.thread.map((t, i) => {
    const r = korean(`x.thread[${i}]`, t);
    errors.push(...r.errors);
    return r.text;
  }).filter((t) => t !== null);
  {
    const r = korean('facebook.body', facebook.body);
    errors.push(...r.errors);
    facebook.body = r.text;
  }
  {
    const r = korean('naver.title', naver.title);
    errors.push(...r.errors);
    naver.title = r.text;
  }
  {
    const r = checkField('naver.bodyHtml', naver.bodyHtml, { ...ctx, checkLeak: true, isHtml: true });
    errors.push(...r.errors);
    naver.bodyHtml = r.text;
  }

  // --- guard 3: lyric quote must be a real substring of that song's lyrics (English is expected here — exempt from the leak check) ---
  if (x.lyricQuote) {
    const song = normalized.songs.find((s) => s.trackNo === x.lyricQuoteTrackNo);
    if (!song || !song.lyrics.includes(x.lyricQuote)) {
      errors.push(`x.lyricQuote: 가사 원문에 없는 인용입니다: "${x.lyricQuote}"`);
      x.lyricQuote = null;
    } else {
      const r = passthroughOrKorean('x.lyricQuote', x.lyricQuote);
      errors.push(...r.errors); // year-check only; English is expected and allowed here
    }
  }

  const textpack = {
    setName: normalized.set.setName,
    channelId,
    channelLabel: normalized.set.channelLabel,
    conceptLabel: normalized.set.conceptLabel ?? null,
    youtube: {
      titles: yt.titles,
      description: yt.description,
      hashtags: yt.hashtags,
      tags: yt.tags,
      pinnedComment: yt.pinnedComment,
    },
    shorts: shorts.shorts,
    instagram: {
      caption: instagram.caption,
      hashtags: instagram.hashtags,
      firstComment: instagram.firstComment,
    },
    x: {
      main: x.main,
      thread: x.thread,
      lyricQuote: x.lyricQuote,
    },
    facebook: {
      body: facebook.body,
    },
    naver: {
      title: naver.title,
      bodyHtml: naver.bodyHtml,
      tags: naver.tags,
    },
    hatena,
    warnings,
    errors,
  };

  return textpack;
}

// ---------------------------------------------------------------------------
// textpack.md — human-readable mirror (spec completion condition #11)
// ---------------------------------------------------------------------------

function section(title, body) {
  return `## ${title}\n\n${body || '(생성되지 않음)'}\n`;
}

export function renderMarkdown(textpack) {
  const parts = [`# ${textpack.setName} — 텍스트 팩\n`];

  parts.push(section('① 유튜브 — 제목 후보', textpack.youtube.titles.map((t, i) => `${i + 1}. ${t}`).join('\n')));
  parts.push(section('① 유튜브 — 설명', textpack.youtube.description));
  parts.push(section('① 유튜브 — 해시태그', textpack.youtube.hashtags.join(' ')));
  parts.push(section('① 유튜브 — 태그', textpack.youtube.tags.join(', ')));
  parts.push(section('① 유튜브 — 고정 댓글', textpack.youtube.pinnedComment));

  const shortsBody = textpack.shorts.map((s) =>
    `### 트랙 ${s.trackNo}\n- 한국어 제목: ${s.titleKo ?? '(없음)'}\n- 한국어 설명: ${s.descriptionKo ?? '(없음)'}\n- 원제/원문 설명(영문, 원본 그대로): ${s.title} / ${s.description ?? '(없음)'}\n- 해시태그: ${s.hashtags.join(' ')}`
  ).join('\n\n');
  parts.push(section('② 쇼츠 / 틱톡', shortsBody));

  parts.push(section('③ 인스타그램 — 캡션', textpack.instagram.caption));
  parts.push(section('③ 인스타그램 — 해시태그(30)', textpack.instagram.hashtags.join(' ')));
  parts.push(section('③ 인스타그램 — 첫 댓글', textpack.instagram.firstComment));

  parts.push(section('④ X — 본문', textpack.x.main));
  parts.push(section('④ X — 스레드', textpack.x.thread.map((t, i) => `${i + 1}. ${t}`).join('\n')));
  parts.push(section('④ X — 가사 인용', textpack.x.lyricQuote));

  parts.push(section('⑤ 페이스북', textpack.facebook.body));

  parts.push(section('⑥ 네이버 블로그 — 제목', textpack.naver.title));
  parts.push(section('⑥ 네이버 블로그 — 본문', textpack.naver.bodyHtml));
  parts.push(section('⑥ 네이버 블로그 — 태그', textpack.naver.tags.join(', ')));

  parts.push(section('⑦ 하테나', textpack.hatena.title ? `${textpack.hatena.title}\n\n${textpack.hatena.body}` : null));

  parts.push(section('경고 (warnings)', textpack.warnings.length ? textpack.warnings.map((w) => `- ${w}`).join('\n') : null));
  parts.push(section('오류 (errors)', textpack.errors.length ? textpack.errors.map((e) => `- ${e}`).join('\n') : null));

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

export function runTextPackPipeline(normalized, options = {}) {
  const textpack = generateTextPack(normalized, options);
  const markdown = renderMarkdown(textpack);

  const outDir = path.join(OUT_ROOT, normalized.set.setName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'textpack.json'), JSON.stringify(textpack, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'textpack.md'), markdown, 'utf8');

  return { textpack, markdown, outDir };
}
