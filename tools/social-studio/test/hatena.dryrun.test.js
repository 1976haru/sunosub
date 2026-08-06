import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runHatenaPublish,
  checkChannel,
  checkLanguage,
  checkTime,
  checkDuplicate,
  computeDefaultScheduledTime,
  loadHatenaConfig,
  PreflightError,
} from '../publish/hatena.js';
import { postEntry, HatenaHttpError } from '../publish/hatenaClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'out');

function makeSet(setName, { channelId = 'jp-2030', hatena = null, songs = [] } = {}) {
  const dir = path.join(OUT_ROOT, setName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'textpack.json'), JSON.stringify({
    setName,
    channelId,
    hatena: hatena === null ? { title: '今日の音楽プレイリスト', body: '<p>今日は18曲をお届けします。心が落ち着く音楽です。</p>', category: '音楽', warnings: [] } : hatena,
  }));
  fs.writeFileSync(path.join(dir, 'normalized.json'), JSON.stringify({ songs }));
  return dir;
}

function cleanup(setName) {
  fs.rmSync(path.join(OUT_ROOT, setName), { recursive: true, force: true });
}

// --- completion condition 1: dry-run default, zero network calls ---

test('condition 1: no --publish flag means dry-run, and it makes zero network calls', async () => {
  const setName = 'test-s5-dryrun-network';
  makeSet(setName);
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('network call attempted during dry-run — forbidden'); };
  try {
    const result = await runHatenaPublish(setName, {}); // publish option omitted -> dry-run
    assert.equal(result.mode, 'dryrun');
  } finally {
    global.fetch = originalFetch;
    cleanup(setName);
  }
});

// --- completion condition 5: non-Japanese channel rejected ---

test('condition 5: a Korean channelId is rejected before anything else runs', () => {
  assert.throws(() => checkChannel('good-morning-memory-radio'), PreflightError);
  assert.throws(() => checkChannel('kr-anything'), PreflightError);
});

test('condition 5 (integration): runHatenaPublish rejects a non-jp textpack with the actual error message', async () => {
  const setName = 'test-s5-korean-channel';
  makeSet(setName, { channelId: 'good-morning-memory-radio' });
  try {
    await assert.rejects(() => runHatenaPublish(setName, {}), (err) => {
      console.log('[condition 5 message]', err.message);
      assert.ok(err instanceof PreflightError);
      assert.match(err.message, /일본 채널/);
      return true;
    });
  } finally {
    cleanup(setName);
  }
});

// --- completion condition 6: uncovered English in the Japanese body ---

test('condition 6: an English word in the body with no matching song title is rejected', () => {
  const allowed = new Set(['slowmorning']);
  assert.throws(() => checkLanguage('<p>これはSPECIALtestです</p>', allowed), (err) => {
    console.log('[condition 6 message]', err.message);
    assert.ok(err instanceof PreflightError);
    return true;
  });
});

test('condition 6: a song\'s own original title word is allowed, not flagged', () => {
  const allowed = new Set(['slow', 'morning']);
  assert.doesNotThrow(() => checkLanguage('<p>今日はSlow Morningを聴きましょう</p>', allowed));
});

test('condition 6: a URL is allowed, not flagged', () => {
  assert.doesNotThrow(() => checkLanguage('<p>詳しくはhttps://example.com/pageをご覧ください</p>', new Set()));
});

test('regression: HTML tag names in the body are not mistaken for English leaks', () => {
  // Found while smoke-testing the dry-run path directly — hatena.body is
  // HTML (parity with naver.bodyHtml), and an early version of this check
  // flagged "p" from <p> tags as an uncovered English word.
  assert.doesNotThrow(() => checkLanguage('<p>今日の音楽です。</p><ul><li>曲1</li></ul>', new Set()));
});

// --- completion condition 4 (integration): past-time rejection ---

test('condition 4: an updated time set in the past is rejected by checkTime', () => {
  const config = loadHatenaConfig();
  const now = new Date('2026-08-05T00:00:00Z');
  const pastIso = '2026-08-04T09:00:00+09:00';
  assert.throws(() => checkTime(pastIso, config.schedule, now), (err) => {
    console.log('[condition 4 message]', err.message);
    assert.ok(err instanceof PreflightError);
    return true;
  });
});

