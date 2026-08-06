import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as history from '../store/history.js';
import { selectTemplate } from '../generate/slotFiller.js';
import { runSetPackPipeline } from '../parse/setPackLoader.js';
import { generateTextPack } from '../generate/textPack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = history.paths.DATA_DIR;
const BACKUP_DIR = `${DATA_DIR}.testbackup`;
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-setpack.json');

/**
 * store/data/history.json lives at a fixed path (not injectable), same as
 * store/lintHistory.json in test/socialLint.test.js — so every test here
 * moves any real data aside, runs against a clean store/data/, then
 * restores it. Serial-only (this repo runs tests with
 * --test-concurrency=1) so this is safe.
 */
function withCleanHistory(fn) {
  return () => {
    const existed = fs.existsSync(DATA_DIR);
    if (existed) fs.renameSync(DATA_DIR, BACKUP_DIR);
    try {
      fn();
    } finally {
      if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
      if (existed) fs.renameSync(BACKUP_DIR, DATA_DIR);
    }
  };
}

const TEMPLATES = [
  { id: 't1', text: '{a} 하나' },
  { id: 't2', text: '{a} 둘' },
  { id: 't3', text: '{a} 셋' },
];
const SLOTS = { a: 'X' };

// --- condition 1: missing history.json -> byte-identical to no historyContext at all ---

test(
  'condition 1: with no history.json, selectTemplate(historyContext) is byte-identical to selectTemplate() without one',
  withCleanHistory(() => {
    assert.equal(fs.existsSync(history.paths.HISTORY_PATH), false);
    const baseline = selectTemplate(TEMPLATES, SLOTS, 'setZ1', 'saltZ1');
    const withCtx = selectTemplate(TEMPLATES, SLOTS, 'setZ1', 'saltZ1', null, { channelId: 'chZ', platform: 'youtube' });
    assert.deepEqual(withCtx, baseline);
  })
);

test(
  'loadHistory() on a missing file returns an empty history without throwing',
  withCleanHistory(() => {
    assert.deepEqual(history.loadHistory(), { version: 1, entries: [] });
  })
);

test(
  'condition 1 (full pipeline): generateTextPack() output is byte-identical whether history.json is missing or populated with unrelated data — S1 never calls slotFiller with a historyContext today',
  withCleanHistory(() => {
    const normalized = runSetPackPipeline(FIXTURE_PATH).normalized;
    const options = { youtubeUrl: 'https://youtu.be/abcDEF12345' };

    assert.equal(fs.existsSync(history.paths.HISTORY_PATH), false);
    const before = generateTextPack(normalized, options);
    const beforeHash = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex');

    // Populate history.json with real, non-empty, published data for this
    // exact channel so a regression (S1 accidentally starting to consult
    // history) would have something to actually change output against.
    history.record({
      setName: 'unrelated-set',
      channelId: normalized.set.channelId,
      platform: 'youtube',
      generatedAt: new Date().toISOString(),
      templateIds: ['some-template-id'],
    });
    history.setStatus('unrelated-set#youtube', 'published');
    assert.equal(fs.existsSync(history.paths.HISTORY_PATH), true);

    const after = generateTextPack(normalized, options);
    const afterHash = crypto.createHash('sha256').update(JSON.stringify(after)).digest('hex');

    assert.equal(afterHash, beforeHash, 'history.json이 생기기 전/후로 S1 출력이 완전히 동일해야 합니다.');
    assert.deepEqual(after, before);
  })
);

// --- condition 2: template selection differs once a PUBLISHED record exists ---

test(
  'condition 2: template selection differs between "published record exists" and "no history"',
  withCleanHistory(() => {
    const historyContext = { channelId: 'chZ', platform: 'youtube' };
    const noHistory = selectTemplate(TEMPLATES, SLOTS, 'setZ2', 'saltZ2', null, historyContext);

    history.record({
      setName: 'someOtherSet',
      channelId: 'chZ',
      platform: 'youtube',
      generatedAt: new Date().toISOString(),
      templateIds: [noHistory.id],
    });
    history.setStatus('someOtherSet#youtube', 'published');

    const withPublished = selectTemplate(TEMPLATES, SLOTS, 'setZ2', 'saltZ2', null, historyContext);
    assert.notEqual(withPublished.id, noHistory.id, '이미 발행된 템플릿은 회전에서 제외되어야 합니다.');
  })
);

// --- condition 3: "generated" alone must never exhaust a template ---

