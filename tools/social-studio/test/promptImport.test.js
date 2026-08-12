import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetPackPipeline } from '../parse/setPackLoader.js';
import { runTextPackPipeline } from '../generate/textPack.js';
import {
  stripCodeFence,
  parseCandidateJson,
  mergeCandidateIntoTextpack,
  importPromptResult,
  PromptImportError,
} from '../generate/promptImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');
const OUT_ROOT = path.join(__dirname, '..', 'out');

function freshSet() {
  // Unique setName per call (baked into the file BEFORE the pipeline runs, so
  // out/{setName} on disk actually matches normalized.set.setName) so parallel
  // test files never collide on the same out/ directory.
  const raw = JSON.parse(fs.readFileSync(FIXTURE_V2_PATH, 'utf8').replace(/^﻿/, ''));
  raw.meta.setName = `promptImportTest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tmpFile = path.join(os.tmpdir(), `promptImportTest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(raw), 'utf8');
  let normalized;
  try {
    ({ normalized } = runSetPackPipeline(tmpFile));
  } finally {
    fs.unlinkSync(tmpFile);
  }
  const { textpack, outDir } = runTextPackPipeline(normalized, {});
  return { normalized, localTextpack: textpack, outDir };
}

function cleanup(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
}

// --- stripCodeFence / parseCandidateJson ---

