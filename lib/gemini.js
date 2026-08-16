import { GoogleGenAI } from '@google/genai';
import { currentKey } from './keyStore.js';
import { recordGeminiUsage, getTodayGeminiUsage } from './geminiUsage.js';
import { getPaidDailyLimit } from './geminiLimits.js';

/** @param {'free'|'paid'} [tier] - omitted, behaves exactly as before this task (free tier). */
export function requireGeminiClient(tier = 'free') {
  const apiKey = currentKey(tier);
  if (!apiKey) {
    const error = new Error(tier === 'paid'
      ? '유료 Gemini 키가 설정되지 않았고 무료 키도 없습니다. 상단 배지에서 키를 입력해 주세요.'
      : 'Gemini API 키가 설정되지 않았습니다. 상단 배지에서 키를 입력해 주세요.');
    error.status = 400;
    error.needsKey = true;
    throw error;
  }
  // TASK CS-v1.8 task D — user-set daily ceiling on the paid tier only (see
  // lib/geminiLimits.js's doc comment for why this doesn't conflict with
  // the "don't hardcode an assumed quota" rule). Checked once per request
  // here, not per retry attempt inside withRetry() — a couple of retries
  // slightly overshooting the cap on the request that crosses it is fine;
  // the point is stopping *new* requests once the day's spend is done.
  if (tier === 'paid') {
    const usedToday = getTodayGeminiUsage().byTier.paid;
    const limit = getPaidDailyLimit();
    if (usedToday >= limit) {
      const error = new Error(`오늘 유료 Gemini 호출이 설정된 상한(${limit}회)에 도달했습니다. .gemini_limits.json의 paidDailyLimit 값을 늘리거나 내일 다시 시도해 주세요.`);
      error.status = 429;
      error.dailyLimitReached = true;
      throw error;
    }
  }
  return new GoogleGenAI({ apiKey });
}

// TASK CS-v1.7 — exported so routes/yt.js's extractWithGemini() can tell a
// quota/server error apart from a genuine tool-compatibility error without
// duplicating this detection logic (unlike stripLeadingNumber(), this isn't
// split across a static page and the server — both sides are this same
// Node process, so sharing one implementation is the straightforward choice).
export function isRateLimitError(error) {
  const status = Number(error?.status || error?.code || 0);
  if (status === 429) return true;
  const message = String(error?.message || '');
  return /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
}

export function isServerError(error) {
  const status = Number(error?.status || error?.code || 0);
  if ([500, 502, 503, 504].includes(status)) return true;
  const message = String(error?.message || '');
  return /"code"\s*:\s*(500|502|503|504)\b|\bUNAVAILABLE\b|\bINTERNAL\b/i.test(message);
}

