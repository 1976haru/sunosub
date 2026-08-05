import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crossChannel from '../lint/rules/crossChannel.js';
import * as templateReuse from '../lint/rules/templateReuse.js';
import * as hashtagOverlap from '../lint/rules/hashtagOverlap.js';
import * as platformRules from '../lint/rules/platformRules.js';
import * as bannedPhrasesRule from '../lint/rules/bannedPhrases.js';
import * as postingCadence from '../lint/rules/postingCadence.js';
import * as wordRepetition from '../lint/rules/wordRepetition.js';
import { loadThresholds, runSocialLint, runSocialLintAndSave, runLintWithRegeneration } from '../lint/socialLint.js';
import { appendEntry, loadHistory } from '../store/lintHistory.js';
import { runSetPackPipeline } from '../parse/setPackLoader.js';
import { runTextPackPipeline } from '../generate/textPack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-setpack.json');
const THRESHOLDS_PATH = path.join(ROOT, 'data', 'lintThresholds.json');
const BANNED_PATH = path.join(ROOT, 'data', 'bannedPhrases.json');
const LIMITS_PATH = path.join(ROOT, 'data', 'platformLimits.json');
const HISTORY_PATH = path.join(ROOT, 'store', 'lintHistory.json');
const OUT_ROOT = path.join(ROOT, 'out');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

// ---------------------------------------------------------------------------
// A minimal, rule-clean baseline textpack — every per-rule fixture starts
// from this and changes only what's needed to trip its own rule, so
// completion condition #2 (each fixture trips exactly one rule) is
// checkable by construction.
// ---------------------------------------------------------------------------

function baselineTextpack(overrides = {}) {
  return {
    setName: '20260804_기준세트_A',
    channelId: 'good-morning-memory-radio',
    channelLabel: '굿모닝 추억라디오',
    conceptLabel: '70년대 감성',
    youtube: {
      titles: ['평범한 첫 제목입니다', '평범한 둘째 제목입니다', '평범한 셋째 제목입니다'],
      description: '오늘의 플레이리스트를 소개합니다. 편안한 시간 보내세요.',
      hashtags: ['#태그1', '#태그2', '#태그3'],
      tags: ['태그1', '태그2', '태그3'],
      pinnedComment: '댓글로 의견을 남겨주세요.',
    },
    shorts: [{ trackNo: 1, title: 'Song One', titleKo: '노래하나', description: 'desc', descriptionKo: '짧은 곡 설명입니다', tagsEn: [], hashtags: ['#태그1'] }],
    instagram: { caption: '오늘의 사진을 공유합니다.', hashtags: ['#태그1', '#태그2'], firstComment: '#태그1 #태그2' },
    x: { main: '오늘의 소식을 전합니다.', thread: [], lyricQuote: null },
    facebook: { body: '페이스북에 오늘의 이야기를 남깁니다.' },
    naver: { title: '네이버 제목입니다', bodyHtml: '<p>본문입니다</p>', tags: ['태그1'] },
    hatena: { title: null, body: null, category: null, warnings: [] },
    warnings: [],
    errors: [],
    ...overrides,
  };
}

/** Runs all 7 rules the same way lint/socialLint.js does, but with injectable context — this is what makes each fixture test self-contained (no disk state needed). */
function runAllRules(textpack, ctxOverrides = {}) {
  const thresholds = ctxOverrides.thresholds || loadJson(THRESHOLDS_PATH);
  const platformLimits = ctxOverrides.platformLimits || loadJson(LIMITS_PATH);
  const bannedConfig = loadJson(BANNED_PATH);
  const phrases = [...(bannedConfig._shared || []), ...(bannedConfig[textpack.channelId] || [])];
  const currentDate = ctxOverrides.currentDate || new Date('2026-08-04T00:00:00Z');
  const candidates = ctxOverrides.candidates || [];
  const recentEntries = ctxOverrides.recentEntries || [];
  const poolSizes = ctxOverrides.poolSizes || {};

  const results = [
    crossChannel.check(textpack, { threshold: thresholds.R1_crossChannelSimilarity, candidates }),
    templateReuse.check(textpack, { weeks: thresholds.R2_templateReuseWeeks, recentEntries, poolSizes }),
    hashtagOverlap.check(textpack, { threshold: thresholds.R3_hashtagOverlapRatio, weeks: thresholds.R2_templateReuseWeeks, recentEntries }),
    platformRules.check(textpack, { platformLimits }),
    bannedPhrasesRule.check(textpack, { phrases }),
    postingCadence.check(textpack, { maxPostsPer24h: thresholds.R6_maxPostsPer24h, currentDate, recentEntries }),
    wordRepetition.check(textpack, { maxNounRepeat: thresholds.R7_maxNounRepeat }),
  ];
  return results.flatMap((r) => r.violations);
}