test('stripCodeFence removes a ```json fence, keeps plain JSON untouched', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```').trim(), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}').trim(), '{"a":1}');
});

test('parseCandidateJson parses fenced and unfenced JSON identically', () => {
  const a = parseCandidateJson('```json\n{"facebook":{"body":"hi"}}\n```');
  const b = parseCandidateJson('{"facebook":{"body":"hi"}}');
  assert.deepEqual(a, b);
});

test('완료조건 5: malformed JSON throws PromptImportError naming a location, existing result untouched by the caller', () => {
  // Long enough input that V8's JSON.parse error includes a position (short
  // inputs get a different, positionless "here's the snippet" message format
  // — describeJsonParseError() in promptImport.js handles both, but this
  // asserts the common real-world case: a multi-hundred-char pasted LLM reply).
  const longBroken = JSON.stringify({ facebook: { body: 'x'.repeat(300) }, naver: { title: 'y' } }).slice(0, -1) + ',}';
  assert.throws(() => parseCandidateJson(longBroken), (err) => {
    assert.ok(err instanceof PromptImportError);
    assert.match(err.message, /행 \d+열/);
    return true;
  });
});

test('a short malformed JSON still throws PromptImportError with a non-empty, specific message (positionless V8 format)', () => {
  assert.throws(() => parseCandidateJson('{"a": 1, "b": }'), (err) => {
    assert.ok(err instanceof PromptImportError);
    assert.ok(err.message.length > 20);
    return true;
  });
});

test('empty pasted text throws a clear PromptImportError', () => {
  assert.throws(() => parseCandidateJson('   '), PromptImportError);
});

// --- mergeCandidateIntoTextpack ---

test('완료조건 6: fields absent from the candidate keep the local value untouched', () => {
  const { normalized, localTextpack, outDir } = freshSet();
  try {
    const candidate = { facebook: { body: '아침 주전자가 딸깍이며 잦아드는 조용한 장면으로 시작합니다.' } };
    const { textpack, replaced, keptLocal } = mergeCandidateIntoTextpack(candidate, localTextpack, normalized);
    assert.equal(textpack.facebook.body, candidate.facebook.body);
    assert.equal(textpack.naver.title, localTextpack.naver.title, 'untouched field must equal the local value');
    assert.deepEqual(textpack.instagram, localTextpack.instagram);
    assert.ok(replaced.includes('facebook.body'));
    assert.equal(keptLocal.length, 0);
  } finally {
    cleanup(outDir);
  }
});

test('a field that fails the hallucination guard falls back to local and is recorded with a reason', () => {
  const { normalized, localTextpack, outDir } = freshSet();
  try {
    const candidate = { facebook: { body: 'Elvis Presley가 부른 1975년 빌보드 1위 곡입니다.' } };
    const { textpack, replaced, keptLocal, errors } = mergeCandidateIntoTextpack(candidate, localTextpack, normalized);
    assert.equal(textpack.facebook.body, localTextpack.facebook.body);
    assert.ok(!replaced.includes('facebook.body'));
    assert.ok(keptLocal.some((k) => k.path === 'facebook.body'));
    assert.ok(errors.length > 0);
  } finally {
    cleanup(outDir);
  }
});

test('array fields (youtube.titles) are replaced only when every item passes; one bad title keeps the whole local array', () => {
  const { normalized, localTextpack, outDir } = freshSet();
  try {
    const candidate = { youtube: { titles: ['좋은 저녁을 위한 잔잔한 18곡', 'Elvis Presley 명곡 모음 18곡', '오늘의 플레이리스트'] } };
    const { textpack, keptLocal } = mergeCandidateIntoTextpack(candidate, localTextpack, normalized);
    assert.deepEqual(textpack.youtube.titles, localTextpack.youtube.titles);
    assert.ok(keptLocal.some((k) => k.path === 'youtube.titles'));
  } finally {
    cleanup(outDir);
  }
});

test('shorts are merged by trackNo, unknown trackNo in the candidate is ignored', () => {
  const { normalized, localTextpack, outDir } = freshSet();
  try {
    const realTrackNo = localTextpack.shorts[0].trackNo;
    const candidate = {
      shorts: [
        { trackNo: realTrackNo, titleKo: '새로 쓴 쇼츠 제목', descriptionKo: '새로 쓴 쇼츠 설명' },
        { trackNo: 99999, titleKo: '존재하지 않는 트랙' },
      ],
    };
    const { textpack, replaced } = mergeCandidateIntoTextpack(candidate, localTextpack, normalized);
    const merged = textpack.shorts.find((s) => s.trackNo === realTrackNo);
    assert.equal(merged.titleKo, '새로 쓴 쇼츠 제목');
    assert.ok(replaced.includes(`shorts[${realTrackNo}].titleKo`));
    assert.ok(!textpack.shorts.some((s) => s.trackNo === 99999));
  } finally {
    cleanup(outDir);
  }
});

// --- importPromptResult (full file I/O) ---

test('완료조건 7: importPromptResult never overwrites textpack.local.json, and textpack.json reflects the merge', () => {
  const { normalized, outDir } = freshSet();
  try {
    const localBefore = fs.readFileSync(path.join(outDir, 'textpack.local.json'), 'utf8');
    const raw = '```json\n' + JSON.stringify({ facebook: { body: '오늘 18곡을 준비했습니다. 주전자가 딸깍이는 아침으로 시작합니다.' } }) + '\n```';
    const result = importPromptResult(normalized.set.setName, raw);
    assert.equal(result.textpack.facebook.body, '오늘 18곡을 준비했습니다. 주전자가 딸깍이는 아침으로 시작합니다.');

    const localAfter = fs.readFileSync(path.join(outDir, 'textpack.local.json'), 'utf8');
    assert.equal(localAfter, localBefore, 'textpack.local.json must be byte-identical after an import');

    const onDiskTextpack = JSON.parse(fs.readFileSync(path.join(outDir, 'textpack.json'), 'utf8'));
    assert.equal(onDiskTextpack.facebook.body, result.textpack.facebook.body);
  } finally {
    cleanup(outDir);
  }
});

test('re-importing after a failed attempt merges against the pristine local base, not a previous partial import', () => {
  const { normalized, outDir } = freshSet();
  try {
    // First import: a bad field that gets rejected.
    importPromptResult(normalized.set.setName, JSON.stringify({ naver: { title: 'Elvis Presley 특집' } }));
    const afterFirst = JSON.parse(fs.readFileSync(path.join(outDir, 'textpack.json'), 'utf8'));
    assert.notEqual(afterFirst.naver.title, 'Elvis Presley 특집');

    // Second import: a good field. Must merge against textpack.local.json, so the
    // rejected naver.title from attempt 1 doesn't linger or interfere.
    const result = importPromptResult(normalized.set.setName, JSON.stringify({ facebook: { body: '18곡을 준비했습니다.' } }));
    assert.equal(result.textpack.facebook.body, '18곡을 준비했습니다.');
    assert.notEqual(result.textpack.naver.title, 'Elvis Presley 특집');
  } finally {
    cleanup(outDir);
  }
});

test('importPromptResult throws PromptImportError when textpack.local.json does not exist yet', () => {
  const setName = `promptImportTest_missing_${Date.now()}`;
  const outDir = path.join(OUT_ROOT, setName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'normalized.json'), '{}', 'utf8');
  try {
    assert.throws(() => importPromptResult(setName, '{"facebook":{"body":"hi"}}'), PromptImportError);
  } finally {
    cleanup(outDir);
  }
});
