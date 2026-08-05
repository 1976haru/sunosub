/**
 * TASK-S2 — file-backed state for the copy/paste screen.
 *
 * Three files live under out/{setName}/, all owned by this module:
 *   - textpack.json         (S1's output — never written here, read-only)
 *   - textpack.edited.json  (per-item text overrides from inline editing)
 *   - pack-state.json       (youtubeUrl + per-item checkmarks)
 *
 * Every write goes through atomicWriteJson(): write to a temp file in the
 * same directory, then fs.renameSync over the real path. A rename within one
 * filesystem is atomic, so a crash mid-write can never leave a half-written
 * JSON file on disk (spec completion condition #9).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateX, effectiveXLength } from '../generate/socialPost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'out');
const PLATFORM_LIMITS_PATH = path.join(ROOT, 'data', 'platformLimits.json');
const CHANNEL_STYLE_PATH = path.join(ROOT, 'data', 'channelStyle.json');

const DEFAULT_SECTIONS = ['youtube', 'naver', 'facebook', 'x', 'instagram', 'shorts'];
const MAX_LIST_ENTRIES = 5000; // explicit bound for any directory-listing loop

export class PackStateError extends Error {}

// ---------------------------------------------------------------------------
// setName whitelist — every other function in this module trusts this check
// ---------------------------------------------------------------------------

/** True only for a bare directory name that (a) can't escape out/ and (b) actually holds a textpack.json. */
export function isValidSetName(setName) {
  if (typeof setName !== 'string' || !setName) return false;
  if (setName.includes('..') || setName.includes('/') || setName.includes('\\') || setName.includes('\0')) return false;
  const candidate = path.resolve(OUT_ROOT, setName);
  const outRootResolved = path.resolve(OUT_ROOT);
  if (candidate !== path.join(outRootResolved, setName) && !candidate.startsWith(outRootResolved + path.sep)) return false;
  return fs.existsSync(path.join(candidate, 'textpack.json'));
}

export function getOutDir(setName) {
  if (!isValidSetName(setName)) {
    throw new PackStateError(`허용되지 않는 setName입니다: ${setName}`);
  }
  return path.join(OUT_ROOT, setName);
}

/** Resolves a (setName, subPath) pair to a real path GUARANTEED to be inside that set's out/ directory — used by the /reveal route. Never trusts a client path beyond this check. */
export function resolveWithinOutDir(setName, subPath = '') {
  const outDir = getOutDir(setName);
  const outDirResolved = path.resolve(outDir);
  const candidate = path.resolve(outDir, subPath || '.');
  if (candidate !== outDirResolved && !candidate.startsWith(outDirResolved + path.sep)) {
    throw new PackStateError(`out/ 밖의 경로는 열 수 없습니다: ${subPath}`);
  }
  return candidate;
}

/** Directory names under out/ that actually have a textpack.json — for a future set-picker; bounded read. */
export function listAvailableSetNames() {
  if (!fs.existsSync(OUT_ROOT)) return [];
  const entries = fs.readdirSync(OUT_ROOT, { withFileTypes: true }).slice(0, MAX_LIST_ENTRIES);
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(OUT_ROOT, e.name, 'textpack.json')))
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Low-level JSON I/O
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return readJsonFile(filePath);
  } catch {
    return fallback;
  }
}

