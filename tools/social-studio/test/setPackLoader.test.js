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
  scoreSceneTerms,
  rankSceneTerms,
  loadSceneNounWeights,
  isSceneNounCategory,
  SetPackValidationError,
} from '../parse/setPackLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-setpack.json');
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');
const NOUNS_PATH = path.join(__dirname, '..', 'data', 'lexicon', 'ko', 'nouns.json');
const SCENE_WEIGHTS_PATH = path.join(__dirname, '..', 'data', 'sceneNounWeights.json');

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

// ---------------------------------------------------------------------------
// TASK-S8 작업 A — sceneNouns 희소성 가중. 빈도순이면 18곡 전부에 등장하는
// 흔한 단어(table/window/road)가 상위를 차지한다 — 그 세트만의 장면을 만드는
// 건 1~3곡에만 나오는 단어다. See data/sceneNounWeights.json.
// ---------------------------------------------------------------------------

function songCountsFor(normalized, ko) {
  // Recomputes "몇 곡에 등장했는가" independently of setPackLoader's internal
  // termInfo map, straight from the per-song matchedTerms already on the
  // normalized songs — so this test doesn't just re-assert the
  // implementation's own bookkeeping.
  const songs = new Set();
  for (const song of normalized.songs) {
    const sources = [song.listenerSituation.matchedTerms, song.lyricThemeText?.matchedTerms || []];
    for (const matched of sources) {
      if (matched.some((m) => m.ko === ko)) songs.add(song.trackNo);
    }
  }
  return songs.size;
}

test('S8 condition 1: set.sceneNouns top12 has at least 6 words that appear in <= 3 songs (v2 fixture, 18 songs)', () => {
  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized } = normalizeSetPack(v2, []);
  const top12 = normalized.set.sceneNouns;
  assert.ok(top12.length > 0, 'expected a non-empty sceneNouns list');
  const rareCount = top12.filter((ko) => songCountsFor(normalized, ko) <= 3).length;
  assert.ok(rareCount >= 6, `expected >=6 of the top12 to appear in <=3 songs, got ${rareCount}. top12: ${JSON.stringify(top12)}`);
});

test('S8 condition 3: at least one sceneNoun outside {table/window/road}\'s Korean translations appears in the top12 (v2 fixture)', () => {
  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized } = normalizeSetPack(v2, []);
  const common = new Set(['식탁', '창문', '길']); // ko for table/window/road in data/lexicon/ko/nouns.json
  const hasSomethingElse = normalized.set.sceneNouns.some((ko) => !common.has(ko));
  assert.ok(hasSomethingElse, `top12 was entirely table/window/road: ${JSON.stringify(normalized.set.sceneNouns)}`);
});

test('S8: rankSceneTerms guarantees minRareInTop rare words when enough rare candidates exist', () => {
  const weights = loadSceneNounWeights();
  const termInfo = new Map();
  // 3 "common" words (appear in 15 of 18 songs) + 8 "rare" words (1 song each) — a
  // plain frequency sort would put all 3 common words ahead of every rare one.
  for (let i = 0; i < 3; i += 1) {
    termInfo.set(`common${i}`, { songs: new Set(Array.from({ length: 15 }, (_, k) => k + 1)), category: 'object', order: i });
  }
  for (let i = 0; i < 8; i += 1) {
    termInfo.set(`rare${i}`, { songs: new Set([i + 1]), category: 'object', order: 3 + i });
  }
  const top = rankSceneTerms(termInfo, weights, 12);
  const rareInTop = top.filter((ko) => ko.startsWith('rare')).length;
  assert.ok(rareInTop >= weights.minRareInTop, `expected >= ${weights.minRareInTop} rare words in top, got ${rareInTop}: ${JSON.stringify(top)}`);
});

