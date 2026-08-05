/**
 * TASK-S1 — adapter for tools/timeline/index.html's output.
 *
 * The timeline generator (tools/timeline/index.html, ~line 1124
 * generateTimeline()) is NOT modified — per the S1 brief, only this adapter
 * may know its output shape. Its real output is not JSON: it's the plain
 * text the "타임라인 생성" textarea holds, one line per track:
 *
 *   00:00 Morning Kettle Waltz (아침 주전자 왈츠)
 *   03:25 Letters I Never Sent (부치지 못한 편지)
 *
 * — `${formatTime(row.start, alwaysHours)} ${row.title}${row.bracket || ""}`
 * (tools/timeline/index.html:1143). formatTime always zero-pads (MM:SS, or
 * HH:MM:SS once the total passes an hour — index.html:748-757); bracket is
 * ` (titleKo)` / ` (titleJa)` or absent (index.html:639-653).
 *
 * This module parses that text back into the S1 contract:
 *   { tracks: [{ trackNo, startSec, durationSec }] }
 *
 * Track order in the timeline text is assumed to match `songs` order in the
 * setpack (both come from exporting the same Suno batch in the same order).
 * trackNo here is therefore assigned by position (1-based), not parsed from
 * the text — the timeline tool never prints a track number, only a title.
 */

import fs from 'node:fs';

const LINE_PATTERN = /^(\d{1,2}(?::\d{2}){1,2})\s+(.+)$/;
const TRAILING_BRACKET_PATTERN = /\s*\([^()]*\)\s*$/;

// Explicit loop bound (TASK-S1 completion condition #10).
const MAX_TIMELINE_LINES = 1000;

function timestampToSeconds(timestamp) {
  const parts = timestamp.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Parses the raw text copied out of the timeline generator's output box.
 * Lines that don't match "{timestamp} {title}" are skipped, not fatal —
 * a user may have pasted extra header/footer text along with it.
 */
export function parseTimelineText(rawText) {
  const lines = String(rawText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_TIMELINE_LINES);

  const rows = [];
  for (const line of lines) {
    const match = line.match(LINE_PATTERN);
    if (!match) continue;
    const startSec = timestampToSeconds(match[1]);
    if (startSec === null) continue;
    const title = match[2].replace(TRAILING_BRACKET_PATTERN, '').trim();
    rows.push({ startSec, title });
  }

  const tracks = rows.map((row, i) => ({
    trackNo: i + 1,
    startSec: row.startSec,
    durationSec: i + 1 < rows.length ? rows[i + 1].startSec - row.startSec : null,
    titleAsPrinted: row.title,
  }));

  return { tracks };
}

/** Reads a saved copy of the timeline output (a plain .txt export) from disk. Returns null if the path is falsy. */
export function loadTimelineFile(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    throw new Error(`타임라인 파일을 찾을 수 없습니다: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return parseTimelineText(raw);
}
