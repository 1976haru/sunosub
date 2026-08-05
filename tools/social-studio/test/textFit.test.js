import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapToWidth, fitText, createMeasurer } from '../generate/textFit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansKR-Regular.otf');
if (!GlobalFonts.families.some((f) => f.family === 'Noto Sans KR')) {
  GlobalFonts.registerFromPath(FONT_PATH, 'Noto Sans KR');
}

// A simple, deterministic fake measurer for pure-logic tests that don't need real glyph metrics —
// each character counts as `perChar` px wide, scaled by fontSize/100.
function fakeMeasurer(perChar = 20) {
  return (text, fontSize) => [...text].length * perChar * (fontSize / 100);
}

function realMeasurer() {
  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  return createMeasurer(ctx, 'Noto Sans KR');
}

// --- wrapToWidth ---

test('wrapToWidth keeps a short string on one line', () => {
  const lines = wrapToWidth('짧은제목', fakeMeasurer(), 1000, 40);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '짧은제목');
});

test('wrapToWidth breaks a long CJK string at character boundaries', () => {
  const text = '가나다라마바사아자차카타파하';
  const lines = wrapToWidth(text, fakeMeasurer(20), 200, 100); // 200px / 20px-per-char = 10 chars per line max
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok([...line].length <= 10);
});

test('wrapToWidth does not break a Latin word mid-word when it still fits on its own line', () => {
  const lines = wrapToWidth('hello world', fakeMeasurer(10), 100, 100); // "hello"=50px, "world"=50px, both fit; "hello world"=110px does not
  assert.deepEqual(lines, ['hello', 'world']);
});

test('wrapToWidth force-splits a single unbreakable run wider than maxWidth, rather than overflowing', () => {
  const longWord = 'Supercalifragilisticexpialidocious';
  const lines = wrapToWidth(longWord, fakeMeasurer(10), 100, 100); // no spaces at all; a whole-word line would be 350px
  for (const line of lines) {
    assert.ok(fakeMeasurer(10)(line, 100) <= 100, `line "${line}" exceeds maxWidth`);
  }
});

// --- fitText: shrink + truncate ---

test('fitText leaves a short title untouched at full size', () => {
  const result = fitText('느린 아침', fakeMeasurer(), { maxWidth: 1000, maxLines: 2, initialFontSize: 60, minFontSize: 30 });
  assert.deepEqual(result.lines, ['느린 아침']);
  assert.equal(result.fontSize, 60);
  assert.equal(result.truncated, false);
});

test('fitText shrinks the font when a longer title needs more than maxLines at the initial size', () => {
  const longTitle = 'Music Down the Long Winding Boardwalk At The Edge Of Everything We Know And Then Some More Words To Make It Longer Still';
  const result = fitText(longTitle, fakeMeasurer(8), { maxWidth: 300, maxLines: 2, initialFontSize: 60, minFontSize: 20, maxAttempts: 8 });
  assert.ok(result.fontSize < 60, `expected a shrunk font size, got ${result.fontSize}`);
  assert.ok(result.lines.length <= 2);
  assert.ok(result.attempts <= 8, 'condition: shrink retry bound is 8');
  assert.ok(result.attempts > 0, 'this fixture should actually need at least one shrink attempt');
});

test('fitText ellipsis-truncates the last line when even minFontSize cannot fit it into maxLines', () => {
  const veryLong = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const result = fitText(veryLong, fakeMeasurer(10), { maxWidth: 200, maxLines: 2, initialFontSize: 60, minFontSize: 40, maxAttempts: 8 });
  assert.equal(result.truncated, true);
  assert.equal(result.lines.length, 2);
  assert.ok(result.lines[1].endsWith('…'));
});

test('fitText never exceeds maxAttempts shrink retries (completion condition #12)', () => {
  const veryLong = 'A'.repeat(500);
  const result = fitText(veryLong, fakeMeasurer(50), { maxWidth: 100, maxLines: 1, initialFontSize: 100, minFontSize: 10, maxAttempts: 8 });
  assert.ok(result.attempts <= 8);
});

// --- pixel-level, real canvas: completion condition #3 ---

test('condition 3: long-title and short-title fixtures wrap differently, and neither ever exceeds maxWidth (real font metrics)', () => {
  const measure = realMeasurer();
  const maxWidth = 900;
  const shortResult = fitText('느린 아침', measure, { maxWidth, maxLines: 2, initialFontSize: 58, minFontSize: 30 });
  const longResult = fitText(
    'Music Down the Boardwalk (An Extended Meditation on Every Summer We Almost Remember)',
    measure,
    { maxWidth, maxLines: 2, initialFontSize: 58, minFontSize: 30 }
  );

  assert.notDeepEqual(shortResult.lines, longResult.lines);
  assert.ok(shortResult.lines.length < longResult.lines.length || shortResult.fontSize >= longResult.fontSize);

  for (const line of shortResult.lines) {
    assert.ok(measure(line, shortResult.fontSize) <= maxWidth, `short-title line exceeds maxWidth: "${line}"`);
  }
  for (const line of longResult.lines) {
    assert.ok(measure(line, longResult.fontSize) <= maxWidth, `long-title line exceeds maxWidth: "${line}"`);
  }
});