test('computeDefaultScheduledTime always lands at least minOffsetDays ahead regardless of current time-of-day', () => {
  const config = loadHatenaConfig();
  // Regression: an earlier version truncated to hourJst on the naive
  // (now + minOffsetDays) calendar date, which could land LESS than
  // minOffsetDays away depending on what time `now` currently was — caught
  // by actually running the dry-run against the real clock, not just
  // reading the code.
  for (const hour of [0, 6, 8, 9, 10, 13, 23]) {
    const now = new Date(Date.UTC(2026, 7, 5, hour, 30, 0));
    const scheduled = computeDefaultScheduledTime(config.schedule, now);
    const diffDays = (new Date(scheduled).getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(diffDays >= config.schedule.minOffsetDays, `hour=${hour} UTC: only ${diffDays.toFixed(2)} days ahead, need >= ${config.schedule.minOffsetDays}`);
  }
});

test('checkTime rejects a time beyond maxOffsetDays', () => {
  const config = loadHatenaConfig();
  const now = new Date('2026-08-05T00:00:00Z');
  const tooFar = '2026-09-30T09:00:00+09:00';
  assert.throws(() => checkTime(tooFar, config.schedule, now), PreflightError);
});

// --- completion condition 7: missing .env with --publish ---

test('condition 7: --publish with no credentials in the environment throws an explicit error, sends nothing', async () => {
  const setName = 'test-s5-missing-env';
  makeSet(setName);
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = () => { fetchCalled = true; throw new Error('should never be called'); };
  const savedEnv = { HATENA_ID: process.env.HATENA_ID, HATENA_API_KEY: process.env.HATENA_API_KEY, HATENA_BLOG_ID: process.env.HATENA_BLOG_ID };
  delete process.env.HATENA_ID;
  delete process.env.HATENA_API_KEY;
  delete process.env.HATENA_BLOG_ID;
  try {
    await assert.rejects(() => runHatenaPublish(setName, { publish: true }), (err) => {
      console.log('[condition 7 message]', err.message);
      assert.ok(err instanceof PreflightError);
      assert.match(err.message, /\.env/);
      return true;
    });
    assert.equal(fetchCalled, false, 'no network request should have been attempted');
  } finally {
    global.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
    cleanup(setName);
  }
});

// --- completion condition 12: duplicate publish rejected ---

test('condition 12: a second publish attempt for the same setName is rejected once a prior publish record exists', () => {
  const setName = 'test-s5-duplicate';
  const dir = makeSet(setName);
  fs.writeFileSync(path.join(dir, 'hatena-result.json'), JSON.stringify({ mode: 'publish', status: 'scheduled' }));
  try {
    assert.throws(() => checkDuplicate(setName), PreflightError);
  } finally {
    cleanup(setName);
  }
});

test('a prior DRY-RUN record does not block a real publish attempt', () => {
  const setName = 'test-s5-dryrun-not-blocking';
  const dir = makeSet(setName);
  fs.writeFileSync(path.join(dir, 'hatena-result.json'), JSON.stringify({ mode: 'dryrun' }));
  try {
    assert.doesNotThrow(() => checkDuplicate(setName));
  } finally {
    cleanup(setName);
  }
});

// --- completion condition 8: API key never appears in any output ---

test('condition 8: the API key never appears in the dry-run result, even with real-looking env vars set', async () => {
  const setName = 'test-s5-key-leak-check';
  makeSet(setName);
  const savedEnv = { ...process.env };
  process.env.HATENA_ID = 'realuser';
  process.env.HATENA_API_KEY = 'THIS-MUST-NEVER-APPEAR-ANYWHERE-abc123XYZ';
  process.env.HATENA_BLOG_ID = 'real.hatenablog.jp';
  try {
    const result = await runHatenaPublish(setName, {});
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('THIS-MUST-NEVER-APPEAR-ANYWHERE-abc123XYZ'), 'API key leaked into the dry-run result');
    assert.ok(!serialized.includes(process.env.HATENA_API_KEY));
  } finally {
    process.env = savedEnv;
    cleanup(setName);
  }
});

// --- completion condition 11: 4xx no retry, 5xx/429 retry bounded ---

test('condition 11: a 4xx response is not retried', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return { status: 400, text: async () => '<error>bad request</error>' };
  };
  await assert.rejects(
    () => postEntry({ endpoint: 'https://example.test/entry', xml: '<entry/>', wsseHeader: 'x', retryConfig: { maxAttempts: 3, backoffMs: [1, 1, 1] }, fetchImpl: fakeFetch }),
    HatenaHttpError
  );
  assert.equal(callCount, 1, '4xx must not be retried');
});

test('condition 11: a 500 response is retried up to maxAttempts, then fails', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return { status: 500, text: async () => '<error>server error</error>' };
  };
  await assert.rejects(
    () => postEntry({ endpoint: 'https://example.test/entry', xml: '<entry/>', wsseHeader: 'x', retryConfig: { maxAttempts: 3, backoffMs: [1, 1, 1] }, fetchImpl: fakeFetch }),
    HatenaHttpError
  );
  assert.equal(callCount, 3, 'should retry exactly up to maxAttempts');
});

test('condition 11: a 429 response is retried the same way as 5xx', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return { status: 429, text: async () => 'rate limited' };
  };
  await assert.rejects(() => postEntry({ endpoint: 'https://example.test/entry', xml: '<entry/>', wsseHeader: 'x', retryConfig: { maxAttempts: 2, backoffMs: [1, 1] }, fetchImpl: fakeFetch }), HatenaHttpError);
  assert.equal(callCount, 2);
});

test('a successful response after one retry returns the entry URL', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    if (callCount === 1) return { status: 503, text: async () => 'temporarily unavailable' };
    return { status: 201, text: async () => '<entry><link rel="alternate" href="https://example.hatenablog.jp/entry/1"/></entry>' };
  };
  const result = await postEntry({ endpoint: 'https://example.test/entry', xml: '<entry/>', wsseHeader: 'x', retryConfig: { maxAttempts: 3, backoffMs: [1, 1, 1] }, fetchImpl: fakeFetch });
  assert.equal(result.entryUrl, 'https://example.hatenablog.jp/entry/1');
  assert.equal(result.attempts, 2);
});

// --- completion condition 13: loop bound sanity (retry never exceeds the hard ceiling) ---

test('condition 13: a maxAttempts far beyond the hard ceiling is still capped', async () => {
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    return { status: 500, text: async () => 'error' };
  };
  await assert.rejects(() => postEntry({ endpoint: 'https://example.test/entry', xml: '<entry/>', wsseHeader: 'x', retryConfig: { maxAttempts: 100000, backoffMs: [1] }, fetchImpl: fakeFetch }));
  assert.ok(callCount <= 20, `expected the hard ceiling to cap retries, got ${callCount} calls`);
});

// --- .gitignore check (completion condition #9) ---

test('condition 9: the repo\'s .gitignore includes .env', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '..', '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
});
