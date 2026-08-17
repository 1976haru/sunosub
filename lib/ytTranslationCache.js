/*
 * TASK CS-v1.8 — per-language translation cache. Re-translating the same
 * video (same model + title + description + language) used to cost a full
 * paid call every time, even for languages that had already succeeded.
 *
 * Keyed per language, not per batch: a batch is just "however many
 * languages fit this call's token budget" (tools/yt/app.js's
 * estimateBatchSize()) and that grouping can change from one run to the
 * next (different selection, different description length). The actual
 * generated text for a given language never depends on which other
 * languages rode along in the same request, so keying by batch would
 * invalidate everything whenever the batching just happened to come out
 * differently — keying by language is the only grouping that's actually
 * stable.
 *
 * The cache key folds in `model` and the full `title`/`description` text
 * (not a video ID — this tool also accepts manually-typed title/description
 * with no video at all), so editing either by even one character produces a
 * different key and is treated as new content, never as a stale hit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', '.yt_translation_cache.json');

// "영상 200개 정도" — an entry's `videoKey` groups it with the model+title+
// description tuple it came from; eviction drops whole videoKeys (all their
// cached languages together), oldest-touched first, once more than this
// many distinct videos are cached.
const MAX_VIDEOS = 200;

/*
 * TASK CS-v1.8 follow-up -- bump whenever the hash formula in hash() changes.
 * loadCache() drops the whole cache file (silently -- see its comment) when
 * the stored version doesn't match, because entries hashed under an old
 * formula aren't just "possibly stale" -- they're keyed under a scheme this
 * code no longer computes, so they'd never be found again anyway. Explicit
 * version-gating makes that drop intentional and visible in the diff,
 * instead of relying on "the key format silently changed so old keys
 * silently stop matching" as the de facto invalidation mechanism.
 */
// TASK CS-v2.1 작업 B — scope('title'/'full')가 키 구성에 추가되면서 다시
// 올린다. scope:'title' 항목(설명 번역 없음)의 키가 scope:'full' 항목과
// 겹치면, 나중에 'full'로 요청했을 때 설명이 빠진 결과가 그대로 캐시
// 히트로 반환되는 조용한 오염이 생긴다 — 버전을 올려 v2 항목은 전부
// 버리고 다시 만든다(CS-v1.8 때와 같은 처리).
const CACHE_VERSION = 3;

/*
 * v1 joined parts with a single separator character -- ambiguous, because
 * that separator character can also occur *inside* a part (title/description
 * text is arbitrary Unicode; a translation model's output is not guaranteed
 * to exclude any particular code point), so two different input arrays could
 * hash identically. Length-prefixing each part (netstring/Bencode-style
 * framing: "<length>:<part>") removes the ambiguity and needs no separator
 * between entries at all -- each segment is self-delimiting: given the
 * length, a parser always knows exactly where that part ends and the next
 * length prefix begins, so no part's content can ever be mistaken for a
 * boundary.
 */
function hash(...parts) {
  return createHash('sha256').update(parts.map((p) => `${p.length}:${p}`).join('')).digest('hex');
}

function videoKeyFor(model, title, description) {
  return hash(model, title, description);
}

// TASK CS-v2.1 작업 B — scope를 키에 포함한다. videoKeyFor()는 그대로
// 둔다: videoKey는 "이 영상의 항목들을 한 묶음으로 축출(evict)한다"는
// 용도일 뿐이라, 같은 영상의 title-only 항목과 full 항목은 여전히 같은
// videoKey 아래 함께 묶여야 한다(축출 시 따로따로 도는 게 아니라 영상
// 단위로 같이 빠져야 함).
function entryKeyFor(model, title, description, language, scope) {
  return hash(model, title, description, language, scope);
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return { version: CACHE_VERSION, entries: {} };
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    if (!data || typeof data.entries !== 'object' || data.entries === null) return { version: CACHE_VERSION, entries: {} };
    if (data.version !== CACHE_VERSION) return { version: CACHE_VERSION, entries: {} }; // old hash scheme -- entries under it are unreachable anyway, drop silently
    return data;
  } catch {
    return { version: CACHE_VERSION, entries: {} }; // corrupt cache is safe to drop — every entry is re-derivable from a real translate call
  }
}

function saveCache(data) {
  const tmpPath = path.join(__dirname, '..', `.yt_translation_cache.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, CACHE_PATH);
}

function evictOldVideos(data) {
  const videoLastTouch = new Map();
  for (const entry of Object.values(data.entries)) {
    const prev = videoLastTouch.get(entry.videoKey);
    if (!prev || entry.updatedAt > prev) videoLastTouch.set(entry.videoKey, entry.updatedAt);
  }
  if (videoLastTouch.size <= MAX_VIDEOS) return data;

  const oldestFirst = [...videoLastTouch.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const dropVideoKeys = new Set(oldestFirst.slice(0, videoLastTouch.size - MAX_VIDEOS).map(([key]) => key));
  for (const [entryKey, entry] of Object.entries(data.entries)) {
    if (dropVideoKeys.has(entry.videoKey)) delete data.entries[entryKey];
  }
  return data;
}

/**
 * Splits `languages` into what's already cached (`hit`, with the stored
 * translation) and what still needs a real call (`miss`, just the language
 * names, in the same order they were requested).
 */
export function getCachedTranslations({ model, title, description, languages, scope }) {
  const data = loadCache();
  const hit = [];
  const miss = [];
  for (const language of languages) {
    const entry = data.entries[entryKeyFor(model, title, description, language, scope)];
    if (entry) hit.push({ language, translatedTitle: entry.translatedTitle, translatedDescription: entry.translatedDescription });
    else miss.push(language);
  }
  return { hit, miss };
}

/** Stores every result from one /translate call (including a partial/salvaged batch) in a single read-modify-write. */
export function setCachedTranslations({ model, title, description, results, scope }) {
  if (!results.length) return;
  const data = loadCache();
  const vKey = videoKeyFor(model, title, description);
  const now = new Date().toISOString();
  for (const result of results) {
    data.entries[entryKeyFor(model, title, description, result.language, scope)] = {
      videoKey: vKey,
      language: result.language,
      scope,
      translatedTitle: result.translatedTitle,
      translatedDescription: result.translatedDescription,
      updatedAt: now,
    };
  }
  saveCache(evictOldVideos(data));
}
