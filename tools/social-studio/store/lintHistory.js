/**
 * TASK-S3 — the minimum record socialLint needs to compare across weeks
 * (R2 template reuse, R3 hashtag overlap) until S6's real publish-history DB
 * exists. Only fingerprints/IDs/tags go in here, never the generated prose
 * itself (spec section 6/8) — see lint/similarity.js's contentFingerprint().
 *
 * R1 (cross-channel, SAME week) deliberately does NOT go through this file:
 * it reads sibling out/{setName}/textpack.json files directly (see
 * listOtherSetsInSameWeek below), because the real text is still sitting
 * right there on disk for a same-week comparison — there's no reason to
 * degrade to a fingerprint for something that doesn't need history at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'out');
const HISTORY_PATH = path.join(__dirname, 'lintHistory.json');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_OUT_DIR_ENTRIES = 2000; // explicit bound on the out/ directory scan

function defaultHistory() {
  return { version: 1, entries: [] };
}

export function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return defaultHistory();
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return defaultHistory();
    return data;
  } catch {
    return defaultHistory(); // a corrupt history file is treated as "first run", never a crash
  }
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Appends one entry and evicts the oldest entries past maxEntries (spec completion condition #12). */
export function appendEntry(entry, maxEntries) {
  const history = loadHistory();
  const entries = [...history.entries, entry];
  const trimmed = entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
  const next = { version: 1, entries: trimmed };
  atomicWriteJson(HISTORY_PATH, next);
  return next;
}

/** Entries for one channel within the last `weeks` weeks of `referenceDate`, excluding `excludeSetName`. Bounded by history's own size (already capped by appendEntry). */
export function findRecentEntries(history, { channelId, referenceDate, weeks, excludeSetName }) {
  const cutoff = referenceDate.getTime() - weeks * 7 * MS_PER_DAY;
  return history.entries.filter((e) => {
    if (e.channelId !== channelId) return false;
    if (e.setName === excludeSetName) return false;
    const checkedAt = Date.parse(e.checkedAt);
    return Number.isFinite(checkedAt) && checkedAt >= cutoff;
  });
}

// ---------------------------------------------------------------------------
// Week bucket + posting-date seam (also used by rules/postingCadence.js)
// ---------------------------------------------------------------------------

/** YYYYMMDD prefix -> Date at UTC midnight. Returns null if setName doesn't start with 8 digits. */
export function parseSetDate(setName) {
  const match = String(setName ?? '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A stable, comparable week bucket (not calendar-ISO-week — just "same 7-day bucket since epoch"), so two setNames are "same week" iff this matches. */
export function weekBucket(setName) {
  const date = parseSetDate(setName);
  if (!date) return null;
  return Math.floor(date.getTime() / (7 * MS_PER_DAY));
}

/**
 * The ONE place that decides "when is this set considered posted" — spec
 * R6: "발행 시각 정보는 S4(체크리스트)가 생기기 전까지는 세트 생성일
 * 기준으로 계산한다... S4 완료 후 실제 예약 시각으로 교체할 수 있도록
 * 시각 계산을 한 함수에 모아 둔다." When S4 adds a real scheduled
 * timestamp to textpack/pack-state, swap this function's body — nothing
 * else in R6 should need to change.
 */
export function resolvePostingDate(textpack) {
  return parseSetDate(textpack.setName);
}

// ---------------------------------------------------------------------------
// Sibling out/ directories in the same week (for R1)
// ---------------------------------------------------------------------------

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * textpack.edited.json (store/packState.js) only stores per-item overrides
 * keyed by the same flat item-id scheme the S2 screen uses (e.g.
 * "instagram.caption", "youtube.titles.0", "shorts.12.titleKo"). Applying
 * them here means R1 compares what a user actually sees/copies, not a
 * stale original — same principle as S2's own display merge.
 */
function applyOverrides(textpack, overrides) {
  if (!overrides) return textpack;
  const next = JSON.parse(JSON.stringify(textpack)); // small object, deep clone is cheap and avoids mutating the cache
  for (const [itemId, value] of Object.entries(overrides)) {
    const parts = itemId.split('.');
    if (parts[0] === 'shorts' && parts.length === 3) {
      const trackNo = Number(parts[1]);
      const song = (next.shorts || []).find((s) => s.trackNo === trackNo);
      if (song) song[parts[2]] = value;
      continue;
    }
    if (parts[0] === 'youtube' && parts[1] === 'titles' && parts.length === 3) {
      const idx = Number(parts[2]);
      if (Array.isArray(next.youtube?.titles) && idx < next.youtube.titles.length) next.youtube.titles[idx] = value;
      continue;
    }
    if (parts.length === 2 && next[parts[0]] && Object.prototype.hasOwnProperty.call(next[parts[0]], parts[1])) {
      next[parts[0]][parts[1]] = value;
    }
  }
  return next;
}

/** Prefers textpack.edited.json over textpack.json, same rule S2 uses for display. */
export function loadTextpackForSet(setName) {
  const dir = path.join(OUT_ROOT, setName);
  const edited = readJsonIfExists(path.join(dir, 'textpack.edited.json'));
  const original = readJsonIfExists(path.join(dir, 'textpack.json'));
  if (!original) return null;
  return applyOverrides(original, edited?.overrides);
}

/** Every out/ set directory (other than currentSetName) whose date falls in the same week bucket and whose channelId differs. Bounded scan (completion condition #11). */
export function listOtherSetsInSameWeek(currentSetName, currentChannelId) {
  if (!fs.existsSync(OUT_ROOT)) return [];
  const targetWeek = weekBucket(currentSetName);
  if (targetWeek === null) return [];
  const entries = fs.readdirSync(OUT_ROOT, { withFileTypes: true }).slice(0, MAX_OUT_DIR_ENTRIES);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentSetName) continue;
    if (weekBucket(entry.name) !== targetWeek) continue;
    const other = loadTextpackForSet(entry.name);
    if (!other || other.channelId === currentChannelId) continue;
    matches.push(entry.name);
  }
  return matches;
}
