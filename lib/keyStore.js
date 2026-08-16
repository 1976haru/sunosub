import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, '..', '.gemini_key');
const PAID_KEY_FILE = path.join(__dirname, '..', '.gemini_key_paid');

function clean(value = '') {
  const text = String(value).trim();
  if (!text || text.includes('여기에_')) return '';
  return text;
}

export function readKeyFile() {
  try {
    return clean(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch {
    return '';
  }
}

export function writeKeyFile(apiKey) {
  const value = clean(apiKey);
  if (!value) throw new Error('빈 API 키는 저장할 수 없습니다.');
  fs.writeFileSync(KEY_FILE, value, { encoding: 'utf8', mode: 0o600 });
  return value;
}

/*
 * TASK CS-v1.8 — paid tier, same file/env shape as the free key above but
 * kept in its own file. Gemini's quota and billing are per API key (= per
 * Google Cloud project, CLAUDE.md 3.5), so putting the yt translator on a
 * paid project while everything else stays on the free one is only
 * possible with two independent keys, not one shared one.
 */
export function readPaidKeyFile() {
  try {
    return clean(fs.readFileSync(PAID_KEY_FILE, 'utf8'));
  } catch {
    return '';
  }
}

export function writePaidKeyFile(apiKey) {
  const value = clean(apiKey);
  if (!value) throw new Error('빈 API 키는 저장할 수 없습니다.');
  fs.writeFileSync(PAID_KEY_FILE, value, { encoding: 'utf8', mode: 0o600 });
  return value;
}

// Batch file injects GEMINI_API_KEY into the environment on first run, but
// `npm run dev`/direct `node server.js` invocations skip the batch file, so
// the server also loads .gemini_key itself as a fallback source of truth.
export function loadKeyIntoEnv() {
  if (clean(process.env.GEMINI_API_KEY)) return clean(process.env.GEMINI_API_KEY);
  const fileKey = readKeyFile();
  if (fileKey) process.env.GEMINI_API_KEY = fileKey;
  return fileKey;
}

export function loadPaidKeyIntoEnv() {
  if (clean(process.env.GEMINI_API_KEY_PAID)) return clean(process.env.GEMINI_API_KEY_PAID);
  const fileKey = readPaidKeyFile();
  if (fileKey) process.env.GEMINI_API_KEY_PAID = fileKey;
  return fileKey;
}

/**
 * @param {'free'|'paid'} [tier] - called with no argument, behaves exactly
 * as before this task (returns the free key). 'paid' falls back to the free
 * key when no paid key is configured, so leaving GEMINI_API_KEY_PAID unset
 * keeps every existing call site working unchanged.
 */
export function currentKey(tier = 'free') {
  if (tier === 'paid') {
    const paid = clean(process.env.GEMINI_API_KEY_PAID);
    return paid || clean(process.env.GEMINI_API_KEY);
  }
  return clean(process.env.GEMINI_API_KEY);
}

/** Whether a *paid* key is actually configured (as opposed to currentKey('paid') silently falling back to the free one). */
export function hasPaidKey() {
  return Boolean(clean(process.env.GEMINI_API_KEY_PAID));
}
