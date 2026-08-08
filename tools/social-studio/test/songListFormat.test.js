import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTitleWithOriginal, formatSongListLine, buildSongListText } from '../generate/songListFormat.js';

// TASK-S9 작업 C — 괄호 중복 제거

test('S9: formatTitleWithOriginal shows "titleLocalized (title)" when not a fallback', () => {
  const song = { trackNo: 1, title: 'Slow Start, Steady Heart', titleLocalized: '느린 아침', titleLocalizedFallback: false };
  assert.equal(formatTitleWithOriginal(song), '느린 아침 (Slow Start, Steady Heart)');
});

test('S9 condition 6: formatTitleWithOriginal omits the bracket when titleLocalizedFallback is true', () => {
  const song = { trackNo: 1, title: 'Hold the Morning Light', titleLocalized: 'Hold the Morning Light', titleLocalizedFallback: true };
  assert.equal(formatTitleWithOriginal(song), 'Hold the Morning Light');
});

test('S9: formatTitleWithOriginal also omits the bracket when the two values are literally identical, even without the flag (belt and suspenders for older normalized.json snapshots)', () => {
  const song = { trackNo: 1, title: 'Same Title', titleLocalized: 'Same Title' };
  assert.equal(formatTitleWithOriginal(song), 'Same Title');
});

test('S9: formatSongListLine prefixes trackNo and defers to formatTitleWithOriginal', () => {
  const fallback = { trackNo: 3, title: 'Wait by the Window', titleLocalized: 'Wait by the Window', titleLocalizedFallback: true };
  const real = { trackNo: 1, title: 'Slow Start, Steady Heart', titleLocalized: '느린 아침', titleLocalizedFallback: false };
  assert.equal(formatSongListLine(fallback), '3. Wait by the Window');
  assert.equal(formatSongListLine(real), '1. 느린 아침 (Slow Start, Steady Heart)');
});

test('S9: buildSongListText joins one formatSongListLine per song, mixed fallback and real', () => {
  const songs = [
    { trackNo: 1, title: 'Real Title', titleLocalized: '진짜 제목', titleLocalizedFallback: false },
    { trackNo: 2, title: 'Fallback Title', titleLocalized: 'Fallback Title', titleLocalizedFallback: true },
  ];
  assert.equal(buildSongListText(songs), '1. 진짜 제목 (Real Title)\n2. Fallback Title');
});
