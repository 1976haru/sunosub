import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKinsoku, violatesLeadingRule, violatesTrailingRule } from '../generate/kinsoku.js';

// --- completion condition 7 ---

test('condition 7: 、does not start a line after applyKinsoku', () => {
  const lines = ['これはテスト', '、続きです'];
  const fixed = applyKinsoku(lines);
  for (const line of fixed) assert.notEqual(line[0], '、');
});

test('condition 7: 。does not start a line after applyKinsoku', () => {
  const lines = ['今日はいい天気です', '。また明日'];
  const fixed = applyKinsoku(lines);
  for (const line of fixed) assert.notEqual(line[0], '。');
});

test('condition 7: 」does not start a line after applyKinsoku', () => {
  const lines = ['彼はそう言った', '」と彼女は答えた'];
  const fixed = applyKinsoku(lines);
  for (const line of fixed) assert.notEqual(line[0], '」');
});

test('condition 7: 「does not end a line after applyKinsoku', () => {
  const lines = ['彼女はこう言った「', 'ありがとう」と'];
  const fixed = applyKinsoku(lines);
  for (const line of fixed) assert.notEqual(line[line.length - 1], '「');
});

test('condition 7: （does not end a line after applyKinsoku', () => {
  const lines = ['詳しくはこちら（', '公式サイト参照）'];
  const fixed = applyKinsoku(lines);
  for (const line of fixed) assert.notEqual(line[line.length - 1], '（');
});

// --- mechanics ---

test('a leading violation is fixed by moving the forbidden char AND the previous line\'s last char down together', () => {
  const fixed = applyKinsoku(['これはテスト', '、続きです']);
  assert.deepEqual(fixed, ['これはテス', 'ト、続きです']);
});

test('a trailing violation is fixed by pushing only the forbidden char forward (an opening bracket may start a line)', () => {
  const fixed = applyKinsoku(['彼は言った（', 'すごいね）と']);
  assert.deepEqual(fixed, ['彼は言った', '（すごいね）と']);
});

test('a line correctly ending in a closing bracket (allowed) is left untouched', () => {
  const lines = ['今日はいい天気」', 'と彼女は言った'];
  assert.deepEqual(applyKinsoku(lines), lines);
});

test('no violation at all -> lines pass through unchanged', () => {
  const lines = ['これは普通の文章です', 'なにも問題ありません'];
  assert.deepEqual(applyKinsoku(lines), lines);
});

test('a single-line input with no next/previous line is left as-is (no crash on out-of-range)', () => {
  assert.deepEqual(applyKinsoku(['、これだけ']), ['、これだけ']);
});

test('violatesLeadingRule / violatesTrailingRule correctly classify sample characters', () => {
  assert.equal(violatesLeadingRule('、'), true);
  assert.equal(violatesLeadingRule('あ'), false);
  assert.equal(violatesTrailingRule('（'), true);
  assert.equal(violatesTrailingRule('あ'), false);
});

// --- bounded loop (completion condition #12) ---

test('applyKinsoku terminates quickly even on a long run of consecutive forbidden characters', () => {
  const lines = ['あ', '、'.repeat(200), 'い'];
  const start = Date.now();
  const fixed = applyKinsoku(lines);
  assert.ok(Date.now() - start < 2000, 'should terminate quickly, not hang');
  assert.ok(Array.isArray(fixed));
});
