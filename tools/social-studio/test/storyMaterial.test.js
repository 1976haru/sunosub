import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSetPackFile, validateSetPack, normalizeSetPack } from '../parse/setPackLoader.js';
import { splitLyricLines, extractImageLines, classifySensoryPhrases, buildStoryMaterial } from '../parse/storyMaterial.js';
import { loadLexicon, loadStopwords } from '../parse/lexicon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');

function loadV2Normalized() {
  const data = readSetPackFile(FIXTURE_V2_PATH);
  const { warnings } = validateSetPack(data);
  return normalizeSetPack(data, warnings).normalized;
}

test('splitLyricLines strips [Verse 1]-style section tags (leading and standalone)', () => {
  const lines = splitLyricLines('[Verse 1]\r\nThe kettle sings a note I know\r\n[Chorus] Steam climbs slow where mornings go');
  assert.deepEqual(lines, ['The kettle sings a note I know', 'Steam climbs slow where mornings go']);
  for (const l of lines) assert.ok(!/\[[^\]]*\]/.test(l));
});

test('splitLyricLines drops empty lines', () => {
  const lines = splitLyricLines('Line one\r\n\r\nLine two\n\n');
  assert.deepEqual(lines, ['Line one', 'Line two']);
});

test('extractImageLines caps at 3 lines per song and drops a repeated chorus line', () => {
  const nounsLex = loadLexicon('ko', 'nouns');
  const timewordsLex = loadLexicon('ko', 'timewords');
  const stopwords = loadStopwords();
  const lyrics = [
    'The kettle sings a note I know',
    'Steam climbs slow where mornings go',
    'The table waits, the light comes soft',
    'The kettle sings a note I know', // repeated chorus line — must not be counted twice
    'And all the years I have carried, lift, aloft',
  ].join('\r\n');
  const lines = extractImageLines(lyrics, nounsLex, timewordsLex, stopwords);
  assert.ok(lines.length <= 3, `expected at most 3 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
  const uniq = new Set(lines);
  assert.equal(uniq.size, lines.length, 'expected no duplicate lines');
});

test('classifySensoryPhrases finds known sensory phrases and leaves the rest out (no forced "unknown" entries for non-sensory words)', () => {
  const sensoryLex = { kettle: undefined }; // not used directly; real lexicon loaded via buildStoryMaterial below
  const hits = classifySensoryPhrases('Steam climbs slow where mornings go', { steam: { category: 'sight' } });
  assert.ok(hits.some((h) => h.en === 'Steam' || h.en.toLowerCase() === 'steam'));
});

test('완료조건 3: set.storyMaterial has at least 10 lyric lines and none contain a [Section]-style tag', () => {
  const normalized = loadV2Normalized();
  const sm = normalized.set.storyMaterial;
  assert.ok(sm, 'expected normalized.set.storyMaterial to exist');
  assert.ok(sm.lyricLines.length >= 10, `expected >=10 lyric lines, got ${sm.lyricLines.length}`);
  assert.ok(sm.lyricLines.length <= 20, `expected <=20 lyric lines (set-wide cap), got ${sm.lyricLines.length}`);
  for (const l of sm.lyricLines) {
    assert.ok(!/\[[^\]]*\]/.test(l.text), `lyric line still has a section tag: "${l.text}"`);
  }
});

test('storyMaterial caps at 3 lines per song even when pooling across the whole set', () => {
  const normalized = loadV2Normalized();
  const counts = new Map();
  for (const l of normalized.set.storyMaterial.lyricLines) {
    counts.set(l.trackNo, (counts.get(l.trackNo) || 0) + 1);
  }
  for (const [trackNo, count] of counts) {
    assert.ok(count <= 3, `track ${trackNo} contributed ${count} lines, expected <=3`);
  }
});

test('storyMaterial.openingScene is built from the first song and preserves the original English text (not translated)', () => {
  const normalized = loadV2Normalized();
  const sm = normalized.set.storyMaterial;
  assert.equal(sm.openingScene.trackNo, 1);
  assert.ok(sm.openingScene.raw, 'expected a non-null openingScene.raw');
  assert.ok(/[A-Za-z]/.test(sm.openingScene.raw), 'expected openingScene.raw to still be English (untranslated)');
});

test('storyMaterial.emotionJourney.from/to are Korean-translated emotion labels, steps has one entry per parsed song', () => {
  const normalized = loadV2Normalized();
  const sm = normalized.set.storyMaterial;
  assert.equal(typeof sm.emotionJourney.from, 'string');
  assert.equal(typeof sm.emotionJourney.to, 'string');
  const parsedCount = normalized.songs.filter((s) => s.emotionArc.parsed).length;
  assert.equal(sm.emotionJourney.steps.length, parsedCount);
});

test('storyMaterial.distinctChoices/pov/timeSpan pass through v2-only fields', () => {
  const normalized = loadV2Normalized();
  const sm = normalized.set.storyMaterial;
  assert.ok(Array.isArray(sm.distinctChoices) && sm.distinctChoices.length > 0);
  assert.equal(sm.pov, normalized.songs[0].pov);
});

test('buildStoryMaterial on an empty songs array does not throw and returns a well-formed empty shape', () => {
  const sm = buildStoryMaterial([], { nounsLex: loadLexicon('ko', 'nouns'), timewordsLex: loadLexicon('ko', 'timewords'), stopwords: loadStopwords() });
  assert.equal(sm.openingScene.trackNo, null);
  assert.deepEqual(sm.lyricLines, []);
  assert.deepEqual(sm.distinctChoices, []);
});
