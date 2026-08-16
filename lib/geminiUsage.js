/*
 * TASK CS-v1.7 — cross-tool Gemini usage counter. lib/gemini.js's withRetry()
 * is the one place every tool's generateContent call passes through
 * (CLAUDE.md 3.5 — one key, five tools share it), so it's the only place
 * this counts from; a counter planted at each call site would silently miss
 * whichever new call site forgets to add itself.
 *
 * Display-only, on purpose: nothing here blocks or throttles a call. That
 * follows the same rule tools/social-studio/data/geminiConfig.json already
 * established — don't hardcode an assumed quota, Google AI Studio's
 * dashboard is the account-wide source of truth, this is just a same-day
 * reference number surfaced in the UI.
 *
 * Deliberately separate from tools/social-studio/store/geminiUsage.json:
 * that counter is scoped to the social-studio screen only (its own doc
 * comment says so). This one is scoped to every tool that shares the key,
 * so it needed its own file rather than folding into that one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_PATH = path.join(__dirname, '..', '.gemini_usage.json');

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function loadUsage() {
  if (!fs.existsSync(USAGE_PATH)) return { version: 1, days: {} };
  try {
    const raw = fs.readFileSync(USAGE_PATH, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    if (!data || typeof data.days !== 'object' || data.days === null) return { version: 1, days: {} };
    return data;
  } catch {
    return { version: 1, days: {} }; // display-only counter — a corrupt file just resets, nothing worth recovering
  }
}

function saveUsage(data) {
  // write-to-temp-then-rename so a crash mid-write can't leave a half-written file
  const tmpPath = path.join(__dirname, '..', `.gemini_usage.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, USAGE_PATH);
}

const emptyDay = () => ({ total: 0, failed: 0, byLabel: {} });

/**
 * Records one real Gemini request attempt (including a retry — each one is
 * a real request that spent quota, so each is counted, not just the final
 * outcome of a withRetry() call).
 */
export function recordGeminiUsage({ label = '', success = true } = {}, now = new Date()) {
  const usage = loadUsage();
  const key = todayKey(now);
  const day = usage.days[key] || emptyDay();
  day.total += 1;
  if (!success) day.failed += 1;
  const labelKey = label || 'unlabeled';
  day.byLabel[labelKey] = (day.byLabel[labelKey] || 0) + 1;
  usage.days[key] = day;
  saveUsage(usage);
  return day;
}

export function getTodayGeminiUsage(now = new Date()) {
  const usage = loadUsage();
  return usage.days[todayKey(now)] || emptyDay();
}
