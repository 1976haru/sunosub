import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForSimilarity,
  charTrigrams,
  jaccardSimilarity,
  contentFingerprint,
  extractProseFields,
} from '../lint/similarity.js';

// --- completion condition 5: similarity function verification ---

test('condition 5: identical strings have similarity 1.0', () => {
  const text = '늦여름의 시작 저녁, 굿모닝 추억라디오와 함께하세요. 차분한 편안함이 필요한 분들을 위한 18곡입니다.';
  assert.equal(jaccardSimilarity(text, text), 1);
});

test('condition 5: two unrelated Korean sentences score under 0.2', () => {
  const a = '늦여름의 시작 저녁, 굿모닝 추억라디오와 함께하세요. 차분한 편안함이 필요한 분들을 위한 18곡입니다.';
  const b = '창밖에 비가 내리는 오후, 우산 없이 걷던 그날의 기억이 떠오릅니다. 오늘도 무사히 하루를 마쳤습니다.';
  const value = jaccardSimilarity(a, b);
  assert.ok(value < 0.2, `expected < 0.2, got ${value}`);
});

test('condition 5: similarity is symmetric', () => {
  const a = '오늘의 플레이리스트를 소개합니다.';
  const b = '완전히 다른 문장을 하나 적어봅니다.';
  assert.equal(jaccardSimilarity(a, b), jaccardSimilarity(b, a));
});

test('a near-duplicate paraphrase (one word swapped) scores high, well above the R1 default threshold', () => {
  const a = '늦여름의 시작 저녁에 어울리는 차분한 편안함 노래 18곡. 프로필 링크에서 전곡을 들어보세요.';
  const b = '늦여름의 시작 저녁에 어울리는 잔잔한 편안함 노래 18곡. 프로필 링크에서 전곡을 들어보세요.';
  const value = jaccardSimilarity(a, b);
  assert.ok(value > 0.6, `expected > 0.6, got ${value}`);
});

test('two empty/whitespace-only strings are NOT "identical" — similarity is 0, not 1', () => {
  assert.equal(jaccardSimilarity('', ''), 0);
  assert.equal(jaccardSimilarity('   ', ''), 0);
});

// --- normalization ---

test('normalizeForSimilarity strips URLs and hashtags, folds numbers, drops punctuation', () => {
  const text = '오늘 18곡을 https://youtu.be/abc 에 올렸어요! #추억라디오 #7080';
  const normalized = normalizeForSimilarity(text);
  assert.ok(!normalized.includes('http'), 'URL must be stripped');
  assert.ok(!normalized.includes('추억라디오'), 'hashtag text must be stripped');
  assert.ok(!normalized.includes('!'), 'punctuation must be stripped');
  assert.equal(normalized, '오늘 #곡을 에 올렸어요'); // "18" folded to a single '#' marker
});

test('hashtags/URLs excluded from similarity: two captions differing only in URL/hashtags are still similarity 1.0', () => {
  const a = '오늘의 플레이리스트입니다. https://youtu.be/aaa #추억라디오 #7080';
  const b = '오늘의 플레이리스트입니다. https://youtu.be/completely-different-url-here #다른해시태그';
  assert.equal(jaccardSimilarity(a, b), 1);
});

// --- trigrams ---

test('charTrigrams on a short (<3 char) string returns the whole string as one gram', () => {
  const grams = charTrigrams('ab');
  assert.deepEqual([...grams], ['ab']);
});

test('charTrigrams on an empty string returns an empty set', () => {
  assert.equal(charTrigrams('').size, 0);
});

// --- fingerprint (not raw text) ---

test('contentFingerprint is a short opaque string, not the original text, and is stable for the same input', () => {
  const text = '이것은 원문 텍스트입니다. 지문에는 이 문장이 그대로 들어가면 안 됩니다.';
  const fp = contentFingerprint(text);
  assert.ok(fp.length <= 12, `fingerprint should be short, got length ${fp.length}`);
  assert.ok(!fp.includes('원문'));
  assert.equal(fp, contentFingerprint(text));
});

test('contentFingerprint differs for different text', () => {
  assert.notEqual(contentFingerprint('문장 A입니다'), contentFingerprint('문장 B입니다'));
});

// --- extractProseFields ---

test('extractProseFields pulls known prose paths and skips empty/missing ones', () => {
  const textpack = {
    youtube: { titles: ['제목1', '', null], description: '설명문입니다', pinnedComment: null },
    instagram: { caption: '캡션입니다' },
    x: { main: null, thread: [] },
    shorts: [{ trackNo: 1, titleKo: '쇼츠제목', descriptionKo: null }],
  };
  const fields = extractProseFields(textpack);
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes('youtube.titles.0'));
  assert.ok(!paths.includes('youtube.titles.1')); // empty string skipped
  assert.ok(!paths.includes('youtube.titles.2')); // null skipped
  assert.ok(paths.includes('youtube.description'));
  assert.ok(!paths.includes('youtube.pinnedComment'));
  assert.ok(paths.includes('instagram.caption'));
  assert.ok(!paths.includes('x.main'));
  assert.ok(paths.includes('shorts.1.titleKo'));
  assert.ok(!paths.includes('shorts.1.descriptionKo'));
});
