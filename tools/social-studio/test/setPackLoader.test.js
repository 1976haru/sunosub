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

test('condition 3d: missing titleLocalized throws', () => {
  const data = baseValidSetPack();
  delete data.songs[0].titleLocalized;
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