function onlyRule(violations, rulePrefix) {
  return violations.length > 0 && violations.every((v) => v.rule === rulePrefix);
}

// --- baseline sanity: the clean fixture should trip nothing ---

test('the baseline fixture alone trips no rule', () => {
  const violations = runAllRules(baselineTextpack());
  assert.deepEqual(violations, []);
});

// --- completion condition 2 + 3: one isolated fixture per rule ---

test('R1 fixture: near-identical caption in another same-week channel is caught ONLY by R1, as error', () => {
  const current = baselineTextpack({
    instagram: { caption: '늦여름의 시작 저녁에 어울리는 차분한 편안함 노래 18곡. 프로필 링크에서 전곡을 들어보세요.', hashtags: [], firstComment: '' },
  });
  const candidateTextpack = { channelId: 'kr-other-channel', instagram: { caption: '늦여름의 시작 저녁에 어울리는 잔잔한 편안함 노래 18곡. 프로필 링크에서 전곡을 들어보세요.' } };
  const violations = runAllRules(current, { candidates: [{ setName: '20260805_다른채널_B', channelId: 'kr-other-channel', textpack: candidateTextpack }] });

  assert.ok(onlyRule(violations, 'R1-crossChannel'), `expected only R1 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  const hit = violations.find((v) => v.path === 'instagram.caption');
  assert.ok(hit, 'expected a violation on instagram.caption');
  assert.equal(hit.severity, 'error');
  console.log('[R1 fixture message]', hit.message);
});

test('R2 fixture: reusing a templateId within the lookback window is caught ONLY by R2, as error', () => {
  const current = baselineTextpack({ templateIds: { 'instagram.caption': 'ig-005' } });
  const recentEntries = [{ channelId: current.channelId, checkedAt: '2026-07-30T00:00:00Z', templateIds: { 'instagram.caption': 'ig-005' } }];
  const violations = runAllRules(current, { recentEntries, poolSizes: { instagram: 20 } });

  assert.ok(onlyRule(violations, 'R2-templateReuse'), `expected only R2 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  console.log('[R2 fixture message]', violations[0].message);
  assert.equal(violations[0].severity, 'error');
});

test('R3 fixture: near-total hashtag overlap with recent weeks is caught ONLY by R3, as warn', () => {
  const current = baselineTextpack({ instagram: { caption: '오늘의 사진을 공유합니다.', hashtags: ['#a', '#b', '#c', '#d', '#e'], firstComment: '' } });
  const recentEntries = [{ channelId: current.channelId, checkedAt: '2026-07-30T00:00:00Z', hashtags: { instagram: ['#a', '#b', '#c', '#d', '#e'] } }];
  const violations = runAllRules(current, { recentEntries });

  assert.ok(onlyRule(violations, 'R3-hashtagOverlap'), `expected only R3 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  console.log('[R3 fixture message]', violations[0].message);
  assert.equal(violations[0].severity, 'warn');
});

test('R4 fixture: an over-limit youtube title is caught ONLY by R4, as error', () => {
  const current = baselineTextpack({
    youtube: { ...baselineTextpack().youtube, titles: ['가'.repeat(150), '평범한 둘째 제목입니다', '평범한 셋째 제목입니다'] },
  });
  const violations = runAllRules(current);

  assert.ok(onlyRule(violations, 'R4-platformRules'), `expected only R4 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  console.log('[R4 fixture message]', violations[0].message);
  assert.equal(violations[0].severity, 'error');
});

test('R5 fixture: a banned phrase is caught ONLY by R5, as warn', () => {
  const current = baselineTextpack({ facebook: { body: '이 노래는 무조건 좋습니다. 편안하게 들어보세요.' } });
  const violations = runAllRules(current);

  assert.ok(onlyRule(violations, 'R5-bannedPhrases'), `expected only R5 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  console.log('[R5 fixture message]', violations[0].message);
  assert.equal(violations[0].severity, 'warn');
});

test('R6 fixture: too many same-platform posts within 24h is caught ONLY by R6, as warn', () => {
  const current = baselineTextpack();
  const recentEntries = [
    { channelId: current.channelId, postingDate: '2026-08-04T02:00:00Z', platforms: ['instagram'] },
    { channelId: current.channelId, postingDate: '2026-08-03T22:00:00Z', platforms: ['instagram'] },
  ];
  const violations = runAllRules(current, { recentEntries });

  assert.ok(onlyRule(violations, 'R6-postingCadence'), `expected only R6 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  console.log('[R6 fixture message]', violations.find((v) => v.path === 'instagram').message);
  assert.equal(violations.find((v) => v.path === 'instagram').severity, 'warn');
});

test('R7 fixture: 3+ same-stem words in one caption is caught ONLY by R7, as warn', () => {
  const current = baselineTextpack({ facebook: { body: '노래방에서 노래책을 펴고 노래교실 선생님과 노래를 불렀습니다.' } });
  const violations = runAllRules(current);

  assert.ok(onlyRule(violations, 'R7-wordRepetition'), `expected only R7 violations, got: ${JSON.stringify(violations.map((v) => v.rule))}`);
  console.log('[R7 fixture message]', violations[0].message);
  assert.equal(violations[0].severity, 'warn');
});

test('R7 does not false-positive on HTML tags or on unrelated English words sharing only a 2-letter prefix', () => {
  // Regression: found by running against the real sample set — <li> tags
  // were counted as the "word" li x36, and "Never"/"Neon"/"Neighborhood"
  // (distinct English song titles) were grouped as repeats of "Ne".
  const current = baselineTextpack({
    naver: { title: 't', bodyHtml: '<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>', tags: [] },
    facebook: { body: 'Never Neon Neighborhood Evening Every Evenings' },
  });
  const violations = runAllRules(current);
  assert.deepEqual(violations.filter((v) => v.rule === 'R7-wordRepetition'), []);
});

// --- completion condition 4: threshold sensitivity ---

test('condition 4: raising R1_crossChannelSimilarity to 0.99 clears the R1 fixture violation', () => {
  const current = baselineTextpack({ instagram: { caption: '늦여름의 시작 저녁에 어울리는 차분한 편안함 노래 18곡. 프로필 링크에서 전곡을 들어보세요.', hashtags: [], firstComment: '' } });
  const candidateTextpack = { channelId: 'kr-other-channel', instagram: { caption: '늦여름의 시작 저녁에 어울리는 잔잔한 편안함 노래 18곡. 프로필 링크에서 전곡을 들어보세요.' } };
  const candidates = [{ setName: '20260805_다른채널_B', channelId: 'kr-other-channel', textpack: candidateTextpack }];

  const thresholds = loadJson(THRESHOLDS_PATH);
  const highThreshold = { ...thresholds, R1_crossChannelSimilarity: 0.99 };
  const violationsHigh = runAllRules(current, { candidates, thresholds: highThreshold });
  assert.equal(violationsHigh.filter((v) => v.rule === 'R1-crossChannel').length, 0, 'threshold 0.99 should clear the violation');

  const lowThreshold = { ...thresholds, R1_crossChannelSimilarity: 0.01 };
  // A genuinely different, ordinary caption — not hand-picked for zero overlap — still shares
  // a few incidental trigrams (common particles etc.) with `current`, enough to clear 0.01.
  const unrelatedCandidate = [{ setName: '20260805_다른채널_C', channelId: 'kr-other-channel', textpack: { channelId: 'kr-other-channel', instagram: { caption: '이 채널은 매주 새로운 노래를 소개합니다. 편안한 저녁 시간에 들어보세요.' } } }];
  const violationsLow = runAllRules(current, { candidates: unrelatedCandidate, thresholds: lowThreshold });
  assert.ok(violationsLow.filter((v) => v.rule === 'R1-crossChannel').length > 0, 'threshold 0.01 should flag even dissimilar data');

  console.log('[condition 4] violations at 0.99:', violationsHigh.filter((v) => v.rule === 'R1-crossChannel').length, '/ at 0.01:', violationsLow.filter((v) => v.rule === 'R1-crossChannel').length);
});

// --- completion condition 7: every violation has rule/path/value/threshold/excerpt filled ---

test('condition 7: every violation across every fixture has rule, path, value, threshold, excerpt', () => {
  const allViolations = [
    ...runAllRules(baselineTextpack({ instagram: { caption: 'a'.repeat(50), hashtags: [], firstComment: '' } }), {
      candidates: [{ setName: 'x', channelId: 'other', textpack: { channelId: 'other', instagram: { caption: 'a'.repeat(50) } } }],
    }),
    ...runAllRules(baselineTextpack({ templateIds: { 'instagram.caption': 'ig-005' } }), {
      recentEntries: [{ channelId: 'good-morning-memory-radio', checkedAt: '2026-07-30T00:00:00Z', templateIds: { 'instagram.caption': 'ig-005' } }],
    }),
    ...runAllRules(baselineTextpack({ youtube: { ...baselineTextpack().youtube, titles: ['가'.repeat(150), 'b', 'c'] } })),
    ...runAllRules(baselineTextpack({ facebook: { body: '무조건 최고의 선택입니다.' } })),
    ...runAllRules(baselineTextpack({ facebook: { body: '노래방 노래책 노래교실 노래를' } })),
  ];
  assert.ok(allViolations.length > 0);
  for (const v of allViolations) {
    assert.ok(v.rule, `missing rule: ${JSON.stringify(v)}`);
    assert.ok(v.path, `missing path: ${JSON.stringify(v)}`);
    assert.ok(v.value !== undefined && v.value !== null, `missing value: ${JSON.stringify(v)}`);
    assert.ok(v.threshold !== undefined && v.threshold !== null, `missing threshold: ${JSON.stringify(v)}`);
    assert.ok(v.excerpt !== undefined && v.excerpt !== null && v.excerpt !== '', `missing excerpt: ${JSON.stringify(v)}`);
  }
});

// --- completion condition 8: R4 reads platformLimits.json for real ---

test('condition 8: changing platformLimits.json changes R4\'s result', () => {
  const current = baselineTextpack({ youtube: { ...baselineTextpack().youtube, titles: ['이것은 서른 자가 넘는 정도의 평범한 테스트 제목 문자열입니다', 'b', 'c'] } });
  const realLimits = loadJson(LIMITS_PATH);

  const strict = platformRules.check(current, { platformLimits: { ...realLimits, youtube: { ...realLimits.youtube, titleMax: 10 } } });
  const lenient = platformRules.check(current, { platformLimits: { ...realLimits, youtube: { ...realLimits.youtube, titleMax: 500 } } });

  assert.ok(strict.violations.some((v) => v.path === 'youtube.titles.0'), 'a tight titleMax should flag the title');
  assert.ok(!lenient.violations.some((v) => v.path === 'youtube.titles.0'), 'a loose titleMax should not flag the same title');
});

// --- completion condition 9: exhausted template pool downgrades error -> warn, no infinite loop ---

test('condition 9: an exhausted template pool downgrades R2 from error to warn', () => {
  const current = baselineTextpack({ templateIds: { 'instagram.caption': 'ig-only-one' } });
  const recentEntries = [{ channelId: current.channelId, checkedAt: '2026-07-30T00:00:00Z', templateIds: { 'instagram.caption': 'ig-only-one' } }];

  const notExhausted = templateReuse.check(current, { weeks: 4, recentEntries, poolSizes: { instagram: 20 } });
  assert.equal(notExhausted.violations[0].severity, 'error');

  const exhausted = templateReuse.check(current, { weeks: 4, recentEntries, poolSizes: { instagram: 1 } });
  assert.equal(exhausted.violations[0].severity, 'warn');
  assert.match(exhausted.violations[0].message, /템플릿 부족/);
});

test('condition 9 (loop): runLintWithRegeneration stops at regenerateMaxAttempts instead of looping forever', () => {
  const setDir = path.join(OUT_ROOT, '20260804_루프테스트세트');
  fs.mkdirSync(setDir, { recursive: true });
  const stubTextpack = baselineTextpack({
    setName: '20260804_루프테스트세트',
    youtube: { ...baselineTextpack().youtube, titles: ['가'.repeat(150), 'b', 'c'] }, // always violates R4, never fixed by the stub below
  });
  fs.writeFileSync(path.join(setDir, 'textpack.json'), JSON.stringify(stubTextpack));
  try {
    let calls = 0;
    const regenerateFn = (tp) => {
      calls += 1;
      return { ...tp }; // "regenerates" but never actually fixes the violation — must not loop forever
    };
    const { report, attempts } = runLintWithRegeneration('20260804_루프테스트세트', regenerateFn, { textpack: stubTextpack, recordHistory: false });
    const thresholds = loadJson(THRESHOLDS_PATH);
    assert.equal(attempts, thresholds.regenerateMaxAttempts);
    assert.equal(calls, thresholds.regenerateMaxAttempts);
    assert.ok(report.notes.includes('재생성 상한 도달'));
  } finally {
    fs.rmSync(setDir, { recursive: true, force: true });
  }
});

// --- completion condition 10: zero network calls ---

test('condition 10: a full lint run makes zero network calls', () => {
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('network call attempted during social-studio S3 lint — forbidden by spec section 8'); };
  try {
    assert.doesNotThrow(() => runAllRules(baselineTextpack()));
  } finally {
    global.fetch = originalFetch;
  }
});

// --- completion condition 6: missing lintHistory.json -> first run, R1/R2/R3 pass with a note ---

test('condition 6: deleting store/lintHistory.json still runs cleanly as a first run (R1/R2/R3 pass with notes)', () => {
  const backupExists = fs.existsSync(HISTORY_PATH);
  const backup = backupExists ? fs.readFileSync(HISTORY_PATH, 'utf8') : null;
  if (backupExists) fs.unlinkSync(HISTORY_PATH);
  try {
    const history = loadHistory();
    assert.deepEqual(history, { version: 1, entries: [] });

    const { normalized } = runSetPackPipeline(FIXTURE_PATH);
    runTextPackPipeline(normalized, {});
    const report = runSocialLint(normalized.set.setName);

    const r1 = report.notes.find((n) => n.startsWith('R1-crossChannel'));
    const r2 = report.notes.find((n) => n.startsWith('R2-templateReuse'));
    const r3 = report.notes.find((n) => n.startsWith('R3-hashtagOverlap'));
    assert.ok(r1, 'expected an R1 note on first run');
    assert.ok(r2, 'expected an R2 note on first run');
    assert.ok(r3, 'expected an R3 note on first run');
    console.log('[condition 6 notes]', { r1, r2, r3 });
    assert.equal(report.violations.filter((v) => v.rule.startsWith('R1') || v.rule.startsWith('R2') || v.rule.startsWith('R3')).length, 0);
  } finally {
    if (backup !== null) fs.writeFileSync(HISTORY_PATH, backup, 'utf8');
    else if (fs.existsSync(HISTORY_PATH)) fs.unlinkSync(HISTORY_PATH);
  }
});

// --- completion condition 12: history entry cap eviction ---

test('condition 12: appendEntry evicts the oldest entries once maxEntries is exceeded', () => {
  const backupExists = fs.existsSync(HISTORY_PATH);
  const backup = backupExists ? fs.readFileSync(HISTORY_PATH, 'utf8') : null;
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify({ version: 1, entries: [] }));
    let history;
    for (let i = 0; i < 5; i += 1) {
      history = appendEntry({ setName: `set-${i}`, channelId: 'x', checkedAt: new Date(2026, 0, i + 1).toISOString() }, 3);
    }
    assert.equal(history.entries.length, 3);
    assert.deepEqual(history.entries.map((e) => e.setName), ['set-2', 'set-3', 'set-4']);
  } finally {
    if (backup !== null) fs.writeFileSync(HISTORY_PATH, backup, 'utf8');
    else if (fs.existsSync(HISTORY_PATH)) fs.unlinkSync(HISTORY_PATH);
  }
});

