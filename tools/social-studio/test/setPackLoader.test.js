import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSetPackFile,
  validateSetPack,
  normalizeSetPack,
  resolveChannelLanguage,
  runSetPackPipeline,
  SetPackValidationError,
} from '../parse/setPackLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-setpack.json');
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');
const NOUNS_PATH = path.join(__dirname, '..', 'data', 'lexicon', 'ko', 'nouns.json');

function baseValidSong(overrides = {}) {
  return {
    trackNo: 1,
    title: 'Test Title',
    titleLocalized: '테스트 제목',
    listenerSituation: 'watching the window',
    emotionArc: 'sleepy heaviness opening into steady comfort',
    hookPhrase: 'a hook',
    lyrics: 'la la la',
    ...overrides,
  };
}

function baseValidSetPack(songOverrides = [{}]) {
  return {
    meta: {
      setName: 'unit-test-set',
      channelId: 'good-morning-memory-radio',
      channelLabel: '테스트 채널',
      songCount: songOverrides.length,
      lyricLanguage: 'english',
    },
    songs: songOverrides.map((o, i) => baseValidSong({ trackNo: i + 1, ...o })),
  };
}

// --- Condition 1 & 2: full fixture run, 18/18 emotionArc parse rate ---

test('condition 1+2: sample fixture normalizes to 18 songs with a 18/18 emotionArc parse rate', () => {
  const data = readSetPackFile(FIXTURE_PATH);
  assert.equal(data.songs.length, 18);
  const { warnings } = validateSetPack(data);
  const { normalized, report } = normalizeSetPack(data, warnings);
  assert.equal(normalized.songs.length, 18);
  const parsedCount = normalized.songs.filter((s) => s.emotionArc.parsed).length;
  assert.equal(parsedCount, 18, `expected 18/18 parsed, got ${parsedCount}/18. unmatched: ${JSON.stringify(report.unmatchedEmotionArcs)}`);
  assert.equal(report.unmatchedEmotionArcs.length, 0);
});

test('BOM in the fixture file is stripped before JSON.parse', () => {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff, 'fixture should actually have a BOM, or this test proves nothing');
  const data = readSetPackFile(FIXTURE_PATH); // must not throw
  assert.equal(data.meta.songCount, 18);
});

// --- Condition 3: 4 required-field failure cases ---

test('condition 3a: missing meta.channelId throws', () => {
  const data = baseValidSetPack();
  delete data.meta.channelId;
  assert.throws(() => validateSetPack(data), SetPackValidationError);
});

test('condition 3b: empty songs array throws', () => {
  const data = baseValidSetPack();
  data.songs = [];
  assert.throws(() => validateSetPack(data), SetPackValidationError);
});

test('condition 3c: duplicate trackNo throws', () => {
  const data = baseValidSetPack([{ trackNo: 1 }, { trackNo: 1 }]);
  assert.throws(() => validateSetPack(data), SetPackValidationError);
});

test('condition 3d: missing title (not titleLocalized) throws', () => {
  const data = baseValidSetPack();
  delete data.songs[0].title;
  assert.throws(() => validateSetPack(data), SetPackValidationError);
});

test('a fully valid minimal setpack does NOT throw', () => {
  const data = baseValidSetPack();
  assert.doesNotThrow(() => validateSetPack(data));
});

test('meta.songCount vs songs.length mismatch warns but does not throw', () => {
  const data = baseValidSetPack();
  data.meta.songCount = 99;
  const { warnings } = validateSetPack(data);
  assert.ok(warnings.some((w) => w.includes('songCount')));
});

// --- Condition 4: ungrammatical emotionArc is parsed:false and recorded ---

test('condition 4: an emotionArc that does not fit the grammar is parsed:false and listed in unmatchedEmotionArcs', () => {
  const data = baseValidSetPack([{ emotionArc: 'just happy' }]);
  const { normalized, report } = normalizeSetPack(data, []);
  assert.equal(normalized.songs[0].emotionArc.parsed, false);
  assert.deepEqual(report.unmatchedEmotionArcs, [{ trackNo: 1, raw: 'just happy' }]);
});

