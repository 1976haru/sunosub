/*
 * TASK CS-v1.8 task D — a user-set daily ceiling on PAID-tier calls only.
 * This is not the "don't hardcode an assumed quota" rule
 * (tools/social-studio/data/geminiConfig.json) being violated — that rule
 * is about not guessing what Google's real limit is. This is a different
 * kind of number: a spending cap the user themselves chose and can change
 * any time by editing .gemini_limits.json (gitignored — it's local state,
 * not a decision the code makes for the user). The account-wide truth for
 * what Google will actually allow is still Google AI Studio / Cloud
 * Console; this only stops runaway *local* spend before that, on the one
 * key tier that costs real money.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIMITS_PATH = path.join(__dirname, '..', '.gemini_limits.json');
const DEFAULT_PAID_DAILY_LIMIT = 300;

export function getPaidDailyLimit() {
  if (!fs.existsSync(LIMITS_PATH)) return DEFAULT_PAID_DAILY_LIMIT;
  try {
    const raw = fs.readFileSync(LIMITS_PATH, 'utf8').replace(/^﻿/, '');
    const limit = Number(JSON.parse(raw)?.paidDailyLimit);
    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_PAID_DAILY_LIMIT;
  } catch {
    return DEFAULT_PAID_DAILY_LIMIT; // malformed file — fall back rather than silently disabling the cap
  }
}
