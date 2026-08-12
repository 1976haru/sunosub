import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSetPackFile, validateSetPack, normalizeSetPack } from '../parse/setPackLoader.js';
import { buildHallucinationFacts, checkHallucinationField, scanCandidateTextpack, checkSongTitleProvenance } from '../lint/hallucinationGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');

function loadV2Facts() {
  const data = readSetPackFile(FIXTURE_V2_PATH);
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  return { normalized, facts: buildHallucinationFacts(normalized) };
}

// --- 완료조건 8: 아티스트 실명 차단 fixture ---

test('완료조건 8: a fake artist real name is blocked', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('이 곡은 Elvis Presley가 부른 느낌으로 만들었습니다.', facts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Elvis Presley')), `expected an Elvis Presley error, got: ${JSON.stringify(result.errors)}`);
});

test('a single-word capitalized artist-like name is also blocked', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('Madonna 스타일의 보컬이 인상적입니다.', facts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Madonna')));
});

test('platform/brand names (YouTube, Instagram) are NOT flagged as artist names (allow-list exception)', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('YouTube와 Instagram에서 만나요.', facts);
  assert.equal(result.ok, true, `expected no false-positive artist errors, got: ${JSON.stringify(result.errors)}`);
});

test('words already present in a song title (e.g. "Morning", "Kettle") are not flagged as artist names', () => {
  const { facts } = loadV2Facts();
  // "Morning Kettle Waltz" is track 1's real title — words from it must be exempt.
  const result = checkHallucinationField('Morning Kettle Waltz 같은 곡입니다.', facts);
  assert.equal(result.ok, true, `expected no false positive on the song's own title words, got: ${JSON.stringify(result.errors)}`);
});

test('a year not present anywhere in the input is blocked', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('1985년에 딱 어울리는 분위기입니다.', facts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('1985')));
});

test('a chart/sales/award factual claim keyword is blocked', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('이 곡은 빌보드 차트 1위를 기록했습니다.', facts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 1);
});

test('a lyric quote that is a real substring of the song lyrics passes', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('가사에 "Steam climbs slow where mornings go"라는 구절이 있습니다.', facts);
  assert.equal(result.ok, true, `expected the real lyric quote to pass, got: ${JSON.stringify(result.errors)}`);
});

test('a lyric quote that does NOT exist in any song lyrics is blocked', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('가사에 "The neon city never sleeps at all tonight"라는 구절이 있습니다.', facts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('가사 원문에 없는 인용')));
});

test('a mismatched song-count mention (25곡 when the set has 18) is blocked', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('오늘은 특별히 25곡을 준비했습니다.', facts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('25곡')));
});

test('a correct song-count mention (18곡) passes', () => {
  const { facts } = loadV2Facts();
  const result = checkHallucinationField('오늘은 18곡을 준비했습니다.', facts);
  assert.equal(result.ok, true, `expected no error, got: ${JSON.stringify(result.errors)}`);
});

test('x.lyricQuote-style fields skip artist/factual checks via opts but still catch a fabricated quote', () => {
  const { facts } = loadV2Facts();
  const ok = checkHallucinationField('You set two cups without a word here', facts, { skipArtistCheck: true, skipFactualCheck: true });
  assert.equal(ok.ok, true);
});

test('checkSongTitleProvenance flags a made-up song title not in the input', () => {
  const { facts } = loadV2Facts();
  const errors = checkSongTitleProvenance(['Made Up Song Title', 'Morning Kettle Waltz'], facts);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('Made Up Song Title'));
});

test('scanCandidateTextpack: a violation in one field does not block other clean fields, and empty/null candidate fields are skipped', () => {
  const { facts } = loadV2Facts();
  const candidate = {
    facebook: { body: '오늘은 18곡을 준비했습니다.' }, // clean
    naver: { title: 'Elvis Presley 스타일의 저녁 플레이리스트' }, // dirty
    instagram: { caption: null }, // should be skipped, not errored
  };
  const { fieldResults, allErrors } = scanCandidateTextpack(candidate, facts);
  const fb = fieldResults.find((f) => f.path === 'facebook.body');
  const nv = fieldResults.find((f) => f.path === 'naver.title');
  assert.equal(fb.ok, true);
  assert.equal(nv.ok, false);
  assert.ok(!fieldResults.some((f) => f.path === 'instagram.caption'));
  assert.ok(allErrors.some((e) => e.includes('Elvis Presley')));
});

test('meta.songCount mismatch is reported under path "meta"', () => {
  const { facts } = loadV2Facts();
  const { fieldResults } = scanCandidateTextpack({ meta: { songCount: 5 } }, facts);
  const meta = fieldResults.find((f) => f.path === 'meta');
  assert.ok(meta && !meta.ok);
  assert.ok(meta.errors.some((e) => e.includes('meta.songCount')));
});
