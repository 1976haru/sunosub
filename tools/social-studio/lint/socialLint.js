/**
 * TASK-S3 — entry point. Loads a set's textpack + the shared config/history
 * files, runs all 7 rules, writes out/{setName}/lint-report.json, and
 * appends one fingerprint-only entry to store/lintHistory.json.
 *
 * This file never imports a text generator. The regenerate/relint loop
 * (spec section 5) is exposed as runLintWithRegeneration(), which takes the
 * actual regeneration function as a parameter from its caller — S1's own
 * call site is where that gets wired up, in one line (see
 * generate/textPack.js's runTextPackPipeline `options.onAfterGenerate`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crossChannel from './rules/crossChannel.js';
import * as templateReuse from './rules/templateReuse.js';
import * as hashtagOverlap from './rules/hashtagOverlap.js';
import * as platformRules from './rules/platformRules.js';
import * as bannedPhrasesRule from './rules/bannedPhrases.js';
import * as postingCadence from './rules/postingCadence.js';
import * as wordRepetition from './rules/wordRepetition.js';
import * as intraSetRepetition from './rules/intraSetRepetition.js';
import * as crossPlatformHashtagOverlap from './rules/crossPlatformHashtagOverlap.js';
import { extractProseFields, contentFingerprint } from './similarity.js';
import {
  resolvePostingDate,
  listOtherSetsInSameWeek,
  loadTextpackForSet,
  loadNormalizedForSet,
} from '../store/lintHistory.js';
import * as history from '../store/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'out');
const THRESHOLDS_PATH = path.join(ROOT, 'data', 'lintThresholds.json');
const BANNED_PHRASES_PATH = path.join(ROOT, 'data', 'bannedPhrases.json');
const PLATFORM_LIMITS_PATH = path.join(ROOT, 'data', 'platformLimits.json');
const TEMPLATES_ROOT = path.join(ROOT, 'templates');

const MAX_CANDIDATE_SETS = 200; // explicit bound on cross-channel candidates (completion condition #11)
const MAX_TEMPLATE_FILES_SCANNED = 100;

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

export function loadThresholds() {
  return loadJson(THRESHOLDS_PATH);
}

function loadBannedPhrasesConfig() {
  return loadJson(BANNED_PHRASES_PATH);
}

function loadPlatformLimitsConfig() {
  return loadJson(PLATFORM_LIMITS_PATH);
}

function mergeBannedPhrases(config, channelId) {
  return [...(config._shared || []), ...(config[channelId] || [])];
}

/**
 * Sums template counts per "platform" (the file's name before its first
 * '-') so e.g. youtube-title.json + youtube-desc.json + youtube-pinned.json
 * all count toward 'youtube' — a deliberately rough aggregate (spec only
 * needs "is the pool exhausted", not per-slot precision) that avoids R2
 * ever getting stuck in an unbreakable error loop.
 */
function loadTemplatePoolSizes(channelId) {
  const dir = path.join(TEMPLATES_ROOT, channelId);
  const sizes = {};
  if (!fs.existsSync(dir)) return sizes;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, MAX_TEMPLATE_FILES_SCANNED);
  for (const file of files) {
    let data;
    try {
      data = loadJson(path.join(dir, file));
    } catch {
      continue;
    }
    if (!Array.isArray(data.templates)) continue;
    const platform = file.replace(/\.json$/, '').split('-')[0];
    sizes[platform] = (sizes[platform] || 0) + data.templates.length;
  }
  return sizes;
}

function buildFingerprints(textpack) {
  const result = {};
  for (const item of extractProseFields(textpack)) {
    result[item.path] = contentFingerprint(item.text);
  }
  return result;
}

/** One combined fingerprint string per platform, joining every prose field under that platform's path prefix — same collapse migrate.js uses. */
function fingerprintForPlatform(fingerprints, platform) {
  const parts = Object.entries(fingerprints)
    .filter(([itemPath]) => itemPath.split('.')[0] === platform)
    .map(([, fp]) => fp);
  return parts.length ? parts.join(',') : undefined;
}

const MAX_HISTORY_PLATFORMS_SCANNED = 20; // explicit bound

// Duplicated from lint/rules/hashtagOverlap.js's own HASHTAG_PLATFORMS on
// purpose — that rule module isn't in S6's allow-list and doesn't export
// the constant (same "두 벌은 의도적으로" reasoning as CLAUDE.md 3.3's
// stripLeadingNumber()).
const HASHTAG_PLATFORMS = ['youtube', 'instagram'];

function safeGetPublished(channelId, platform, weeks) {
  try {
    return history.getPublished(channelId, platform, weeks);
  } catch {
    return [];
  }
}

