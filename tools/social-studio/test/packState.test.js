import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetPackPipeline } from '../parse/setPackLoader.js';
import { runTextPackPipeline } from '../generate/textPack.js';
import {
  isValidSetName,
  getOutDir,
  resolveWithinOutDir,
  atomicWriteJson,
  loadState,
  saveState,
  loadEdits,
  saveEdit,
  revertEdit,
  buildDisplayItems,
  isKnownItemId,
  PackStateError,
} from '../store/packState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-setpack.json');
const OUT_ROOT = path.join(__dirname, '..', 'out');

// The fixture's setName is fixed, so every test shares one out/{setName}/
// directory unless we clear pack-state.json / textpack.edited.json left
// behind by earlier tests — otherwise tests would leak state into each other.
function freshSet(options = {}) {
  const { normalized } = runSetPackPipeline(FIXTURE_PATH);
  const { outDir } = runTextPackPipeline(normalized, options);
  for (const name of ['pack-state.json', 'textpack.edited.json']) {
    const p = path.join(outDir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return normalized.set.setName;
}

// --- setName whitelist ---

test('isValidSetName accepts a real out/ directory with a textpack.json', () => {
  const setName = freshSet();
  assert.equal(isValidSetName(setName), true);
});

test('isValidSetName rejects path traversal and nonexistent sets', () => {
  assert.equal(isValidSetName('../../windows'), false);
  assert.equal(isValidSetName('..\\..\\windows'), false);
  assert.equal(isValidSetName('totally-nonexistent-set'), false);
  assert.equal(isValidSetName(''), false);
});

test('getOutDir throws PackStateError for an invalid setName', () => {
  assert.throws(() => getOutDir('../../etc'), PackStateError);
});

// --- condition 8: reveal path whitelist ---

test('condition 8: resolveWithinOutDir resolves a valid sub-path inside the set\'s out dir', () => {
  const setName = freshSet();
  const resolved = resolveWithinOutDir(setName, '');
  assert.equal(resolved, path.resolve(OUT_ROOT, setName));
});

test('condition 8: resolveWithinOutDir rejects a ".." traversal attempt', () => {
  const setName = freshSet();
  assert.throws(() => resolveWithinOutDir(setName, '../../../windows'), PackStateError);
});

test('condition 8: resolveWithinOutDir rejects an absolute path outside out/', () => {
  const setName = freshSet();
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
  assert.throws(() => resolveWithinOutDir(setName, outside), PackStateError);
});

// --- condition 9: atomic writes ---

test('condition 9: atomicWriteJson leaves no temp file behind and the target is valid JSON', () => {
  const dir = getOutDir(freshSet());
  const target = path.join(dir, 'atomic-test.json');
  atomicWriteJson(target, { a: 1 });
  const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftoverTmp, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1 });
  fs.unlinkSync(target);
});