test(
  'condition 3: a "generated"-only record (never published) must never exhaust a template',
  withCleanHistory(() => {
    history.record({
      setName: 'setGeneratedOnly',
      channelId: 'chZ',
      platform: 'youtube',
      generatedAt: new Date().toISOString(),
      templateIds: ['t1', 't2', 't3'],
    });
    // status는 기본값 'generated'로 남겨둔다 — setStatus()를 호출하지 않음
    assert.deepEqual(history.getUsedTemplateIds('chZ', 'youtube', 4), []);

    const historyContext = { channelId: 'chZ', platform: 'youtube' };
    const withCtx = selectTemplate(TEMPLATES, SLOTS, 'setZ3', 'saltZ3', null, historyContext);
    const baseline = selectTemplate(TEMPLATES, SLOTS, 'setZ3', 'saltZ3');
    assert.deepEqual(withCtx, baseline, 'generated 상태만으로는 회전 순서가 바뀌면 안 됩니다.');
  })
);

// --- condition 4: an exhausted pool must never block generation, only warn ---

test(
  'condition 4: exhausting every template still lets selectTemplate succeed, with a warning',
  withCleanHistory(() => {
    const twoTemplates = [
      { id: 't1', text: '{a} 하나' },
      { id: 't2', text: '{a} 둘' },
    ];
    const historyContext = { channelId: 'chZ', platform: 'instagram' };
    history.record({
      setName: 'setExhaust',
      channelId: 'chZ',
      platform: 'instagram',
      generatedAt: new Date().toISOString(),
      templateIds: ['t1', 't2'],
    });
    history.setStatus('setExhaust#instagram', 'published');

    const result = selectTemplate(twoTemplates, SLOTS, 'setNewAfterExhaust', 'saltNew', null, historyContext);
    assert.ok(['t1', 't2'].includes(result.id), '풀이 소진되어도 생성 자체는 반드시 성공해야 합니다.');
    assert.ok(result.warning, '소진 시 경고가 함께 반환되어야 합니다.');
  })
);

// --- condition 6: a corrupted history.json is preserved, never silently overwritten ---

test(
  'condition 6: a corrupted history.json is backed up and loadHistory throws with the backup path in the message',
  withCleanHistory(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const corruptText = '{ this is not valid json,,, ';
    fs.writeFileSync(history.paths.HISTORY_PATH, corruptText, 'utf8');

    assert.throws(
      () => history.loadHistory(),
      (err) => {
        assert.ok(err instanceof history.HistoryCorruptError);
        assert.match(err.message, /history\.corrupt\.\d+\.json/);
        return true;
      }
    );

    const backups = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('history.corrupt.'));
    assert.equal(backups.length, 1, '손상된 파일이 정확히 한 번 백업되어야 합니다.');
    const backupContent = fs.readFileSync(path.join(DATA_DIR, backups[0]), 'utf8');
    assert.equal(backupContent, corruptText, '원본 바이트가 그대로 보존되어야 합니다 (빈 값으로 덮어쓰면 안 됨).');
  })
);

// --- condition 8: retention cap must never delete last-8-weeks entries ---

test('pruneEntries evicts oldest-first once over cap, but never touches entries from the last 8 weeks', () => {
  const now = new Date('2026-08-06T00:00:00.000Z');
  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
  const entries = [
    { id: 'old-1', generatedAt: daysAgo(120) }, // ~17주 전 -> 오래됨
    { id: 'old-2', generatedAt: daysAgo(100) },
    { id: 'recent-1', generatedAt: daysAgo(10) },
    { id: 'recent-2', generatedAt: daysAgo(5) },
  ];
  const { entries: pruned, warning } = history.pruneEntries(entries, 3, now);
  assert.equal(warning, null);
  assert.equal(pruned.length, 3);
  assert.ok(pruned.some((e) => e.id === 'recent-1'));
  assert.ok(pruned.some((e) => e.id === 'recent-2'));
  assert.ok(pruned.some((e) => e.id === 'old-2'), '오래된 것 중 더 최근인 것은 남아야 합니다.');
  assert.ok(!pruned.some((e) => e.id === 'old-1'), '가장 오래된 항목이 제거되어야 합니다.');
});

test(
  'condition 8: retention cap lower than the last-8-weeks recent count deletes nothing, only warns',
  withCleanHistory(() => {
    const now = new Date('2026-08-06T00:00:00.000Z');
    let lastWarning;
    for (let i = 0; i < 15; i += 1) {
      const generatedAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString(); // 최근 15일 -> 8주 보호창 안
      const result = history.record(
        { setName: `set-${i}`, channelId: 'chCap', platform: 'instagram', generatedAt },
        { maxEntries: 10, now }
      );
      lastWarning = result.warning;
    }
    const data = JSON.parse(fs.readFileSync(history.paths.HISTORY_PATH, 'utf8'));
    assert.equal(data.entries.length, 15, '최근 8주 이내 기록 15건은 상한 10건을 넘더라도 전부 남아야 합니다.');
    assert.ok(lastWarning, '삭제하지 않는 대신 경고를 반환해야 합니다.');
    assert.match(lastWarning, /15건/);
  })
);

