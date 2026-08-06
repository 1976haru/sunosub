import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicWriteJson, atomicWriteText } from '../store/atomicWrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, '..', 'store', 'data', '_atomicWriteTest');

function freshTmpDir() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

test('atomicWriteJson writes valid, correctly-shaped JSON and leaves no temp file behind', () => {
  const dir = freshTmpDir();
  const target = path.join(dir, 'out.json');
  atomicWriteJson(target, { version: 1, entries: [{ id: 'a' }] });

  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(parsed, { version: 1, entries: [{ id: 'a' }] });

  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteJson fully replaces prior content rather than merging', () => {
  const dir = freshTmpDir();
  const target = path.join(dir, 'out.json');
  atomicWriteJson(target, { version: 1, entries: [{ id: 'old' }] });
  atomicWriteJson(target, { version: 1, entries: [{ id: 'new' }] });

  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(parsed, { version: 1, entries: [{ id: 'new' }] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale leftover .tmp file from a previous interrupted write never becomes the real file', () => {
  const dir = freshTmpDir();
  const target = path.join(dir, 'out.json');
  atomicWriteJson(target, { version: 1, entries: [{ id: 'good' }] });

  // Simulate a crash that left a temp file behind mid-write, containing garbage.
  const staleTmp = path.join(dir, '.out.json.99999.123.abcdef.tmp');
  fs.writeFileSync(staleTmp, 'not even json', 'utf8');

  // A later, unrelated write must not be affected by that stale temp file.
  atomicWriteText(target, JSON.stringify({ version: 1, entries: [{ id: 'good2' }] }) + '\n');
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(parsed, { version: 1, entries: [{ id: 'good2' }] });

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- condition 5: killing the writer process mid-write must never corrupt the existing target ---

test('condition 5: SIGKILLing the writer before it renames leaves the existing target file untouched and valid', async () => {
  const dir = freshTmpDir();
  const targetPath = path.join(dir, 'kill-target.json');
  const original = { version: 1, entries: [{ id: 'orig-untouched' }] };
  fs.writeFileSync(targetPath, JSON.stringify(original), 'utf8');

  const childPath = path.join(__dirname, 'fixtures', 'killMidWrite.child.mjs');
  const child = spawn(process.execPath, [childPath, targetPath], { stdio: 'ignore' });

  // Give the child enough time to open+write+fsync+close the temp file and
  // reach its Atomics.wait() sleep (well before its own 5s timeout), i.e.
  // reliably BEFORE it calls renameSync — this is the exact window the
  // spec's condition 5 asks us to kill inside of.
  await new Promise((resolve) => setTimeout(resolve, 400));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));

  const raw = fs.readFileSync(targetPath, 'utf8');
  const parsed = JSON.parse(raw); // must not throw — the file must still be valid JSON
  assert.deepEqual(parsed, original, '킬된 프로세스가 아직 rename하지 않았다면 기존 target은 그대로여야 합니다.');

  const tmpPath = path.join(dir, '.killtest.tmp');
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); // leftover partial temp file is expected and harmless
  fs.rmSync(dir, { recursive: true, force: true });
});