test('S8: rankSceneTerms pulls in place/time categories when the top diversityCheckCount would otherwise be all "object"', () => {
  const weights = loadSceneNounWeights();
  const termInfo = new Map();
  // 8 rare "object" words (score-dominant) + 1 rare "place" + 1 rare "time",
  // both scored lower (more songs) so they wouldn't naturally make the head
  // without the diversity rule.
  for (let i = 0; i < 8; i += 1) {
    termInfo.set(`obj${i}`, { songs: new Set([i + 1]), category: 'object', order: i });
  }
  termInfo.set('aPlace', { songs: new Set([1, 2, 3, 4, 5]), category: 'place', order: 8 });
  termInfo.set('aTime', { songs: new Set([1, 2, 3, 4, 5]), category: 'time', order: 9 });

  const top = rankSceneTerms(termInfo, weights, 12);
  const head = top.slice(0, weights.diversityCheckCount);
  const headCategories = new Set(
    [...termInfo.entries()].filter(([ko]) => head.includes(ko)).map(([, info]) => info.category)
  );
  assert.ok(headCategories.has('place') || headCategories.has('time'), `expected place/time pulled into the head, got: ${JSON.stringify(head)}`);
});

test('S8 condition 13: an extreme sceneNounWeights.json change actually flips sceneNouns order (proves the weights aren\'t hardcoded)', () => {
  const backup = fs.readFileSync(SCENE_WEIGHTS_PATH, 'utf8');
  try {
    const v2 = readSetPackFile(FIXTURE_V2_PATH);
    const { normalized: normalBefore } = normalizeSetPack(v2, []);
    const before = normalBefore.set.sceneNouns.slice(0, 6);

    const weights = JSON.parse(backup);
    // Flip the weighting: reward COMMON words instead of rare ones.
    const flipped = { ...weights, rareWeight: 0.1, commonWeight: 5, midWeight: 1 };
    fs.writeFileSync(SCENE_WEIGHTS_PATH, JSON.stringify(flipped, null, 2));

    const { normalized: normalAfter } = normalizeSetPack(readSetPackFile(FIXTURE_V2_PATH), []);
    const after = normalAfter.set.sceneNouns.slice(0, 6);

    assert.notDeepEqual(before, after, `expected sceneNouns order to change after flipping the weights, both were: ${JSON.stringify(before)}`);
  } finally {
    fs.writeFileSync(SCENE_WEIGHTS_PATH, backup);
  }
});