/** Write-temp-then-rename: the on-disk file is either the old complete version or the new complete version, never a partial write. */
export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function hashContent(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// The three files
// ---------------------------------------------------------------------------

export function loadTextpack(setName) {
  return readJsonIfExists(path.join(getOutDir(setName), 'textpack.json'), null);
}

export function loadEdits(setName) {
  return readJsonIfExists(path.join(getOutDir(setName), 'textpack.edited.json'), { originalHash: null, overrides: {} });
}

export function loadState(setName) {
  return readJsonIfExists(path.join(getOutDir(setName), 'pack-state.json'), { youtubeUrl: '', checks: {} });
}

export function saveState(setName, patch) {
  const dir = getOutDir(setName);
  const current = loadState(setName);
  const next = {
    ...current,
    ...patch,
    checks: { ...current.checks, ...(patch.checks || {}) },
  };
  atomicWriteJson(path.join(dir, 'pack-state.json'), next);
  return next;
}

/** Saves one item's override text. Also stamps textpack.json's CURRENT hash, so a later S1 rerun that changes textpack.json can be detected (see buildDisplayItems' originalChanged). */
export function saveEdit(setName, itemId, value) {
  const dir = getOutDir(setName);
  const textpack = loadTextpack(setName);
  if (!textpack) throw new PackStateError('textpack.json이 없습니다.');
  const edits = loadEdits(setName);
  const next = {
    originalHash: hashContent(textpack),
    overrides: { ...edits.overrides, [itemId]: value },
  };
  atomicWriteJson(path.join(dir, 'textpack.edited.json'), next);
  return next;
}

export function revertEdit(setName, itemId) {
  const dir = getOutDir(setName);
  const edits = loadEdits(setName);
  const overrides = { ...edits.overrides };
  delete overrides[itemId];
  const next = { ...edits, overrides };
  atomicWriteJson(path.join(dir, 'textpack.edited.json'), next);
  return next;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadPlatformLimits() {
  return readJsonFile(PLATFORM_LIMITS_PATH);
}

/** Which platform sections this channel uses, and in what order — spec: "코드에 하드코딩하지 말고 채널 설정에서 읽는다". */
export function loadChannelSections(channelId) {
  const data = readJsonFile(CHANNEL_STYLE_PATH);
  return data.channels?.[channelId]?.sections ?? data.default?.sections ?? DEFAULT_SECTIONS;
}

// ---------------------------------------------------------------------------
// Live X-section regeneration once a YouTube URL becomes available
// ---------------------------------------------------------------------------

/**
 * textpack.json is written BEFORE the video is uploaded (spec section 3-2),
 * so x.main is very often null in the stored file — there was no URL to put
 * in it yet. Once the user applies a URL in the screen, X's post has to be
 * generated for the first time, not just recounted. This re-derives it from
 * out/{setName}/normalized.json (S0's output, already on disk) using S1's
 * own generateX() — same templates, same rotation, same 23-char URL rule —
 * so the result is identical to what a full S1 rerun with that URL would
 * have produced. textpack.json itself is never touched.
 */
function tryRegenerateX(setName, channelId, youtubeUrl, limits) {
  try {
    const normalizedPath = path.join(getOutDir(setName), 'normalized.json');
    if (!fs.existsSync(normalizedPath)) return null;
    const normalized = readJsonFile(normalizedPath);
    return generateX(normalized, { channelId, limits, youtubeUrl });
  } catch {
    return null; // fall back to textpack.json's stored (possibly null) value
  }
}

// ---------------------------------------------------------------------------
// Item model — every copyable row on the screen, in one place
// ---------------------------------------------------------------------------

function computeCount(value, limitUnit) {
  const text = String(value ?? '');
  if (limitUnit === 'space-count') return text.trim() ? text.trim().split(/\s+/).length : 0;
  if (limitUnit === 'comma-count') return text.trim() ? text.trim().split(',').map((s) => s.trim()).filter(Boolean).length : 0;
  return text.length; // 'chars' and the default
}

function computeSeverity(count, limit) {
  if (limit === null || limit === undefined) return null;
  if (count > limit) return 'over';
  if (count >= limit * 0.9) return 'warn';
  return 'ok';
}

function buildRawItems(textpack, limits, xLive) {
  const items = [];
  const push = (id, section, label, value, opts = {}) => items.push({ id, section, label, value: value ?? '', ...opts });

  (textpack.youtube.titles || []).forEach((t, i) => {
    push(`youtube.titles.${i}`, 'youtube', `제목 (후보 ${i + 1})`, t, { group: 'youtube.titles', limit: limits.youtube.titleMax, limitUnit: 'chars' });
  });
  push('youtube.description', 'youtube', '설명문', textpack.youtube.description, { limit: limits.youtube.descMax, limitUnit: 'chars', multiline: true });
  push('youtube.hashtags', 'youtube', `해시태그 ${textpack.youtube.hashtags.length}개`, textpack.youtube.hashtags.join(' '), { limit: limits.youtube.hashtagCount, limitUnit: 'space-count' });
  push('youtube.tags', 'youtube', `태그 ${textpack.youtube.tags.length}개`, textpack.youtube.tags.join(', '), { limit: limits.youtube.tagsTotalMax, limitUnit: 'chars' });
  push('youtube.pinnedComment', 'youtube', '고정 댓글', textpack.youtube.pinnedComment, {});

  push('naver.title', 'naver', '제목', textpack.naver.title, {});
  push('naver.bodyHtml', 'naver', '본문', textpack.naver.bodyHtml, { multiline: true, hasFolder: true });
  push('naver.tags', 'naver', `태그 ${textpack.naver.tags.length}개`, textpack.naver.tags.join(', '), { limit: limits.naver.tagMax, limitUnit: 'comma-count' });

  push('facebook.body', 'facebook', '본문', textpack.facebook.body, { limit: limits.facebook.postMax, limitUnit: 'chars', multiline: true });

  const xMainValue = xLive ? xLive.main : textpack.x.main;
  // Applies whenever x.main contains a URL at all — whether it was baked in
  // by the original S1 run or just regenerated live by tryRegenerateX() —
  // not only when this request happens to be the one applying a new URL.
  const xMainCountOverride = xMainValue ? effectiveXLength(xMainValue, limits.x.urlLength) : undefined;
  push('x.main', 'x', '본문', xMainValue, { limit: limits.x.postMax, limitUnit: 'chars', countOverride: xMainCountOverride });
  push('x.thread', 'x', '스레드', ((xLive ? xLive.thread : textpack.x.thread) || []).join('\n\n'), { multiline: true });
  push('x.lyricQuote', 'x', '가사 인용', xLive ? xLive.lyricQuote : textpack.x.lyricQuote, {});

  push('instagram.caption', 'instagram', '캡션', textpack.instagram.caption, { limit: limits.instagram.captionMax, limitUnit: 'chars', multiline: true });
  push('instagram.hashtags', 'instagram', `해시태그 ${textpack.instagram.hashtags.length}개`, textpack.instagram.hashtags.join(' '), { limit: limits.instagram.hashtagMax, limitUnit: 'space-count' });
  push('instagram.firstComment', 'instagram', '첫 댓글', textpack.instagram.firstComment, {});

  for (const s of textpack.shorts || []) {
    push(`shorts.${s.trackNo}.titleKo`, 'shorts', `트랙 ${s.trackNo} 제목`, s.titleKo, {});
    push(`shorts.${s.trackNo}.descriptionKo`, 'shorts', `트랙 ${s.trackNo} 설명`, s.descriptionKo, { limit: limits.tiktok.captionMax, limitUnit: 'chars' });
    push(`shorts.${s.trackNo}.hashtags`, 'shorts', `트랙 ${s.trackNo} 해시태그`, (s.hashtags || []).join(' '), { limit: limits.tiktok.hashtagMax, limitUnit: 'space-count' });
  }

  return items;
}

/**
 * The single source of truth for what the screen renders: merges
 * textpack.json + textpack.edited.json + pack-state.json, recomputes X live
 * if a URL is set, and returns a flat item list plus section order.
 */
export function buildDisplayItems(setName) {
  const textpack = loadTextpack(setName);
  if (!textpack) throw new PackStateError('textpack.json이 없습니다.');
  const edits = loadEdits(setName);
  const state = loadState(setName);
  const limits = loadPlatformLimits();
  const sectionOrder = loadChannelSections(textpack.channelId);

  const currentHash = hashContent(textpack);
  const originalChanged = Boolean(edits.originalHash) && edits.originalHash !== currentHash;

  let xLive = null;
  if (state.youtubeUrl) {
    const regenerated = tryRegenerateX(setName, textpack.channelId, state.youtubeUrl, limits);
    if (regenerated) xLive = { ...regenerated, youtubeUrl: state.youtubeUrl };
  }

  const rawItems = buildRawItems(textpack, limits, xLive);

  const items = rawItems
    .filter((item) => item.value)
    .map((item) => {
      const overridden = Object.prototype.hasOwnProperty.call(edits.overrides, item.id);
      const value = overridden ? edits.overrides[item.id] : item.value;
      const count = !overridden && item.countOverride !== undefined ? item.countOverride : computeCount(value, item.limitUnit);
      return {
        id: item.id,
        section: item.section,
        group: item.group ?? null,
        label: item.label,
        value,
        original: item.value,
        edited: overridden,
        multiline: Boolean(item.multiline),
        hasFolder: Boolean(item.hasFolder),
        limit: item.limit ?? null,
        limitUnit: item.limitUnit ?? null,
        count,
        severity: computeSeverity(count, item.limit ?? null),
        checked: Boolean(state.checks?.[item.id]),
      };
    });

  const sections = sectionOrder.filter((sec) => items.some((i) => i.section === sec));

  return {
    setName,
    channelId: textpack.channelId,
    channelLabel: textpack.channelLabel ?? '',
    conceptLabel: textpack.conceptLabel ?? '',
    youtubeUrl: state.youtubeUrl || '',
    sections,
    items,
    total: items.length,
    checkedCount: items.filter((i) => i.checked).length,
    originalChanged,
    warnings: textpack.warnings || [],
  };
}

export function isKnownItemId(setName, itemId) {
  return buildDisplayItems(setName).items.some((i) => i.id === itemId);
}
