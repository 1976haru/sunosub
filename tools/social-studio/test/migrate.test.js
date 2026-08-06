import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLintHistory, transformEntry } from '../store/migrate.js';
import * as history from '../store/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINT_HISTORY_PATH = path.join(__dirname, '..', 'store', 'lintHistory.json');
const DATA_DIR = history.paths.DATA_DIR;
const BACKUP_DIR = `${DATA_DIR}.testbackup`;

/** Both store/lintHistory.json (source) and store/data/history.json (destination) are fixed real paths — back up and restore both around every test. */
function withClean(fn) {
  return () => {
    const lintBackupExists = fs.existsSync(LINT_HISTORY_PATH);
    const lintBackup = lintBackupExists ? fs.readFileSync(LINT_HISTORY_PATH, 'utf8') : null;
    const dataExisted = fs.existsSync(DATA_DIR);
    if (dataExisted) fs.renameSync(DATA_DIR, BACKUP_DIR);
    try {
      fn();
    } finally {
      if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
      if (dataExisted) fs.renameSync(BACKUP_DIR, DATA_DIR);
      if (lintBackup !== null) fs.writeFileSync(LINT_HISTORY_PATH, lintBackup, 'utf8');
      else if (fs.existsSync(LINT_HISTORY_PATH)) fs.unlinkSync(LINT_HISTORY_PATH);
    }
  };
}

test('transformEntry splits one S3 (per-set) entry into per-platform S6 entries, always status "generated"', () => {
  const s3Entry = {
    setName: 'set-A',
    channelId: 'ch1',
    checkedAt: '2026-08-01T00:00:00.000Z',
    platforms: ['youtube', 'instagram'],
    templateIds: { 'youtube.title': 'yt-1', 'instagram.caption': 'ig-1' },
    hashtags: { youtube: ['#a'], instagram: ['#b', '#c'] },
    fingerprints: { 'youtube.description': 'fp1', 'instagram.caption': 'fp2' },
  };
  const out = transformEntry(s3Entry);
  assert.equal(out.length, 2);

  const yt = out.find((e) => e.platform === 'youtube');
  const ig = out.find((e) => e.platform === 'instagram');
  assert.equal(yt.status, 'generated');
  assert.equal(yt.publishedAt, null);
  assert.equal(yt.generatedAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(yt.templateIds, ['yt-1']);
  assert.deepEqual(yt.hashtags, ['#a']);
  assert.equal(yt.fingerprint, 'fp1');

  assert.equal(ig.status, 'generated');
  assert.deepEqual(ig.templateIds, ['ig-1']);
  assert.deepEqual(ig.hashtags, ['#b', '#c']);
  assert.equal(ig.fingerprint, 'fp2');
});

test('transformEntry omits the fingerprint field entirely when there is nothing to fingerprint for that platform', () => {
  const out = transformEntry({ setName: 'set-B', channelId: 'ch1', checkedAt: '2026-08-01T00:00:00.000Z', platforms: ['x'], templateIds: {}, hashtags: {}, fingerprints: {} });
  assert.equal(out.length, 1);
  assert.equal('fingerprint' in out[0], false);
});

test(
  'migrateLintHistory reports { available: false } when lintHistory.json does not exist',
  withClean(() => {
    if (fs.existsSync(LINT_HISTORY_PATH)) fs.unlinkSync(LINT_HISTORY_PATH);
    const result = migrateLintHistory();
    assert.equal(result.available, false);
    assert.equal(result.migrated, 0);
    assert.deepEqual(result.entries, []);
  })
);

test(
  'migrateLintHistory({ dryRun: true }) computes the transform without writing to history.js',
  withClean(() => {
    fs.mkdirSync(path.dirname(LINT_HISTORY_PATH), { recursive: true });
    fs.writeFileSync(
      LINT_HISTORY_PATH,
      JSON.stringify({
        version: 1,
        entries: [{ setName: 'set-C', channelId: 'ch1', checkedAt: '2026-08-01T00:00:00.000Z', platforms: ['youtube'], templateIds: {}, hashtags: {}, fingerprints: {} }],
      })
    );
    const result = migrateLintHistory({ dryRun: true });
    assert.equal(result.available, true);
    assert.equal(result.migrated, 1);
    assert.equal(fs.existsSync(history.paths.HISTORY_PATH), false, 'dryRun은 history.json을 절대 쓰면 안 됩니다.');
  })
);

test(
  'condition 7: running migrateLintHistory twice produces no duplicate entries',
  withClean(() => {
    fs.mkdirSync(path.dirname(LINT_HISTORY_PATH), { recursive: true });
    fs.writeFileSync(
      LINT_HISTORY_PATH,
      JSON.stringify({
        version: 1,
        entries: [
          { setName: 'set-D', channelId: 'ch1', checkedAt: '2026-08-01T00:00:00.000Z', platforms: ['youtube', 'instagram'], templateIds: {}, hashtags: {}, fingerprints: {} },
          { setName: 'set-E', channelId: 'ch1', checkedAt: '2026-08-02T00:00:00.000Z', platforms: ['x'], templateIds: {}, hashtags: {}, fingerprints: {} },
        ],
      })
    );

    const first = migrateLintHistory();
    const afterFirst = JSON.parse(fs.readFileSync(history.paths.HISTORY_PATH, 'utf8'));
    assert.equal(afterFirst.entries.length, 3); // set-D x2 platforms + set-E x1

    const second = migrateLintHistory();
    const afterSecond = JSON.parse(fs.readFileSync(history.paths.HISTORY_PATH, 'utf8'));
    assert.equal(afterSecond.entries.length, 3, '두 번째 실행 후에도 항목 수가 그대로여야 합니다 (중복 없음).');
    assert.equal(first.migrated, 3);
    assert.equal(second.migrated, 3);
    assert.deepEqual(
      afterFirst.entries.map((e) => e.id).sort(),
      afterSecond.entries.map((e) => e.id).sort()
    );
  })
);

test(
  'a migrated entry never overrides an already-published status from a later record()',
  withClean(() => {
    fs.mkdirSync(path.dirname(LINT_HISTORY_PATH), { recursive: true });
    fs.writeFileSync(
      LINT_HISTORY_PATH,
      JSON.stringify({
        version: 1,
        entries: [{ setName: 'set-F', channelId: 'ch1', checkedAt: '2026-08-01T00:00:00.000Z', platforms: ['youtube'], templateIds: {}, hashtags: {}, fingerprints: {} }],
      })
    );
    migrateLintHistory();
    history.setStatus('set-F#youtube', 'published');
    migrateLintHistory(); // re-running migration must not silently revert the publish
    const data = JSON.parse(fs.readFileSync(history.paths.HISTORY_PATH, 'utf8'));
    assert.equal(data.entries.find((e) => e.id === 'set-F#youtube').status, 'published');
  })
);