function parseRetryDelayString(value) {
  const seconds = parseFloat(String(value).replace(/s$/i, ''));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

/*
 * TASK CS-v1.7 — Google's 429 body carries a RetryInfo.retryDelay (e.g. "54s")
 * telling us exactly how long to back off. The @google/genai SDK (confirmed by
 * reading node_modules/@google/genai/dist/vertex_internal/index.js
 * throwErrorIfNotOK, v2.12.0) puts the *entire* raw error envelope
 * (JSON.stringify({error:{code,message,status,details}})) into `error.message`
 * as a string, and sets `error.status` to the numeric HTTP status — it never
 * throws a structured `error.error`/`error.response` object. We still check
 * those shapes defensively in case a future SDK version or a different code
 * path changes that, but the JSON.parse(error.message) branch is the one that
 * actually fires today. Ignoring this field (the old behavior) is why plain
 * exponential backoff kept firing again before Google's own cooldown expired.
 */
function extractRetryDelayMs(error) {
  const bodies = [];
  if (error?.error && typeof error.error === 'object') bodies.push(error.error);
  if (error?.response?.data?.error && typeof error.response.data.error === 'object') {
    bodies.push(error.response.data.error);
  }
  if (typeof error?.message === 'string') {
    try {
      const parsed = JSON.parse(error.message);
      if (parsed?.error) bodies.push(parsed.error);
    } catch {
      // error.message wasn't JSON (e.g. a plain network error) — fall through to the regex scan below.
    }
  }

  for (const body of bodies) {
    const details = Array.isArray(body?.details) ? body.details : [];
    for (const item of details) {
      if (item && typeof item.retryDelay === 'string') {
        const ms = parseRetryDelayString(item.retryDelay);
        if (ms) return ms;
      }
    }
  }

  const rawText = String(error?.message || '');
  const match = rawText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  return match ? parseRetryDelayString(`${match[1]}s`) : null;
}

const RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_DELAYS_MS = [15000, 30000, 60000, 120000];
const SERVER_ERROR_RETRIES = 4;
const SERVER_ERROR_DELAYS_MS = [20000, 40000, 80000, 160000];
// TASK CS-v1.8 task D — a free-tier retry that ultimately fails cost nothing.
// A paid-tier retry re-bills the input tokens (and the batch's whole prompt
// is the input) on every attempt, so the paid slot gets a tighter ceiling.
const PAID_RATE_LIMIT_RETRIES = 3;
const PAID_SERVER_ERROR_RETRIES = 3;

/*
 * TASK CS-v1.7 — process-wide request pacer, shared by every tool that calls
 * withRetry() (CLAUDE.md 3.5: one Gemini key, one quota, five tools). Two
 * independent tabs calling generateContent at the same moment used to burn
 * the same per-minute budget twice as fast; serializing every call through
 * one Promise chain plus one shared "earliest next call" timestamp fixes
 * that regardless of which tool fires.
 *
 * minIntervalMs starts at a "don't fire back-to-back" floor, not at a
 * guessed RPM limit — CLAUDE.md and geminiConfig.json both establish the
 * project rule "don't hardcode an assumed quota, react to what Google
 * actually reports." So this only ever rises, and only in direct response to
 * a real 429 retryDelay (to 60% of it, capped at 45s) — never estimated
 * downward again, since we have no signal that the limit ever loosens mid
 * process.
 *
 * TASK CS-v1.8 — one pacer PER KEY TIER now, not one global pacer. The free
 * and paid keys are different Google Cloud projects with their own
 * independent per-minute quota, so routing both through the same clock
 * meant the paid slot's calls sat behind whatever backoff the free slot's
 * tools had just triggered — they don't share a limit, so there's no reason
 * to share a queue. The paid slot starts at a much shorter floor (0.5s vs
 * 3s) since a paid project's default quota is typically far higher than the
 * free tier's.
 */
function createSlot(initialMinIntervalMs) {
  return { queueTail: Promise.resolve(), lastCallAt: 0, minIntervalMs: initialMinIntervalMs };
}
const SLOTS = {
  free: createSlot(3000),
  paid: createSlot(500),
};
function slotFor(tier) {
  return SLOTS[tier === 'paid' ? 'paid' : 'free'];
}

function raiseMinInterval(slot, retryDelayMs) {
  if (!retryDelayMs) return;
  const candidate = Math.min(45000, retryDelayMs * 0.6);
  if (candidate > slot.minIntervalMs) slot.minIntervalMs = candidate;
}

async function waitForSlot(slot) {
  const wait = Math.max(0, slot.lastCallAt + slot.minIntervalMs - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  slot.lastCallAt = Date.now();
}

function enqueue(slot, task) {
  const run = slot.queueTail.then(task);
  slot.queueTail = run.catch(() => {});
  return run;
}

async function runWithRetry(fn, { retries, label, onNotice, tier }) {
  const slot = slotFor(tier);
  let attempt = 0;
  let lastError;

  for (;;) {
    await waitForSlot(slot);
    try {
      const result = await fn();
      // TASK CS-v1.7 — counted per real attempt, not per withRetry() call; see lib/geminiUsage.js.
      // TASK CS-v1.8 — tier + usageMetadata now flow through too, so paid-slot token spend is tracked (usageMetadata is undefined for non-generateContent calls, e.g. generateVideos — harmless, just nothing to add).
      recordGeminiUsage({ label, success: true, tier, usageMetadata: result?.usageMetadata });
      return result;
    } catch (error) {
      recordGeminiUsage({ label, success: false, tier }); // a failed attempt still spent quota (and still billed input tokens on the paid tier)
      lastError = error;
      const rateLimited = isRateLimitError(error);
      const serverError = !rateLimited && isServerError(error);
      if (!rateLimited && !serverError) throw error;

      // TASK CS-v1.8 task D — paid tier gets a tighter retry ceiling (see
      // PAID_RATE_LIMIT_RETRIES/PAID_SERVER_ERROR_RETRIES above); an
      // explicit `retries` override still wins for either tier.
      const defaultRetries = tier === 'paid'
        ? (rateLimited ? PAID_RATE_LIMIT_RETRIES : PAID_SERVER_ERROR_RETRIES)
        : (rateLimited ? RATE_LIMIT_RETRIES : SERVER_ERROR_RETRIES);
      const maxRetries = retries ?? defaultRetries;
      if (attempt >= maxRetries) break;

      let delayMs;
      let source;
      if (rateLimited) {
        const retryDelayMs = extractRetryDelayMs(error);
        if (retryDelayMs) {
          delayMs = retryDelayMs;
          source = 'retryDelay';
          raiseMinInterval(slot, retryDelayMs);
        } else {
          delayMs = RATE_LIMIT_DELAYS_MS[Math.min(attempt, RATE_LIMIT_DELAYS_MS.length - 1)];
          source = 'backoff';
        }
      } else {
        delayMs = SERVER_ERROR_DELAYS_MS[Math.min(attempt, SERVER_ERROR_DELAYS_MS.length - 1)];
        source = 'backoff';
      }

      onNotice?.({
        label: label || '',
        kind: rateLimited ? 'rate-limit' : 'server-error',
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        source,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  if (isRateLimitError(lastError)) {
    const error = new Error('Gemini 무료 한도(분당 요청 제한)에 도달했습니다. 잠시 후 다시 시도해 주세요.');
    error.status = 429;
    throw error;
  }
  if (isServerError(lastError)) {
    const error = new Error('Gemini 서버 쪽 일시 오류입니다 (구글 쪽 문제이며 API 키·요청 내용과는 무관합니다). 잠시 후 다시 시도해 주세요.');
    error.status = 503;
    throw error;
  }
  throw lastError;
}

/**
 * @param {() => Promise<any>} fn
 * @param {{ retries?: number, label?: string, onNotice?: (info: object) => void, tier?: 'free'|'paid' }} [options]
 *   `retries`, when passed, overrides the retry budget for whichever error
 *   type is hit (kept for tools/social-studio/generate/geminiClient.js's
 *   existing `{ retries: config.maxRetries }` call — signature unchanged).
 *   `tier` defaults to 'free' — every existing call site keeps working
 *   unchanged without passing it.
 */
export function withRetry(fn, options = {}) {
  const { retries, label, onNotice, tier = 'free' } = options;
  return enqueue(slotFor(tier), () => runWithRetry(fn, { retries, label, onNotice, tier }));
}