// --- Condition 5: emptying nouns.json collapses coverage.nouns toward 0 ---

test('condition 5: coverage.nouns collapses to 0 with an emptied nouns.json (proves Korean isn\'t hardcoded)', () => {
  const backup = fs.readFileSync(NOUNS_PATH, 'utf8');
  try {
    fs.writeFileSync(NOUNS_PATH, JSON.stringify({ version: 1, entries: {} }));
    const data = readSetPackFile(FIXTURE_PATH);
    const { warnings } = validateSetPack(data);
    const { report } = normalizeSetPack(data, warnings);
    assert.equal(report.coverage.nouns, 0);
  } finally {
    fs.writeFileSync(NOUNS_PATH, backup);
  }
});

test('sanity: with nouns.json restored, coverage.nouns is high again (not permanently broken by the test above)', () => {
  const data = readSetPackFile(FIXTURE_PATH);
  const { warnings } = validateSetPack(data);
  const { report } = normalizeSetPack(data, warnings);
  assert.ok(report.coverage.nouns > 0.9, `expected coverage.nouns > 0.9, got ${report.coverage.nouns}`);
});

// --- Condition 6: unknown channelId errors, never defaults ---

test('condition 6: an unmapped channelId throws instead of silently defaulting', () => {
  assert.throws(() => resolveChannelLanguage('totally-unknown-channel'), SetPackValidationError);
});

test('known exact and prefix channelId mappings resolve correctly', () => {
  assert.equal(resolveChannelLanguage('good-morning-memory-radio'), 'ko');
  assert.equal(resolveChannelLanguage('kr-anything'), 'ko');
  assert.equal(resolveChannelLanguage('jp-anything'), 'ja');
});

// --- Condition 7: seasonMoment set-level promotion ---

test('condition 7a: identical seasonMoment across all songs promotes to set.seasonHint and warns', () => {
  const data = baseValidSetPack([
    { seasonMoment: 'Late Summer Opening' },
    { trackNo: 2, seasonMoment: 'Late Summer Opening' },
  ]);
  const { normalized } = normalizeSetPack(data, []);
  assert.equal(normalized.set.seasonHint.raw, 'Late Summer Opening');
  assert.equal(normalized.set.seasonHint.promoted, true);
  assert.ok(normalized.set.warnings.includes('seasonMoment가 전곡 동일하여 세트 레벨로 승격함'));
  assert.equal(normalized.songs[0].seasonMoment, null);
  assert.equal(normalized.songs[1].seasonMoment, null);
});

test('condition 7b: differing seasonMoment values are left per-song, with no promotion', () => {
  const data = baseValidSetPack([
    { seasonMoment: 'Late Summer Opening' },
    { trackNo: 2, seasonMoment: 'Early Spring Thaw' },
  ]);
  const { normalized } = normalizeSetPack(data, []);
  assert.equal(normalized.set.seasonHint, null);
  assert.ok(!normalized.set.warnings.some((w) => w.includes('세트 레벨로 승격')));
  assert.equal(normalized.songs[0].seasonMoment, 'Late Summer Opening');
  assert.equal(normalized.songs[1].seasonMoment, 'Early Spring Thaw');
});

// --- Condition 8: zero network calls during a full run ---

