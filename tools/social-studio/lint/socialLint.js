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
import { extractProseFields, contentFingerprint } from './similarity.js';
import {
  loadHistory,
  appendEntry,
  findRecentEntries,
  resolvePostingDate,
  listOtherSetsInSameWeek,
  loadTextpackForSet,
} from '../store/lintHistory.js';

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

  const history = options.history || loadHistory();
  const currentDate = resolvePostingDate(textpack) || new Date();
  const recentEntries = findRecentEntries(history, {
    channelId: textpack.channelId,
    referenceDate: currentDate,
    weeks: thresholds.R2_templateReuseWeeks,
    excludeSetName: setName,
  });

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

  const ruleResults = [
    crossChannel.check(textpack, { threshold: thresholds.R1_crossChannelSimilarity, candidates }),
    templateReuse.check(textpack, { weeks: thresholds.R2_templateReuseWeeks, recentEntries, poolSizes }),
    hashtagOverlap.check(textpack, { threshold: thresholds.R3_hashtagOverlapRatio, weeks: thresholds.R2_templateReuseWeeks, recentEntries }),
    platformRules.check(textpack, { platformLimits }),
    bannedPhrasesRule.check(textpack, { phrases }),
    postingCadence.check(textpack, { maxPostsPer24h: thresholds.R6_maxPostsPer24h, currentDate, recentEntries }),
    wordRepetition.check(textpack, { maxNounRepeat: thresholds.R7_maxNounRepeat }),
  ];

  const violations = ruleResults.flatMap((r) => r.violations);
  const notes = ruleResults.flatMap((r) => r.notes || []);
  const totalChecked = ruleResults.reduce((sum, r) => sum + r.checkedCount, 0);
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warnCount = violations.filter((v) => v.severity === 'warn').length;
  const passCount = totalChecked - errorCount - warnCount;

  const regenerate = [...new Set(violations.filter((v) => v.severity === 'error').map((v) => v.path))];

  return {
    setName,
    checkedAt: new Date().toISOString(),
    summary: { error: errorCount, warn: warnCount, pass: passCount },
    violations,
    notes,
    regenerate,
  };
}

/** runSocialLint() + write lint-report.json + append a lintHistory.json entry (fingerprints only, never raw text). */
export function runSocialLintAndSave(setName, options = {}) {
  const report = runSocialLint(setName, options);
  const outDir = path.join(OUT_ROOT, setName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'lint-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (options.recordHistory !== false) {
    const textpack = options.textpack || loadTextpackForSet(setName);
    const thresholds = options.thresholds || loadThresholds();
    const entry = {
      setName,
      channelId: textpack.channelId,
      checkedAt: report.checkedAt,
      postingDate: (resolvePostingDate(textpack) || new Date()).toISOString(),
      platforms: postingCadence.collectPlatforms(textpack),
      templateIds: textpack.templateIds || {},
      hashtags: {
        youtube: textpack.youtube?.hashtags || [],
        instagram: textpack.instagram?.hashtags || [],
      },
      fingerprints: buildFingerprints(textpack),
    };
    appendEntry(entry, thresholds.historyMaxEntries);
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
 * @param {object} options - forwarded to runSocialLint (thresholds/history overrides).
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
