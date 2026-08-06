/**
 * TASK-S5 — entry point. Dry-run by default; real publishing requires the
 * explicit --publish flag AND real credentials in .env (never in this
 * repo). See spec section 0: this is the only social-studio code allowed
 * to touch the network, and it carries stricter safeguards than everything
 * else in this tool as a result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWsseHeader, maskSecret } from './wsse.js';
import { buildEntryEndpoint, buildEntryXml, validateEntryXml } from './hatenaAtom.js';
import { postEntry, HatenaHttpError } from './hatenaClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'out');
const CONFIG_PATH = path.join(ROOT, 'data', 'hatenaConfig.json');

const MAX_LEAK_SCAN = 5000; // explicit bound (completion condition #13)

export class PreflightError extends Error {}

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

export function loadHatenaConfig() {
  return loadJson(CONFIG_PATH);
}

function loadTextpack(setName) {
  const filePath = path.join(OUT_ROOT, setName, 'textpack.json');
  if (!fs.existsSync(filePath)) {
    throw new PreflightError(`textpack.json이 없습니다: ${filePath} (S1을 먼저 실행하세요)`);
  }
  return loadJson(filePath);
}

function loadNormalizedIfPresent(setName) {
  const filePath = path.join(OUT_ROOT, setName, 'normalized.json');
  return fs.existsSync(filePath) ? loadJson(filePath) : null;
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Preflight check 1 — channel must be Japanese (jp-*)
// ---------------------------------------------------------------------------

export function checkChannel(channelId) {
  if (!channelId || !channelId.startsWith('jp-')) {
    throw new PreflightError(`일본 채널(jp-*)이 아닙니다: channelId="${channelId}". 하테나 발행은 일본 채널만 허용됩니다.`);
  }
}

// ---------------------------------------------------------------------------
// Preflight check 2 — no uncovered English leaking into the Japanese body
// (same exception rule as S1's own Korean leak-guard: a song's own original
// title and any URL are allowed; everything else in Latin script is not).
// ---------------------------------------------------------------------------

export function extractAllowedWords(songs) {
  const words = new Set();
  for (const song of songs || []) {
    for (const word of (song.title || '').match(/[A-Za-z][A-Za-z'-]*/g) || []) {
      words.add(word.toLowerCase());
    }
  }
  return words;
}

