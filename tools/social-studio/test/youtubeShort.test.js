import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTopSongs } from '../generate/youtubeShort.js';

// TASK-S7 completion condition #10: "qualityScore가 있으면 쇼츠 상위 3곡이
// 그 값 기준으로 선정된다. 없으면 기존 방식으로 동작한다."

test('S7: pickTopSongs falls back to trackNo order when no song carries a qualityScore (v1 behavior, unchanged)', () => {
  const songs = [{ trackNo: 1 }, { trackNo: 2 }, { trackNo: 3 }, { trackNo: 4 }];
  const top = pickTopSongs(songs, 3);
  assert.deepEqual(top.map((s) => s.trackNo), [1, 2, 3]);
});

test('S7: pickTopSongs ranks by qualityScore descending when present', () => {
  const songs = [
    { trackNo: 1, qualityScore: 10 },
    { trackNo: 2, qualityScore: 90 },
    { trackNo: 3, qualityScore: 50 },
    { trackNo: 4, qualityScore: 30 },
  ];
  const top = pickTopSongs(songs, 3);
  assert.deepEqual(top.map((s) => s.trackNo), [2, 3, 4]);
});

test('S7: pickTopSongs is a stable sort — equal qualityScore values keep original (trackNo) order', () => {
  // Mirrors the real v2 sample, where every song currently has qualityScore: 0.
  const songs = [
    { trackNo: 1, qualityScore: 0 },
    { trackNo: 2, qualityScore: 0 },
    { trackNo: 3, qualityScore: 0 },
    { trackNo: 4, qualityScore: 0 },
  ];
  const top = pickTopSongs(songs, 3);
  assert.deepEqual(top.map((s) => s.trackNo), [1, 2, 3]);
});

test('S7: pickTopSongs treats a song with no qualityScore as lowest-ranked once any song in the set has one', () => {
  const songs = [
    { trackNo: 1 }, // no qualityScore at all
    { trackNo: 2, qualityScore: 5 },
    { trackNo: 3, qualityScore: 20 },
  ];
  const top = pickTopSongs(songs, 3);
  assert.deepEqual(top.map((s) => s.trackNo), [3, 2, 1]);
});