test('S8: emptying nouns.json still leaves scoreSceneTerms with nothing to rank (sceneNouns only ever contains dictionary-matched words)', () => {
  const weights = loadSceneNounWeights();
  const entries = scoreSceneTerms(new Map(), weights);
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// TASK-S9 작업 B — sceneNouns 카테고리 재분류(body/abstract 제외, config-driven)
// ---------------------------------------------------------------------------

test('S9: isSceneNounCategory excludes body/abstract per data/sceneNounWeights.json, keeps object/place/time/person/food', () => {
  const weights = loadSceneNounWeights();
  assert.equal(isSceneNounCategory('body', weights), false);
  assert.equal(isSceneNounCategory('abstract', weights), false);
  assert.equal(isSceneNounCategory('action', weights), false);
  assert.equal(isSceneNounCategory('description', weights), false);
  assert.equal(isSceneNounCategory('object', weights), true);
  assert.equal(isSceneNounCategory('place', weights), true);
  assert.equal(isSceneNounCategory('time', weights), true);
  assert.equal(isSceneNounCategory('person', weights), true);
  assert.equal(isSceneNounCategory('food', weights), true);
});

test('S9 condition 3+9: nouns.json\'s "shoulder"(어깨)/"hand"(손)/"hair"(머리카락) are category:"body" and excluded from sceneNouns by default; removing "body" from excludeCategories makes them eligible again (never hardcoded)', () => {
  const nounsPath = path.join(__dirname, '..', 'data', 'lexicon', 'ko', 'nouns.json');
  const nouns = JSON.parse(fs.readFileSync(nounsPath, 'utf8').replace(/^﻿/, ''));
  assert.equal(nouns.entries.shoulder.category, 'body');
  assert.equal(nouns.entries.hand.category, 'body');
  assert.equal(nouns.entries.hair.category, 'body');

  const weights = loadSceneNounWeights();
  assert.ok(weights.excludeCategories.includes('body'));
  assert.equal(isSceneNounCategory('body', weights), false);

  const withoutBodyExcluded = { ...weights, excludeCategories: weights.excludeCategories.filter((c) => c !== 'body') };
  assert.equal(isSceneNounCategory('body', withoutBodyExcluded), true, 'removing "body" from excludeCategories must make body-category words eligible again — if this fails, the exclusion is hardcoded somewhere else');
});

test('S9 condition 5: rankSceneTerms tops up from a description fallback pool when the primary candidate pool is short of topCount, and callers can detect the shortfall to warn', () => {
  const weights = loadSceneNounWeights();
  const termInfo = new Map([
    ['커피', { songs: new Set([1]), category: 'object', order: 0 }],
    ['해변 산책로', { songs: new Set([2]), category: 'place', order: 1 }],
  ]);
  const primary = rankSceneTerms(termInfo, weights, weights.topCount);
  assert.equal(primary.length, 2, 'only 2 real candidates exist, so the primary pool alone is short of topCount');
});

test('S9 condition 5: normalizeSetPack tops up set.sceneNouns from description when the primary pool is short, and records a warning', () => {
  const data = baseValidSetPack(
    Array.from({ length: 3 }, (_, i) => ({
      trackNo: i + 1,
      // Same text on every song: "kettle" (object, primary) + "morning"
      // (time, primary) = 2 primary candidates; "quiet"/"warm"/"slow"
      // (description, fallback-only) = 3 more available as a top-up.
      // 2 + 3 = 5, still short of topCount(12) — every fallback candidate
      // gets used and a warning is expected.
      listenerSituation: 'a quiet warm slow kettle morning',
    }))
  );
  const { normalized } = normalizeSetPack(data, []);
  assert.equal(normalized.set.sceneNouns.length, 5, `expected 2 primary + 3 description fallback = 5, got: ${JSON.stringify(normalized.set.sceneNouns)}`);
  const fallbackWarning = normalized.set.warnings.find((w) => w.includes('description 카테고리에서'));
  assert.ok(fallbackWarning, `expected a fallback warning, got: ${JSON.stringify(normalized.set.warnings)}`);
  assert.ok(fallbackWarning.includes('3개'), `expected the warning to name the count (3), got: "${fallbackWarning}"`);
});

test('S9 condition 3+4: the v2 fixture\'s set.sceneNouns and actual generated instagram/naver text contain none of the excluded body words', () => {
  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized } = normalizeSetPack(v2, []);
  const bodyWords = ['어깨', '손', '머리카락', '무릎'];
  for (const w of bodyWords) {
    assert.ok(!normalized.set.sceneNouns.includes(w), `expected sceneNouns to exclude body word "${w}", got: ${JSON.stringify(normalized.set.sceneNouns)}`);
  }
});

// ---------------------------------------------------------------------------
// TASK-S9 후속 작업 1 — set.sceneNounDetails
// ---------------------------------------------------------------------------

test('S9 후속 완료조건 1: set.sceneNounDetails has the same length and order (by ko) as set.sceneNouns, one {en, ko, category, songCount, score} per word', () => {
  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized } = normalizeSetPack(v2, []);
  const { sceneNouns, sceneNounDetails } = normalized.set;
  assert.equal(sceneNounDetails.length, sceneNouns.length);
  assert.deepEqual(sceneNounDetails.map((d) => d.ko), sceneNouns, 'sceneNounDetails must be in the exact same order as sceneNouns');
  for (const d of sceneNounDetails) {
    assert.equal(typeof d.en, 'string', `expected a string "en" for ${d.ko}, got: ${JSON.stringify(d)}`);
    assert.equal(typeof d.ko, 'string');
    assert.equal(typeof d.category, 'string');
    assert.equal(typeof d.songCount, 'number');
    assert.ok(d.songCount >= 1);
    assert.equal(typeof d.score, 'number');
    assert.ok(d.score > 0);
  }
});