export function checkLanguage(bodyText, allowedWords) {
  // hatena.body is HTML (spec 6-⑦ / blogPost.js parity with naver.bodyHtml) — tag
  // names aren't "English leaking into the post", so they're stripped first
  // (same fix S1's textPack.js needed for naver.bodyHtml's <li> false-positive).
  const withoutTags = String(bodyText || '').replace(/<[^>]+>/g, ' ');
  const stripped = withoutTags.replace(/https?:\/\/\S+/g, ' ');
  const pattern = /[A-Za-z][A-Za-z'-]*/g;
  const leaks = [];
  let match;
  let iterations = 0;
  while ((match = pattern.exec(stripped)) && iterations < MAX_LEAK_SCAN) {
    iterations += 1;
    const word = match[0];
    if (allowedWords.has(word.toLowerCase())) continue;
    leaks.push(word);
  }
  if (leaks.length > 0) {
    throw new PreflightError(`본문에 사전으로 커버되지 않은 영어 단어가 있습니다: ${[...new Set(leaks)].slice(0, 10).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Preflight check 3 — updated must be a future time within the configured window
// ---------------------------------------------------------------------------

export function checkTime(updatedIso, scheduleConfig, now) {
  const updated = new Date(updatedIso);
  if (Number.isNaN(updated.getTime())) {
    throw new PreflightError(`updated 값이 올바른 시각이 아닙니다: ${updatedIso}`);
  }
  if (updated.getTime() <= now.getTime()) {
    throw new PreflightError(`updated(${updatedIso})가 현재 시각(${now.toISOString()})보다 이전이거나 같습니다 — 즉시 발행 사고를 막기 위해 거부합니다.`);
  }
  const diffDays = (updated.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (diffDays < scheduleConfig.minOffsetDays) {
    throw new PreflightError(`updated가 너무 이릅니다: 최소 ${scheduleConfig.minOffsetDays}일 이후여야 합니다.`);
  }
  if (diffDays > scheduleConfig.maxOffsetDays) {
    throw new PreflightError(`updated가 너무 늦습니다: 최대 ${scheduleConfig.maxOffsetDays}일 이내여야 합니다.`);
  }
}

/**
 * Truncating straight to `hourJst` on the (now + minOffsetDays) calendar
 * date can land EARLIER than the minOffsetDays threshold depending on what
 * time of day `now` currently is (e.g. now=22:00 JST -> "+1 day" lands on
 * tomorrow's date, but 09:00 JST on that date is only ~11h away, not 24h) —
 * caught by actually running this against the real clock, not just reading
 * the code. Push forward one more day whenever the naive candidate would
 * undercut the configured minimum gap.
 */
export function computeDefaultScheduledTime(scheduleConfig, now) {
  const minThresholdMs = now.getTime() + scheduleConfig.minOffsetDays * 24 * 60 * 60 * 1000;
  const pad = (n) => String(n).padStart(2, '0');
  const buildIso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(scheduleConfig.hourJst)}:00:00+09:00`;

  let candidateDate = new Date(minThresholdMs);
  let iso = buildIso(candidateDate);
  if (new Date(iso).getTime() < minThresholdMs) {
    candidateDate = new Date(candidateDate.getTime() + 24 * 60 * 60 * 1000);
    iso = buildIso(candidateDate);
  }
  return iso;
}

// ---------------------------------------------------------------------------
// Preflight check 4 — no prior successful publish for this setName
// ---------------------------------------------------------------------------

export function checkDuplicate(setName) {
  const resultPath = path.join(OUT_ROOT, setName, 'hatena-result.json');
  if (!fs.existsSync(resultPath)) return;
  let existing;
  try {
    existing = loadJson(resultPath);
  } catch {
    return; // a corrupt/unreadable prior result never blocks a new attempt
  }
  if (existing.mode === 'publish') {
    throw new PreflightError(`이미 발행된 기록이 있습니다 (setName=${setName}, status=${existing.status}). 중복 발행을 거부합니다.`);
  }
}

// ---------------------------------------------------------------------------
// Credentials — dry-run tolerates missing .env (uses placeholders so the
// WSSE header can still be demonstrated); --publish requires the real thing.
// ---------------------------------------------------------------------------

function resolveCredentials(publish, channelConfig) {
  const hatenaId = process.env.HATENA_ID;
  const apiKey = process.env.HATENA_API_KEY;
  const blogId = process.env[channelConfig.blogIdEnv];

  if (publish) {
    if (!hatenaId || !apiKey || !blogId) {
      throw new PreflightError(
        `.env에 HATENA_ID / HATENA_API_KEY / ${channelConfig.blogIdEnv}가 설정되어 있지 않습니다. 실발행에는 실제 자격증명이 필요합니다.`
      );
    }
    return { hatenaId, apiKey, blogId, isPlaceholder: false };
  }

  return {
    hatenaId: hatenaId || 'dryrun-hatena-id',
    apiKey: apiKey || 'dryrun-placeholder-key',
    blogId: blogId || 'dryrun-example.hatenablog.jp',
    isPlaceholder: !hatenaId || !apiKey || !blogId,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * @param {string} setName
 * @param {object} [options]
 * @param {boolean} [options.publish] - real publish if true; dry-run (default) otherwise
 * @param {Date} [options.now]
 * @param {string} [options.updatedIso] - overrides the computed default schedule time (mainly for tests)
 */
export async function runHatenaPublish(setName, options = {}) {
  const publish = Boolean(options.publish);
  const now = options.now || new Date();
  const config = loadHatenaConfig();
  const textpack = loadTextpack(setName);
  const channelId = textpack.channelId;

  checkChannel(channelId);

  const channelConfig = config.channels[channelId];
  if (!channelConfig) {
    throw new PreflightError(`hatenaConfig.json에 ${channelId} 채널 설정이 없습니다.`);
  }

  if (!textpack.hatena || !textpack.hatena.title || !textpack.hatena.body) {
    throw new PreflightError(
      'textpack.json에 하테나 항목(title/body)이 없습니다. S1이 이 세트에 대해 아직 하테나 콘텐츠를 생성하지 않았습니다 — ' +
      `warnings: ${JSON.stringify(textpack.hatena?.warnings || [])}`
    );
  }

  const normalized = loadNormalizedIfPresent(setName);
  const allowedWords = extractAllowedWords(normalized?.songs);
  checkLanguage(textpack.hatena.body, allowedWords);

  const updatedIso = options.updatedIso || computeDefaultScheduledTime(config.schedule, now);
  checkTime(updatedIso, config.schedule, now);

  checkDuplicate(setName);

  const credentials = resolveCredentials(publish, channelConfig);
  const created = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { header: wsseHeader } = buildWsseHeader({ username: credentials.hatenaId, apiKey: credentials.apiKey, created });

  const xml = buildEntryXml({
    title: textpack.hatena.title,
    contentHtml: textpack.hatena.body,
    hatenaId: credentials.hatenaId,
    updatedIso,
    category: textpack.hatena.category || channelConfig.category,
  });

  const validation = validateEntryXml(xml, { now });
  if (!validation.valid) {
    throw new PreflightError(`생성된 Entry XML이 유효하지 않습니다: ${validation.errors.join('; ')}`);
  }

  // WSSE 헤더 전체를 로그·리포트에 남기지 않는다 (spec 3장). Username/Created만
  // 보여주고 Nonce/PasswordDigest는 마스킹한다.
  const wsseHeaderMasked = `UsernameToken Username="${credentials.hatenaId}", PasswordDigest="${maskSecret(credentials.apiKey)}", Nonce="${maskSecret('x')}", Created="${created}"`;

  if (!publish) {
    return {
      mode: 'dryrun',
      setName,
      channelId,
      xml,
      wsseHeaderMasked,
      updatedIso,
      usedPlaceholderCredentials: credentials.isPlaceholder,
      warnings: [],
    };
  }

  const endpoint = buildEntryEndpoint(credentials.hatenaId, credentials.blogId);
  const requestedAt = now.toISOString();

  try {
    const result = await postEntry({ endpoint, xml, wsseHeader, retryConfig: config.retry });
    const record = {
      mode: 'publish',
      setName,
      channelId,
      requestedAt,
      scheduledFor: updatedIso,
      status: 'scheduled',
      entryUrl: result.entryUrl,
      attempts: result.attempts,
      warnings: [],
    };
    atomicWriteJson(path.join(OUT_ROOT, setName, 'hatena-result.json'), record);
    return record;
  } catch (error) {
    const record = {
      mode: 'publish',
      setName,
      channelId,
      requestedAt,
      scheduledFor: updatedIso,
      status: 'failed',
      entryUrl: null,
      error: error.message, // HatenaHttpError messages never include the key by construction
      warnings: [],
    };
    atomicWriteJson(path.join(OUT_ROOT, setName, 'hatena-result.json'), record);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runCli() {
  const args = process.argv.slice(2);
  const publish = args.includes('--publish');
  const setName = args.find((a) => !a.startsWith('--'));
  if (!setName) {
    console.error('사용법: node hatena.js <setName> [--publish]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runHatenaPublish(setName, { publish });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[hatena] 실패: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const dotenv = await import('dotenv');
  dotenv.config();
  await runCli();
}
