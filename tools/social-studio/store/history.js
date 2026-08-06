/**
 * TASK-S6 — the single, unified publish-history store. Everything S1
 * (rotation), S3 (dedup rules), and S2 (completion checks) previously kept
 * in separate, disconnected memories (setName hash / pack-state.json /
 * lintHistory.json) now reads and writes through this one file. Nothing
 * outside this module may read store/data/history.json directly (spec
 * completion condition #11) — every other file gets at it only through the
 * functions exported here.
 *
 * The one rule every function in this file respects: generating a text
 * pack is not the same as publishing it. Only `status: 'published'` counts
 * toward template exhaustion (getUsedTemplateIds) and posting cadence
 * (getPostingTimes) — see spec section 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './atomicWrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

const DEFAULT_WEEKS = 4;
const DEFAULT_MAX_ENTRIES = 2000;
const RECENT_WEEKS_PROTECTED = 8;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MAX_ENTRIES_SCANNED = 10000; // explicit bound on every loop in this file (completion condition #13)

export class HistoryCorruptError extends Error {}
export class HistoryNotFoundError extends Error {}

function defaultHistory() {
  return { version: 1, entries: [] };
}

function backupCorruptFile(raw) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const backupPath = path.join(DATA_DIR, `history.corrupt.${Date.now()}.json`);
  fs.writeFileSync(backupPath, raw, 'utf8');
  return backupPath;
}

/**
 * Missing file -> empty history, no error (spec completion condition #1:
 * S1/S3 must behave exactly as before S6 existed when there's no history
 * yet). A file that exists but fails to parse is a different situation
 * entirely — that's real data that might matter, so it's backed up and the
 * caller is told loudly, never silently replaced with an empty history.
 */
export function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return defaultHistory();
  const raw = fs.readFileSync(HISTORY_PATH, 'utf8').replace(/^﻿/, '');
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries)) {
      throw new Error('entries가 배열이 아닙니다.');
    }
    return data;
  } catch (parseError) {
    const backupPath = backupCorruptFile(raw);
    throw new HistoryCorruptError(
      `history.json이 손상되었습니다. 원본을 ${backupPath}에 보존했습니다. 직접 확인 후 필요한 내용을 복구하세요. (원인: ${parseError.message})`
    );
  }
}

function saveHistory(history) {
  atomicWriteJson(HISTORY_PATH, history);
}

// ---------------------------------------------------------------------------
// Retention: 2000-entry default cap, but the most recent 8 weeks are never
// pruned away even if that alone exceeds the cap (spec section 5/completion
// condition #8) — in that edge case nothing is deleted, a warning is
// returned instead.
// ---------------------------------------------------------------------------

export function pruneEntries(entries, maxEntries, now = new Date()) {
  if (entries.length <= maxEntries) return { entries, warning: null };

  const cutoff = now.getTime() - RECENT_WEEKS_PROTECTED * MS_PER_WEEK;
  const recent = [];
  const old = [];
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= MAX_ENTRIES_SCANNED) break;
    scanned += 1;
    const ts = Date.parse(entry.generatedAt);
    if (Number.isFinite(ts) && ts >= cutoff) recent.push(entry);
    else old.push(entry);
  }

  if (recent.length >= maxEntries) {
    return {
      entries,
      warning: `보존 상한(${maxEntries}건)을 최근 ${RECENT_WEEKS_PROTECTED}주 기록(${recent.length}건)만으로 이미 초과했습니다 — 최근 기록은 삭제하지 않고 전체(${entries.length}건)를 보존합니다.`,
    };
  }

  const keepOldCount = maxEntries - recent.length;
  const sortedOld = [...old].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const keptOld = sortedOld.slice(0, keepOldCount);
  const merged = [...recent, ...keptOld].sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
  return { entries: merged, warning: null };
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

/**
 * Upserts one entry by `id` (defaults to `${setName}#${platform}`).
 * Idempotent by construction — calling this twice with the same id updates
 * the same slot rather than appending a duplicate, which is what makes
 * store/migrate.js safe to run more than once (spec completion condition #7).
 */