/**
 * TASK-S6 — recentEntries adapter. templateReuse.js / hashtagOverlap.js /
 * postingCadence.js are NOT in S6's allow-list and already expect a
 * specific `recentEntries` shape carried over from store/lintHistory.js
 * (per-SET records: itemId-keyed templateIds, platform-keyed hashtags,
 * platforms[] + postingDate). store/history.js instead stores one record
 * per SET-PER-PLATFORM with a flat templateIds array — this file is the
 * only place allowed to reshape one into the other; nothing else may read
 * store/data/history.json directly (spec completion condition #11).
 *
 * Each rule gets its OWN recentEntries list, sourced from whichever
 * history.js query matches what that rule is actually supposed to count:
 *  - R2 (template reuse) must never be satisfied by a merely-generated
 *    draft (spec section 0's core rule) -> history.getPublished() only.
 *  - R3 (hashtag overlap) is about not repeating tags in near-future
 *    generation, not just what shipped -> history.getRecentHashtags(),
 *    which already includes 'generated' (excludes only 'discarded').
 *  - R6 (posting cadence) is a real posting-schedule collision check, so an
 *    unpublished draft can't crowd it -> history.getPublished() only.
 * A lookup failure for one platform degrades to "no data for that
 * platform" rather than aborting the run — R2/R3/R6 already treat an empty
 * recentEntries as "첫 실행" and skip with a note, exactly the pre-S6
 * fallback (spec 4-1's "조회가 실패하면 값이 없는 것처럼 진행한다" applied
 * the same way here).
 */
function buildTemplateReuseEntries(textpack, setName, weeks) {
  const platforms = [...new Set(Object.keys(textpack.templateIds || {}).map((itemId) => itemId.split('.')[0]))].slice(0, MAX_HISTORY_PLATFORMS_SCANNED);
  const entries = [];
  for (const platform of platforms) {
    for (const e of safeGetPublished(textpack.channelId, platform, weeks)) {
      if (e.setName === setName) continue;
      const templateIds = {};
      (e.templateIds || []).forEach((templateId, i) => {
        templateIds[`${platform}.${i}`] = templateId;
      });
      entries.push({ setName: e.setName, channelId: e.channelId, templateIds });
    }
  }
  return entries;
}

function buildHashtagEntries(textpack, weeks) {
  const entries = [];
  for (const platform of HASHTAG_PLATFORMS) {
    let tags;
    try {
      tags = history.getRecentHashtags(textpack.channelId, platform, weeks);
    } catch {
      tags = [];
    }
    if (tags.length > 0) entries.push({ hashtags: { [platform]: tags } });
  }
  return entries;
}