// --- completion condition 1: real sample-set run, summary sums correctly ---

test('condition 1: a real run on the sample set writes lint-report.json with a self-consistent summary', () => {
  const backupExists = fs.existsSync(HISTORY_PATH);
  const backup = backupExists ? fs.readFileSync(HISTORY_PATH, 'utf8') : null;
  if (backupExists) fs.unlinkSync(HISTORY_PATH);
  try {
    const { normalized } = runSetPackPipeline(FIXTURE_PATH);
    runTextPackPipeline(normalized, {});
    const { report, outDir } = runSocialLintAndSave(normalized.set.setName);

    assert.ok(fs.existsSync(path.join(outDir, 'lint-report.json')));
    const { error, warn, pass } = report.summary;
    const total = error + warn + pass;
    assert.equal(error + warn, report.violations.length);
    assert.ok(total > 0);
    console.log('[condition 1] summary:', report.summary, 'violations:', report.violations.length);
  } finally {
    if (backup !== null) fs.writeFileSync(HISTORY_PATH, backup, 'utf8');
    else if (fs.existsSync(HISTORY_PATH)) fs.unlinkSync(HISTORY_PATH);
  }
});

// --- loadThresholds sanity ---

test('loadThresholds reads the real data/lintThresholds.json and includes the required _note disclaimer', () => {
  const thresholds = loadThresholds();
  assert.ok(thresholds._note, 'lintThresholds.json must carry the _note disclaimer');
  assert.equal(typeof thresholds.R1_crossChannelSimilarity, 'number');
});