test('condition 8: a full pipeline run makes zero network calls', () => {
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error('network call attempted during social-studio S0 pipeline — forbidden by spec section 9');
  };
  try {
    const data = readSetPackFile(FIXTURE_PATH);
    const { warnings } = validateSetPack(data);
    assert.doesNotThrow(() => normalizeSetPack(data, warnings));
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Condition 9: explicit loop bound on songs array ---

test('condition 9: a songs array over the explicit cap is rejected rather than looping unbounded', () => {
  const hugeSongs = Array.from({ length: 501 }, (_, i) => baseValidSong({ trackNo: i + 1 }));
  const data = { ...baseValidSetPack(), songs: hugeSongs };
  data.meta.songCount = hugeSongs.length;
  assert.throws(() => validateSetPack(data), SetPackValidationError);
});

// --- End-to-end file output (out/{setName}/*.json) ---

test('runSetPackPipeline writes normalized.json and unknown-terms.json under out/{setName}/', () => {
  const { outDir } = runSetPackPipeline(FIXTURE_PATH);
  assert.ok(fs.existsSync(path.join(outDir, 'normalized.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'unknown-terms.json')));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'unknown-terms.json'), 'utf8'));
  assert.equal(report.setName, '20260804_굿모닝추억라디오_70년대감성');
});

// ---------------------------------------------------------------------------
// TASK-S7 — v2 schema support (titleLocalized optional, seasonMoment per-song,
// new v2 fields, lexicon coverage). See docs/social-package-spec.md §14a.
// ---------------------------------------------------------------------------

test('S7 condition 1: the v2 fixture (no titleLocalized, 18 unique seasonMoment) normalizes all 18 songs without throwing', () => {
  const data = readSetPackFile(FIXTURE_V2_PATH);
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  assert.equal(normalized.songs.length, 18);
});

test('S7 condition 3: v2 fallback — every song has no titleLocalized, titleLocalized falls back to title, and set.warnings carries a [중요]-prefixed fallback warning (18/18 > half)', () => {
  const data = readSetPackFile(FIXTURE_V2_PATH);
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  for (const song of normalized.songs) {
    assert.equal(song.titleLocalizedFallback, true);
    assert.equal(song.titleLocalized, song.title);
  }
  const fallbackWarning = normalized.set.warnings.find((w) => w.includes('titleLocalized 누락'));
  assert.ok(fallbackWarning, `expected a titleLocalized fallback warning, got: ${JSON.stringify(normalized.set.warnings)}`);
  assert.ok(fallbackWarning.startsWith('[중요]'), `expected [중요] prefix since 18/18 > half, got: "${fallbackWarning}"`);
  assert.ok(fallbackWarning.includes('18곡 중 18곡'));
});

test('S7 condition 4: v1 fixture (titleLocalized present) never falls back and never warns about it', () => {
  const data = readSetPackFile(FIXTURE_PATH);
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  assert.ok(normalized.songs.every((s) => s.titleLocalizedFallback === false));
  assert.ok(!normalized.set.warnings.some((w) => w.includes('titleLocalized')));
});

test('S7: a minority fallback (below half the set) omits the [중요] prefix', () => {
  const data = baseValidSetPack([{}, { trackNo: 2 }, { trackNo: 3 }, { trackNo: 4 }]);
  delete data.songs[0].titleLocalized; // 1 of 4 — below half
  const { normalized } = normalizeSetPack(data, []);
  const w = normalized.set.warnings.find((x) => x.includes('titleLocalized 누락'));
  assert.ok(w);
  assert.ok(!w.startsWith('[중요]'), `expected no [중요] prefix for a minority fallback, got: "${w}"`);
  assert.ok(w.includes('4곡 중 1곡'));
});

test('S7 condition 5: v2 fixture (18 distinct seasonMoment values) does not promote to set.seasonHint', () => {
  const data = readSetPackFile(FIXTURE_V2_PATH);
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  assert.equal(normalized.set.seasonHint, null);
  assert.ok(!normalized.set.warnings.some((w) => w.includes('세트 레벨로 승격')));
  assert.equal(normalized.songs[0].seasonMoment, data.songs[0].seasonMoment);
});

test('S7 condition 6: v1 fixture (identical seasonMoment) still promotes — existing behavior unchanged', () => {
  const data = readSetPackFile(FIXTURE_PATH);
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  assert.ok(normalized.set.seasonHint);
  assert.equal(normalized.set.seasonHint.promoted, true);
});

test('S7: lyricThemeText (v2-only) is scanned for nouns/timewords the same way listenerSituation is', () => {
  const data = baseValidSetPack([{ lyricThemeText: 'a warm porch swing at dusk' }]);
  const { normalized, report } = normalizeSetPack(data, []);
  assert.ok(normalized.songs[0].lyricThemeText, 'expected a non-null lyricThemeText block');
  assert.equal(normalized.songs[0].lyricThemeText.raw, 'a warm porch swing at dusk');
  const matchedKo = normalized.songs[0].lyricThemeText.matchedTerms.map((m) => m.ko);
  assert.ok(matchedKo.length > 0, 'expected at least one dictionary match inside lyricThemeText');
  // report.coverage.nouns should reflect lyricThemeText matches too, not just listenerSituation.
  assert.equal(report.coverage.nouns, 1);
});

test('S7: v1-style song with no lyricThemeText field normalizes with lyricThemeText: null (no crash on the optional field)', () => {
  const data = baseValidSetPack();
  const { normalized } = normalizeSetPack(data, []);
  assert.equal(normalized.songs[0].lyricThemeText, null);
});

test('S7 condition 11: upstream song.warnings (v2-only) are merged into set.warnings with a [상류] prefix', () => {
  const data = baseValidSetPack([{ warnings: ['가사 길이 초과'] }]);
  const { normalized } = normalizeSetPack(data, []);
  const merged = normalized.set.warnings.find((w) => w.includes('가사 길이 초과'));
  assert.ok(merged, `expected an upstream warning to be merged, got: ${JSON.stringify(normalized.set.warnings)}`);
  assert.ok(merged.startsWith('[상류]'), `expected a [상류] prefix, got: "${merged}"`);
  assert.ok(merged.includes('트랙 1'));
});

test('S7: a v1 song with no warnings field merges nothing (no crash on the optional field)', () => {
  const data = baseValidSetPack();
  const { normalized } = normalizeSetPack(data, []);
  assert.ok(!normalized.set.warnings.some((w) => w.startsWith('[상류]')));
});

test('S7 condition 9: youtube.tags count is preserved exactly (5 in v1, 8 in v2) — nothing assumes a fixed count', () => {
  const v1 = readSetPackFile(FIXTURE_PATH);
  const { normalized: n1 } = normalizeSetPack(v1, []);
  assert.equal(n1.songs[0].youtube.tags.length, 5);

  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized: n2 } = normalizeSetPack(v2, []);
  assert.equal(n2.songs[0].youtube.tags.length, 8);
});

test('S7 condition 7+8: coverage.nouns is >= 0.90 on both v1 and v2 fixtures, and collapses toward 0 when nouns.json is emptied', () => {
  const backup = fs.readFileSync(NOUNS_PATH, 'utf8');
  try {
    const v1 = readSetPackFile(FIXTURE_PATH);
    const { report: r1 } = normalizeSetPack(v1, []);
    assert.ok(r1.coverage.nouns >= 0.9, `v1 coverage.nouns ${r1.coverage.nouns} should be >= 0.90`);

    const v2 = readSetPackFile(FIXTURE_V2_PATH);
    const { report: r2 } = normalizeSetPack(v2, []);
    assert.ok(r2.coverage.nouns >= 0.9, `v2 coverage.nouns ${r2.coverage.nouns} should be >= 0.90`);

    fs.writeFileSync(NOUNS_PATH, JSON.stringify({ version: 1, entries: {} }));
    const { report: emptied1 } = normalizeSetPack(readSetPackFile(FIXTURE_PATH), []);
    const { report: emptied2 } = normalizeSetPack(readSetPackFile(FIXTURE_V2_PATH), []);
    assert.equal(emptied1.coverage.nouns, 0);
    assert.equal(emptied2.coverage.nouns, 0);
  } finally {
    fs.writeFileSync(NOUNS_PATH, backup);
  }
});

test('S7: v2-only fields (distinctChoice, genreText, pov, qualityScore) pass through on the normalized song when present, null on v1', () => {
  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized: n2 } = normalizeSetPack(v2, []);
  assert.equal(typeof n2.songs[0].distinctChoice, 'string');
  assert.equal(typeof n2.songs[0].genreText, 'string');
  assert.equal(typeof n2.songs[0].pov, 'string');
  assert.equal(typeof n2.songs[0].qualityScore, 'number');

  const v1 = readSetPackFile(FIXTURE_PATH);
  const { normalized: n1 } = normalizeSetPack(v1, []);
  assert.equal(n1.songs[0].distinctChoice, null);
  assert.equal(n1.songs[0].genreText, null);
  assert.equal(n1.songs[0].pov, null);
  assert.equal(n1.songs[0].qualityScore, null);
});