// --- condition 9: S2 완료 체크 -> published / 해제 -> generated (unit-level; full route smoke-tested separately) ---

test(
  'condition 9: setStatus flips generated <-> published and stamps publishedAt once',
  withCleanHistory(() => {
    const { id } = history.record({ setName: 'setCheck', channelId: 'chZ', platform: 'youtube', generatedAt: new Date().toISOString() });
    assert.equal(id, 'setCheck#youtube');

    const published = history.setStatus(id, 'published');
    assert.equal(published.status, 'published');
    assert.ok(published.publishedAt);

    const reverted = history.setStatus(id, 'generated');
    assert.equal(reverted.status, 'generated');
  })
);

test(
  'setStatus on an unknown id throws HistoryNotFoundError',
  withCleanHistory(() => {
    assert.throws(() => history.setStatus('no-such-id#youtube', 'published'), history.HistoryNotFoundError);
  })
);

// --- record() upsert idempotency ---

test(
  'record() upserts by id — calling it twice for the same setName+platform never duplicates the entry',
  withCleanHistory(() => {
    history.record({ setName: 'setUpsert', channelId: 'chZ', platform: 'x', generatedAt: new Date().toISOString(), templateIds: ['t1'] });
    history.record({ setName: 'setUpsert', channelId: 'chZ', platform: 'x', generatedAt: new Date().toISOString(), templateIds: ['t1', 't2'] });
    const data = JSON.parse(fs.readFileSync(history.paths.HISTORY_PATH, 'utf8'));
    assert.equal(data.entries.length, 1);
    assert.deepEqual(data.entries[0].templateIds, ['t1', 't2']);
  })
);

test(
  'record() never downgrades an already-published entry back to generated on a plain re-record',
  withCleanHistory(() => {
    const { id } = history.record({ setName: 'setPreserve', channelId: 'chZ', platform: 'x', generatedAt: new Date().toISOString() });
    history.setStatus(id, 'published');
    history.record({ setName: 'setPreserve', channelId: 'chZ', platform: 'x', generatedAt: new Date().toISOString(), templateIds: ['t9'] });
    const data = JSON.parse(fs.readFileSync(history.paths.HISTORY_PATH, 'utf8'));
    assert.equal(data.entries[0].status, 'published', '재생성이 이미 발행된 상태를 조용히 되돌리면 안 됩니다.');
  })
);

// --- query API: missing/empty data must return [], never throw ---

test(
  'query functions return [] for an unknown channel/platform rather than throwing',
  withCleanHistory(() => {
    assert.deepEqual(history.getPublished('no-such-channel', 'youtube'), []);
    assert.deepEqual(history.getUsedTemplateIds('no-such-channel', 'youtube'), []);
    assert.deepEqual(history.getRecentHashtags('no-such-channel', 'youtube'), []);
    assert.deepEqual(history.getFingerprints(), []);
    assert.deepEqual(history.getPostingTimes('no-such-channel', 'youtube'), []);
  })
);

test(
  'getRecentHashtags excludes discarded entries but includes generated and published ones',
  withCleanHistory(() => {
    const now = new Date().toISOString();
    history.record({ setName: 'setHash1', channelId: 'chH', platform: 'instagram', generatedAt: now, hashtags: ['#a'] });
    history.record({ setName: 'setHash2', channelId: 'chH', platform: 'instagram', generatedAt: now, hashtags: ['#b'] });
    history.setStatus('setHash2#instagram', 'published');
    history.record({ setName: 'setHash3', channelId: 'chH', platform: 'instagram', generatedAt: now, hashtags: ['#c'] });
    history.setStatus('setHash3#instagram', 'discarded');

    const tags = history.getRecentHashtags('chH', 'instagram', 4).sort();
    assert.deepEqual(tags, ['#a', '#b']);
  })
);

// --- condition 12: zero external network calls ---

test('condition 12: a full record/query cycle makes zero network calls', () => {
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error('network call attempted during store/history.js — forbidden by spec section 8');
  };
  try {
    assert.doesNotThrow(
      withCleanHistory(() => {
        history.record({ setName: 'setNet', channelId: 'chNet', platform: 'youtube', generatedAt: new Date().toISOString(), templateIds: ['t1'] });
        history.setStatus('setNet#youtube', 'published');
        history.getUsedTemplateIds('chNet', 'youtube');
        history.getRecentHashtags('chNet', 'youtube');
        history.getFingerprints();
        history.getPostingTimes('chNet', 'youtube');
      })
    );
  } finally {
    global.fetch = originalFetch;
  }
});
