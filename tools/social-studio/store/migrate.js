/**
 * TASK-S6 — one-time merge of S3's store/lintHistory.json (per-SET entries)
 * into S6's store/data/history.json (per-SET-PER-PLATFORM entries). Safe to
 * run more than once: every transformed entry upserts by `${setName}#${platform}`
 * through history.record(), so re-running never grows the entry count
 * (spec completion condition #7).
 *
 * lintHistory.json never distinguished "generated" from "published" — it
 * only ever recorded that a lint check ran. transformEntry()'s OWN output
 * always shows status:'generated' (informative for a dryRun preview: "this
 * is what a freshly-migrated entry looks like"). But by the time
 * migrateLintHistory() actually writes via history.record(), that status
 * field is stripped back out before the call — history.record()'s upsert
 * already preserves an existing entry's real status when the caller omits
 * the field (see store/history.js), and re-running migrate.js after S6 has
 * since published that same set must NOT silently revert it to
 * 'generated'. Only a genuinely NEW entry (nothing to preserve) ends up
 * with 'generated', via record()'s own default — which is still the safe
 * direction to guess wrong in for a first migration: it can never cause a
 * template to look falsely exhausted (spec section 0's core rule).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as history from './history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINT_HISTORY_PATH = path.join(__dirname, 'lintHistory.json');

const MAX_SOURCE_ENTRIES = 10000; // explicit bound (completion condition #13)
const MAX_PLATFORMS_PER_ENTRY = 20;

function loadLintHistory() {
  if (!fs.existsSync(LINT_HISTORY_PATH)) return null;
  const raw = fs.readFileSync(LINT_HISTORY_PATH, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(raw);
  } catch {
    return null; // a corrupt lintHistory.json is not S6's problem to fix — skip migration, don't crash
  }
}

/** One S3 (per-set) entry -> zero or more S6 (per-set-per-platform) entries. */
export function transformEntry(s3Entry) {
  const platforms = (s3Entry.platforms || []).slice(0, MAX_PLATFORMS_PER_ENTRY);
  const out = [];
  for (const platform of platforms) {
    const templateIds = Object.entries(s3Entry.templateIds || {})
      .filter(([itemId]) => itemId.split('.')[0] === platform)
      .map(([, templateId]) => templateId);
    const hashtags = s3Entry.hashtags?.[platform] || [];
    const fingerprintEntries = Object.entries(s3Entry.fingerprints || {})
      .filter(([itemPath]) => itemPath.split('.')[0] === platform);
    const fingerprint = fingerprintEntries.length ? fingerprintEntries.map(([, fp]) => fp).join(',') : undefined;

    out.push({
      setName: s3Entry.setName,
      channelId: s3Entry.channelId,
      platform,
      status: 'generated',
      generatedAt: s3Entry.checkedAt,
      publishedAt: null,
      templateIds,
      hashtags,
      ...(fingerprint ? { fingerprint } : {}),
    });
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - compute the transform without writing
 * @returns {{ available: boolean, migrated: number, entries: object[] }}
 */
export function migrateLintHistory({ dryRun = false } = {}) {
  const lintHistory = loadLintHistory();
  if (!lintHistory || !Array.isArray(lintHistory.entries)) {
    return { available: false, migrated: 0, entries: [] };
  }

  const transformed = [];
  const sourceEntries = lintHistory.entries.slice(0, MAX_SOURCE_ENTRIES);
  for (const s3Entry of sourceEntries) {
    transformed.push(...transformEntry(s3Entry));
  }

  if (!dryRun) {
    for (const entry of transformed) {
      // status/publishedAt are dropped here on purpose — see the file header
      // comment. Passing them through would let a re-migration silently
      // clobber a status that S6 has since moved on to (e.g. 'published').
      const { status, publishedAt, ...writable } = entry;
      history.record(writable);
    }
  }

  return { available: true, migrated: transformed.length, entries: transformed };
}