export function record(entry, { maxEntries = DEFAULT_MAX_ENTRIES, now = new Date() } = {}) {
  if (!entry.setName || !entry.platform) {
    throw new Error('record(): setName과 platform이 필요합니다.');
  }
  const id = entry.id || `${entry.setName}#${entry.platform}`;
  const history = loadHistory();
  const idx = history.entries.findIndex((e) => e.id === id);
  const nextEntry = {
    status: 'generated',
    templateIds: [],
    hashtags: [],
    publishedAt: null,
    ...(idx >= 0 ? history.entries[idx] : {}),
    ...entry,
    id,
  };

  const entries = [...history.entries];
  if (idx >= 0) entries[idx] = nextEntry;
  else entries.push(nextEntry);

  const { entries: pruned, warning } = pruneEntries(entries, maxEntries, now);
  saveHistory({ version: 1, entries: pruned });
  return { id, warning };
}

export function setStatus(id, status, { now = new Date() } = {}) {
  const history = loadHistory();
  const idx = history.entries.findIndex((e) => e.id === id);
  if (idx < 0) {
    throw new HistoryNotFoundError(`기록을 찾을 수 없습니다: ${id}`);
  }
  const entries = [...history.entries];
  const patch = { status };
  if (status === 'published' && !entries[idx].publishedAt) patch.publishedAt = now.toISOString();
  entries[idx] = { ...entries[idx], ...patch };
  saveHistory({ version: 1, entries });
  return entries[idx];
}

// ---------------------------------------------------------------------------
// Query API — every read anywhere else in social-studio goes through these.
// ---------------------------------------------------------------------------

function withinWindow(isoString, now, windowMs) {
  const ts = Date.parse(isoString);
  return Number.isFinite(ts) && now.getTime() - ts <= windowMs && ts <= now.getTime();
}

function scanEntries(predicate, { now = new Date() } = {}) {
  const history = loadHistory();
  const results = [];
  let scanned = 0;
  for (const entry of history.entries) {
    if (scanned >= MAX_ENTRIES_SCANNED) break;
    scanned += 1;
    if (predicate(entry, now)) results.push(entry);
  }
  return results;
}

/** Published entries for one channel+platform within the last `weeks`. */
export function getPublished(channelId, platform, weeks = DEFAULT_WEEKS, now = new Date()) {
  const windowMs = weeks * MS_PER_WEEK;
  return scanEntries(
    (e) => e.channelId === channelId && e.platform === platform && e.status === 'published' && withinWindow(e.publishedAt || e.generatedAt, now, windowMs),
    { now }
  );
}

/**
 * templateIds actually consumed (spec section 0: generation alone never
 * exhausts a template — only `status === 'published'` does).
 */
export function getUsedTemplateIds(channelId, platform, weeks = DEFAULT_WEEKS, now = new Date()) {
  const entries = getPublished(channelId, platform, weeks, now);
  const ids = new Set();
  for (const entry of entries) {
    for (const templateId of entry.templateIds || []) ids.add(templateId);
  }
  return [...ids];
}

/** Hashtag history for one channel+platform — includes generated AND published (not gated on actual publish, unlike templateIds). */
export function getRecentHashtags(channelId, platform, weeks = DEFAULT_WEEKS, now = new Date()) {
  const windowMs = weeks * MS_PER_WEEK;
  const entries = scanEntries(
    (e) => e.channelId === channelId && e.platform === platform && e.status !== 'discarded' && withinWindow(e.generatedAt, now, windowMs),
    { now }
  );
  const tags = [];
  for (const entry of entries) tags.push(...(entry.hashtags || []));
  return tags;
}

/** Fingerprints across ALL channels for the given week window — channel-agnostic, for same-week cross-channel comparison (R1's own domain; not currently wired into R1, see docs). */
export function getFingerprints(weeks = DEFAULT_WEEKS, now = new Date()) {
  const windowMs = weeks * MS_PER_WEEK;
  return scanEntries((e) => e.status !== 'discarded' && withinWindow(e.generatedAt, now, windowMs), { now })
    .filter((e) => e.fingerprint)
    .map((e) => ({ setName: e.setName, channelId: e.channelId, platform: e.platform, fingerprint: e.fingerprint }));
}

/** Actual publish timestamps for cadence checks (R6) — published only, since a never-posted draft can't crowd a real posting schedule. */
export function getPostingTimes(channelId, platform, hours = 24, now = new Date()) {
  const windowMs = hours * MS_PER_HOUR;
  return scanEntries(
    (e) => e.channelId === channelId && e.platform === platform && e.status === 'published' && e.publishedAt && withinWindow(e.publishedAt, now, windowMs),
    { now }
  ).map((e) => e.publishedAt);
}

export const paths = { HISTORY_PATH, DATA_DIR };
