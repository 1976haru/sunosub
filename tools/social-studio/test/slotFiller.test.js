import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTemplateFile,
  fillSlots,
  selectTemplate,
  selectDistinctTemplates,
  selectTemplateWithinLimit,
  TemplatePoolError,
} from '../generate/slotFiller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const CHANNEL_DIR = path.join(TEMPLATES_DIR, 'good-morning-memory-radio');

test('loadTemplateFile reads a real template pool', () => {
  const templates = loadTemplateFile('good-morning-memory-radio', 'youtube-title');
  assert.ok(templates.length >= 10, `spec requires >=10 templates, found ${templates.length}`);
});

test('loadTemplateFile throws TemplatePoolError for a channel/platform with no file', () => {
  assert.throws(() => loadTemplateFile('good-morning-memory-radio', 'no-such-platform'), TemplatePoolError);
});

test('condition 3 mechanism: an empty templates file (templates:[]) throws TemplatePoolError', () => {
  const tmpDir = path.join(TEMPLATES_DIR, '__test_empty_channel__');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'youtube-title.json'), JSON.stringify({ version: 1, templates: [] }));
  try {
    assert.throws(() => loadTemplateFile('__test_empty_channel__', 'youtube-title'), TemplatePoolError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fillSlots substitutes every {slot} when all are present', () => {
  const result = fillSlots('{a}와 {b}', { a: '커피', b: '음악' });
  assert.equal(result, '커피와 음악');
});

test('fillSlots returns null (not a blank) when any referenced slot is missing/empty', () => {
  assert.equal(fillSlots('{a}와 {b}', { a: '커피' }), null);
  assert.equal(fillSlots('{a}와 {b}', { a: '커피', b: '' }), null);
});

test('particle marker (이/가): resolves to 이 after a batchim, 가 after a vowel ending', () => {
  assert.equal(fillSlots('{x}(이/가) 필요하다', { x: '차분한 편안함' }), '차분한 편안함이 필요하다'); // 함 has a batchim
  assert.equal(fillSlots('{x}(이/가) 필요하다', { x: '굿모닝 추억라디오' }), '굿모닝 추억라디오가 필요하다'); // 오 has no batchim
});

test('particle marker (은/는), (을/를), (과/와) follow the same batchim rule', () => {
  assert.equal(fillSlots('{x}(은/는) 좋다', { x: '음악' }), '음악은 좋다');
  assert.equal(fillSlots('{x}(은/는) 좋다', { x: '커피' }), '커피는 좋다');
  assert.equal(fillSlots('{x}(을/를) 듣다', { x: '음악' }), '음악을 듣다');
  assert.equal(fillSlots('{x}(을/를) 듣다', { x: '커피' }), '커피를 듣다');
  assert.equal(fillSlots('{x}(과/와) 함께', { x: '음악' }), '음악과 함께');
  assert.equal(fillSlots('{x}(과/와) 함께', { x: '커피' }), '커피와 함께');
});

test('particle marker (으로/로): a bare ㄹ batchim takes the short form like a vowel ending', () => {
  assert.equal(fillSlots('{x}(으로/로) 간다', { x: '마음' }), '마음으로 간다'); // ㅁ batchim -> 으로
  assert.equal(fillSlots('{x}(으로/로) 간다', { x: '노래' }), '노래로 간다'); // vowel ending -> 로
  assert.equal(fillSlots('{x}(으로/로) 간다', { x: '겨울' }), '겨울로 간다'); // bare ㄹ batchim -> 로 (liaison)
});

test('selectTemplate skips templates with an empty slot and picks the first usable one via rotation', () => {
  const templates = [
    { id: 't1', text: '{missing} 텍스트' },
    { id: 't2', text: '{present} 텍스트' },
  ];
  const result = selectTemplate(templates, { present: '값' }, 'any-set', 'salt');
  assert.equal(result.id, 't2');
  assert.equal(result.text, '값 텍스트');
});

test('selectTemplate throws TemplatePoolError when literally no template can be filled', () => {
  const templates = [
    { id: 't1', text: '{missing1}' },
    { id: 't2', text: '{missing2}' },
  ];
  assert.throws(() => selectTemplate(templates, { present: '값' }, 'any-set', 'salt'), TemplatePoolError);
});

test('selectDistinctTemplates returns up to `count` distinct rendered texts', () => {
  const templates = [
    { id: 't1', text: 'A {x}' },
    { id: 't2', text: 'B {x}' },
    { id: 't3', text: 'C {x}' },
    { id: 't4', text: 'A {x}' }, // renders identically to t1 given the same slot value
  ];
  const result = selectDistinctTemplates(templates, { x: '1' }, 'set-name', 'salt', 3);
  const texts = result.map((r) => r.text);
  assert.equal(new Set(texts).size, texts.length, 'all returned texts should be distinct');
  assert.ok(texts.length <= 3);
});

test('selectTemplateWithinLimit retries a shorter template instead of truncating a string', () => {
  const templates = [
    { id: 'long', text: '아주 길게 늘어지는 {x} 문장입니다 정말로 아주 깁니다' },
    { id: 'short', text: '{x} 짧음' },
  ];
  // Force rotation to try 'long' first by using its own id space is not controllable directly,
  // so this test just verifies that SOME result respects maxLength via retry, whichever order rotation picks.
  const result = selectTemplateWithinLimit(templates, { x: '값' }, 'set-name', 'salt', null, { maxLength: 10, maxRetries: 5 });
  assert.equal(result.withinLimit, true);
  assert.ok(result.text.length <= 10);
});

test('selectTemplateWithinLimit reports withinLimit:false (never truncates) when nothing fits after retrying', () => {
  const templates = [
    { id: 't1', text: '{x} 이것도 제한보다 훨씬 긴 문장입니다' },
    { id: 't2', text: '{x} 이것 역시 제한보다 훨씬 긴 문장입니다' },
  ];
  const result = selectTemplateWithinLimit(templates, { x: '값' }, 'set-name', 'salt', null, { maxLength: 3, maxRetries: 5 });
  assert.equal(result.withinLimit, false);
  assert.equal(result.text, null);
});

test('real channel templates: role filter (youtube-desc.json) separates intro from closing', () => {
  const templates = loadTemplateFile('good-morning-memory-radio', 'youtube-desc');
  const introCount = templates.filter((t) => t.role === 'intro').length;
  const closingCount = templates.filter((t) => t.role === 'closing').length;
  assert.ok(introCount >= 10, `expected >=10 intro templates, got ${introCount}`);
  assert.ok(closingCount >= 10, `expected >=10 closing templates, got ${closingCount}`);
});