test('condition 9: a stale leftover .tmp file from a previous interrupted write never becomes the real file', () => {
  const dir = getOutDir(freshSet());
  const target = path.join(dir, 'atomic-test-2.json');
  atomicWriteJson(target, { first: true });
  // Simulate a crash mid-write: a .tmp file exists but was never renamed.
  fs.writeFileSync(path.join(dir, `.${path.basename(target)}.99999.123.tmp`), '{corrupt', 'utf8');
  const contentAfterSimulatedCrash = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(contentAfterSimulatedCrash, { first: true }); // untouched — the .tmp file was never renamed over it
  atomicWriteJson(target, { second: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { second: true });
  fs.readdirSync(dir).filter((f) => f.startsWith('.atomic-test-2')).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  fs.unlinkSync(target);
});

// --- state (checks / youtubeUrl) persistence ---

test('saveState merges checks rather than replacing the whole map', () => {
  const setName = freshSet();
  saveState(setName, { checks: { 'a': true } });
  saveState(setName, { checks: { 'b': true } });
  const state = loadState(setName);
  assert.deepEqual(state.checks, { a: true, b: true });
});

test('saveState persists youtubeUrl across separate loadState calls (simulates reopening the browser)', () => {
  const setName = freshSet();
  saveState(setName, { youtubeUrl: 'https://youtu.be/example123' });
  assert.equal(loadState(setName).youtubeUrl, 'https://youtu.be/example123');
});

// --- edits ---

test('saveEdit + loadEdits roundtrip, and revertEdit removes the override', () => {
  const setName = freshSet();
  saveEdit(setName, 'youtube.pinnedComment', '수정된 고정 댓글');
  assert.equal(loadEdits(setName).overrides['youtube.pinnedComment'], '수정된 고정 댓글');
  revertEdit(setName, 'youtube.pinnedComment');
  assert.equal(loadEdits(setName).overrides['youtube.pinnedComment'], undefined);
});

// --- condition 2: edited value flows through to buildDisplayItems ---

test('condition 2 mechanism: an edited item\'s displayed value is the edited text, not the original', () => {
  const setName = freshSet();
  const before = buildDisplayItems(setName).items.find((i) => i.id === 'youtube.pinnedComment');
  saveEdit(setName, 'youtube.pinnedComment', '완전히 새로운 고정 댓글 텍스트');
  const after = buildDisplayItems(setName).items.find((i) => i.id === 'youtube.pinnedComment');
  assert.notEqual(after.value, before.value);
  assert.equal(after.value, '완전히 새로운 고정 댓글 텍스트');
  assert.equal(after.edited, true);
  assert.equal(after.original, before.value);
});

// --- condition 5: edits survive a fresh S1 rerun (new textpack.json) ---

test('condition 5: an edit survives textpack.json being regenerated, and drift is flagged', () => {
  const { normalized } = runSetPackPipeline(FIXTURE_PATH);
  const { outDir } = runTextPackPipeline(normalized, {});
  const setName = normalized.set.setName;
  // The fixture's setName is shared with every other test file, so clear
  // any pack-state.json / textpack.edited.json a previously-run file left
  // behind — this test needs a genuinely clean slate to check originalChanged.
  for (const name of ['pack-state.json', 'textpack.edited.json']) {
    const p = path.join(outDir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  saveEdit(setName, 'facebook.body', '완전히 새로 쓴 페이스북 글');
  let display = buildDisplayItems(setName);
  assert.equal(display.items.find((i) => i.id === 'facebook.body').value, '완전히 새로 쓴 페이스북 글');
  assert.equal(display.originalChanged, false);

  // Simulate "S1을 다시 실행" by regenerating textpack.json with a different youtubeUrl
  // (changes x.main, so the file's content — and therefore its hash — actually differs).
  runTextPackPipeline(normalized, { youtubeUrl: 'https://youtu.be/rerunMarker999' });

  display = buildDisplayItems(setName);
  assert.equal(display.items.find((i) => i.id === 'facebook.body').value, '완전히 새로 쓴 페이스북 글', 'edit must survive the rerun');
  assert.equal(display.originalChanged, true, 'a changed textpack.json must be flagged');
  void outDir;
});

// --- condition 4 mechanism: X regenerates once a URL is applied ---

test('condition 4 mechanism: x.main is absent with no URL, then appears with a real character count once one is applied', () => {
  const setName = freshSet(); // freshSet() runs S1 with no youtubeUrl
  const before = buildDisplayItems(setName).items.find((i) => i.id === 'x.main');
  assert.equal(before, undefined, 'no URL yet -> S1 produced no x.main at all');

  saveState(setName, { youtubeUrl: 'https://youtu.be/appliedLater123' });
  const after = buildDisplayItems(setName).items.find((i) => i.id === 'x.main');
  assert.ok(after);
  assert.ok(after.value.includes('https://youtu.be/appliedLater123'));
  assert.ok(after.count > 0 && after.count <= 280);
});

// --- known item id validation (used by the /edit route to reject arbitrary keys) ---

test('isKnownItemId is true for a real item and false for a made-up one', () => {
  const setName = freshSet();
  assert.equal(isKnownItemId(setName, 'youtube.pinnedComment'), true);
  assert.equal(isKnownItemId(setName, 'not.a.real.item'), false);
});

// --- condition 11: unused platform sections are not present at all ---

test('condition 11: buildDisplayItems only returns sections the channel config lists AND that have content', () => {
  const setName = freshSet();
  const display = buildDisplayItems(setName);
  assert.ok(!display.sections.includes('hatena'), 'hatena is null for this ko channel and must not appear');
  assert.deepEqual(display.sections, ['youtube', 'naver', 'facebook', 'x', 'instagram', 'shorts']);
});