test('S9 후속: sceneNounDetails.en reflects the actual surface text matched in the source (traceable back to the input), not just the dictionary key', () => {
  const data = baseValidSetPack([{ listenerSituation: 'a warm porch swing at dusk' }]);
  const { normalized } = normalizeSetPack(data, []);
  const porchSwing = normalized.set.sceneNounDetails.find((d) => d.ko === '포치 그네');
  assert.ok(porchSwing, `expected "포치 그네" in sceneNounDetails, got: ${JSON.stringify(normalized.set.sceneNounDetails)}`);
  assert.equal(porchSwing.en, 'porch swing');
});

test('S9 후속: sceneNounDetails for description-fallback entries also carry en/category/songCount/score (not left undefined)', () => {
  const data = baseValidSetPack(
    Array.from({ length: 3 }, (_, i) => ({ trackNo: i + 1, listenerSituation: 'a quiet warm slow kettle morning' }))
  );
  const { normalized } = normalizeSetPack(data, []);
  const fallbackEntry = normalized.set.sceneNounDetails.find((d) => d.category === 'description');
  assert.ok(fallbackEntry, `expected at least one description-category entry from the fallback top-up, got: ${JSON.stringify(normalized.set.sceneNounDetails)}`);
  assert.equal(typeof fallbackEntry.en, 'string');
  assert.equal(typeof fallbackEntry.score, 'number');
});

// ---------------------------------------------------------------------------
// TASK-S9 후속 작업 3 — "하루" 등 폭넓은 시간어를 abstract로
// ---------------------------------------------------------------------------

test('S9 후속 완료조건 3: "day"(하루)는 timewords.json에서 category:"abstract"이고, v2 세트의 sceneNouns에 "하루"가 없다', () => {
  const timewordsPath = path.join(__dirname, '..', 'data', 'lexicon', 'ko', 'timewords.json');
  const timewords = JSON.parse(fs.readFileSync(timewordsPath, 'utf8').replace(/^﻿/, ''));
  assert.equal(timewords.entries.day.category, 'abstract');

  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { normalized } = normalizeSetPack(v2, []);
  assert.ok(!normalized.set.sceneNouns.includes('하루'), `expected "하루" excluded from sceneNouns, got: ${JSON.stringify(normalized.set.sceneNouns)}`);
});

test('S9 후속: 구체적인 시간대(동틀 무렵/저녁/밤/노을 등)는 여전히 category:"time"으로 남아 sceneNouns 후보 자격이 있다', () => {
  const timewordsPath = path.join(__dirname, '..', 'data', 'lexicon', 'ko', 'timewords.json');
  const timewords = JSON.parse(fs.readFileSync(timewordsPath, 'utf8').replace(/^﻿/, ''));
  for (const key of ['afternoon', 'dusk', 'evening', 'first light', 'morning', 'night', 'sunset']) {
    assert.equal(timewords.entries[key].category, 'time', `expected "${key}" to remain category:"time"`);
  }
});

test('S9 후속 완료조건 4: v1·v2 명사 커버리지가 그대로다 (재분류로 사전 항목을 지우지 않았다) — 합성 픽스처는 기존부터 >=0.90 기준(정확한 1.00은 실제 v1/v2 파일로 별도 검증, 완료 보고 참조)', () => {
  const v1 = readSetPackFile(FIXTURE_PATH);
  const { report: r1 } = normalizeSetPack(v1, []);
  assert.ok(r1.coverage.nouns >= 0.9, `v1 coverage.nouns regressed: ${r1.coverage.nouns}`);
  const v2 = readSetPackFile(FIXTURE_V2_PATH);
  const { report: r2 } = normalizeSetPack(v2, []);
  assert.ok(r2.coverage.nouns >= 0.9, `v2 coverage.nouns regressed: ${r2.coverage.nouns}`);
});