function buildCadenceEntries(textpack, setName, weeks) {
  const platforms = postingCadence.collectPlatforms(textpack).slice(0, MAX_HISTORY_PLATFORMS_SCANNED);
  const entries = [];
  for (const platform of platforms) {
    for (const e of safeGetPublished(textpack.channelId, platform, weeks)) {
      if (e.setName === setName) continue;
      entries.push({ setName: e.setName, platforms: [platform], postingDate: e.publishedAt || e.generatedAt });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Runs all 7 rules against one textpack and returns the report object
 * (does not write anything to disk — see runSocialLintAndSave for that).
 * `options.textpack` lets a caller pass an already-in-memory textpack
 * (e.g. mid regenerate-loop) instead of re-reading it from disk.
 */
export function runSocialLint(setName, options = {}) {
  const thresholds = options.thresholds || loadThresholds();
  const textpack = options.textpack || loadTextpackForSet(setName);
  if (!textpack) {
    throw new Error(`textpack.json이 없습니다: ${setName}`);
  }

  const currentDate = resolvePostingDate(textpack) || new Date();
  const weeks = thresholds.R2_templateReuseWeeks;
  const recentEntriesForTemplateReuse = buildTemplateReuseEntries(textpack, setName, weeks);
  const recentEntriesForHashtag = buildHashtagEntries(textpack, weeks);
  const recentEntriesForCadence = buildCadenceEntries(textpack, setName, weeks);

  const candidateSetNames = listOtherSetsInSameWeek(setName, textpack.channelId).slice(0, MAX_CANDIDATE_SETS);
  const candidates = [];
  for (const name of candidateSetNames) {
    const other = loadTextpackForSet(name);
    if (other) candidates.push({ setName: name, channelId: other.channelId, textpack: other });
  }

  const platformLimits = loadPlatformLimitsConfig();
  const bannedPhrasesConfig = loadBannedPhrasesConfig();
  const phrases = mergeBannedPhrases(bannedPhrasesConfig, textpack.channelId);
  const poolSizes = loadTemplatePoolSizes(textpack.channelId);
  const normalized = loadNormalizedForSet(setName);

  const ruleResults = [
    crossChannel.check(textpack, { threshold: thresholds.R1_crossChannelSimilarity, candidates }),
    templateReuse.check(textpack, { weeks, recentEntries: recentEntriesForTemplateReuse, poolSizes }),
    hashtagOverlap.check(textpack, { threshold: thresholds.R3_hashtagOverlapRatio, weeks, recentEntries: recentEntriesForHashtag }),
    platformRules.check(textpack, { platformLimits }),
    bannedPhrasesRule.check(textpack, { phrases }),
    postingCadence.check(textpack, { maxPostsPer24h: thresholds.R6_maxPostsPer24h, currentDate, recentEntries: recentEntriesForCadence }),
    wordRepetition.check(textpack, { maxNounRepeat: thresholds.R7_maxNounRepeat }),
    intraSetRepetition.check(textpack, { normalized, maxAcrossPlatforms: thresholds.R8_maxSceneNounAcrossPlatforms }),
    crossPlatformHashtagOverlap.check(textpack, { threshold: thresholds.R9_crossPlatformHashtagOverlap }),
  ];

  const violations = ruleResults.flatMap((r) => r.violations);
  const notes = ruleResults.flatMap((r) => r.notes || []);
  const totalChecked = ruleResults.reduce((sum, r) => sum + r.checkedCount, 0);
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warnCount = violations.filter((v) => v.severity === 'warn').length;
  const passCount = totalChecked - errorCount - warnCount;

  // TASK-S8: R8 is severity 'warn' but still needs a reroll (spec: "위반 시
  // regenerate 배열에 해당 항목을 넣는다") — so a violation opts into
  // regeneration explicitly via `regenerate: true` rather than only ever
  // inferring it from severity==='error'. Every pre-S8 rule leaves this
  // field unset, so this is additive: nothing else's regenerate-eligibility
  // changes.
  const regenerate = [...new Set(violations.filter((v) => v.severity === 'error' || v.regenerate === true).map((v) => v.path))];

  return {
    setName,
    checkedAt: new Date().toISOString(),
    summary: { error: errorCount, warn: warnCount, pass: passCount },
    violations,
    notes,
    regenerate,
  };
}

/**
 * runSocialLint() + write lint-report.json + record one store/data/history.json
 * entry PER PLATFORM (status defaults to 'generated' — record() preserves an
 * existing 'published'/'discarded' status on re-run rather than resetting
 * it, see store/history.js). lintHistory.json is no longer written here;
 * once store/migrate.js has merged it, it's dead (spec section 4-2).
 */
export function runSocialLintAndSave(setName, options = {}) {
  const report = runSocialLint(setName, options);
  const outDir = path.join(OUT_ROOT, setName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'lint-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (options.recordHistory !== false) {
    const textpack = options.textpack || loadTextpackForSet(setName);
    const fingerprints = buildFingerprints(textpack);
    const platforms = postingCadence.collectPlatforms(textpack).slice(0, MAX_HISTORY_PLATFORMS_SCANNED);
    for (const platform of platforms) {
      const templateIds = Object.entries(textpack.templateIds || {})
        .filter(([itemId]) => itemId.split('.')[0] === platform)
        .map(([, templateId]) => templateId);
      const fingerprint = fingerprintForPlatform(fingerprints, platform);
      try {
        history.record({
          setName,
          channelId: textpack.channelId,
          platform,
          generatedAt: report.checkedAt,
          templateIds,
          hashtags: textpack[platform]?.hashtags || [],
          ...(fingerprint ? { fingerprint } : {}),
        });
      } catch {
        // a history.js write failure must never block the lint report itself from being saved
      }
    }
  }

  return { report, outDir };
}

// ---------------------------------------------------------------------------
// Regenerate/relint interface (spec section 5) — S1 supplies the actual
// regeneration function; this module only ever calls what it's given.
// ---------------------------------------------------------------------------

/**
 * @param {string} setName
 * @param {(textpack: object, itemPaths: string[]) => object|null} regenerateFn
 *   Called with the current textpack and the list of item paths that must be
 *   redone (report.regenerate). Must return an updated textpack, or a
 *   falsy value to stop early.
 * @param {object} options - forwarded to runSocialLint (thresholds/textpack overrides).
 */
export function runLintWithRegeneration(setName, regenerateFn, options = {}) {
  const thresholds = options.thresholds || loadThresholds();
  const maxAttempts = thresholds.regenerateMaxAttempts;

  let attempt = 0;
  let currentTextpack = options.textpack || loadTextpackForSet(setName);
  let report = runSocialLint(setName, { ...options, textpack: currentTextpack });

  while (report.regenerate.length > 0 && attempt < maxAttempts) {
    attempt += 1;
    const updated = regenerateFn(currentTextpack, report.regenerate);
    if (!updated) break;
    currentTextpack = updated;
    report = runSocialLint(setName, { ...options, textpack: currentTextpack });
  }

  if (report.regenerate.length > 0 && attempt >= maxAttempts) {
    report = { ...report, notes: [...report.notes, '재생성 상한 도달'] };
  }

  return { report, attempts: attempt, textpack: currentTextpack };
}
