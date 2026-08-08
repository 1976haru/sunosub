/**
 * TASK-S1 — template loading + slot substitution.
 *
 * No sentence is ever written in this file. Every string that ends up in a
 * textpack comes from templates/{channelId}/{platform}.json; this module
 * only knows how to read that JSON, plug values into `{slot}` tokens, and
 * refuse a template whose slots can't all be filled — it never falls back
 * to a hardcoded default sentence (spec section 4: "사용 가능한 템플릿이
 * 하나도 없으면 명시적 오류를 던진다. 기본 문장으로 대체하지 않는다").
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickDistinctIndices, pickDistinctIndicesExcluding } from './rotation.js';
import * as history from '../store/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_ROOT = path.join(__dirname, '..', 'templates');

const SLOT_PATTERN = /\{(\w+)\}/g;

// Korean particle allomorphy (이/가, 은/는, 을/를, 과/와, 으로/로) depends on
// whether the PRECEDING syllable ends in a batchim (받침) — which we don't
// know until a slot is filled with real data ("차분한 편안함" vs "굿모닝
// 추억라디오"). Templates write the ambiguous pair right after the slot,
// e.g. "{emotionToKo}(이/가)", and fillSlots() resolves it once the actual
// value is known. This is Hangul syllable-block arithmetic, not a
// translation feature — every codepoint in the Unicode Hangul Syllables
// block (AC00-D7A3) decomposes as (initial*21+medial)*28+final, so
// (code-0xAC00)%28 is 0 for no batchim, and 8 specifically for a bare ㄹ
// batchim (which triggers the same "로" liaison as no batchim at all).
const PARTICLE_MARKER_PATTERN = /(.)\((이\/가|은\/는|을\/를|과\/와|으로\/로)\)/g;

function batchimIndex(char) {
  const code = char.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return null;
  return (code - 0xac00) % 28;
}

function resolveParticleMarkers(text) {
  return text.replace(PARTICLE_MARKER_PATTERN, (whole, lastChar, pairKey) => {
    const [batchimForm, noBatchimForm] = pairKey.split('/');
    const idx = batchimIndex(lastChar);
    if (pairKey === '으로/로') {
      const useShortForm = idx === 0 || idx === 8; // no batchim, or a bare ㄹ batchim
      return lastChar + (useShortForm ? noBatchimForm : batchimForm);
    }
    const hasBatchim = idx === null ? true : idx !== 0; // non-Hangul (digits, Latin): default to the batchim form
    return lastChar + (hasBatchim ? batchimForm : noBatchimForm);
  });
}
// Explicit upper bound on the "try the next template" retry loop
// (TASK-S1 completion condition #10) — no pool this tool ships is anywhere
// near this size, so it never actually limits real rotation, only guards
// against a runaway loop on a malformed templates file.
const MAX_TEMPLATE_ATTEMPTS = 1000;

export class TemplatePoolError extends Error {}

/**
 * Loads templates/{channelId}/{platform}.json. Returns the raw `templates`
 * array ([{id, text, ...}]). Throws if the file is missing, unreadable, or
 * has an empty/absent templates array — this is what makes "empty
 * templates/ folder -> explicit error" (completion condition #3) work: an
 * empty folder means every loadTemplateFile() call throws before any text
 * is generated.
 */
export function loadTemplateFile(channelId, platform) {
  const filePath = path.join(TEMPLATES_ROOT, channelId, `${platform}.json`);
  if (!fs.existsSync(filePath)) {
    throw new TemplatePoolError(`템플릿 파일이 없습니다: templates/${channelId}/${platform}.json`);
  }
  let data;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    data = JSON.parse(raw);
  } catch (error) {
    throw new TemplatePoolError(`템플릿 파일을 읽을 수 없습니다 (${channelId}/${platform}): ${error.message}`);
  }
  if (!Array.isArray(data.templates) || data.templates.length === 0) {
    throw new TemplatePoolError(`사용 가능한 템플릿이 없습니다: templates/${channelId}/${platform}.json`);
  }
  return data.templates;
}

// TASK-S8 작업 F — 조사 중복. `{seasonKo}의 노래`처럼 템플릿이 조사를 직접
// 적어둔 자리에, 슬롯 값 자체가 이미 그 조사로 끝나는 경우("늦여름의 시작")
// "늦여름의 시작의 노래"처럼 겹친다. (이/가) 같은 마커 시스템은 받침에 따라
// *어느 쪽* 조사를 쓸지 고르는 것이지 이 문제(같은 조사가 두 번)를 잡지
// 않으므로 별도의 후처리로 다룬다. 단일 패스이므로 세 번 이상 겹치면 두
// 개로만 줄어들 수 있다 — 그 잔여분은 hasDuplicateParticles()로 감지해
// 호출자가 errors에 남기도록 한다(조용히 넘기지 않는다).
const DUPLICATE_PARTICLE_PATTERN = /([의이를은가에과와로])\1/g;

/** Collapses "의의"/"이이"/"를를"/"은은"/"가가"/"에에"/"과과"/"와와"/"로로" -> a single particle. Single-pass (see comment above). */
export function collapseDuplicateParticles(text) {
  return String(text ?? '').replace(DUPLICATE_PARTICLE_PATTERN, '$1');
}

/** True if a duplicated-particle pattern is still present (used post-collapse, as a residual-defect detector — see textPack.js's checkField). */
export function hasDuplicateParticles(text) {
  return new RegExp(DUPLICATE_PARTICLE_PATTERN.source).test(String(text ?? ''));
}

/**
 * Substitutes every {slot} in `text` from `slots`. Returns null — not a
 * string with blanks left in it — if ANY slot referenced by the template is
 * missing/empty, so the caller can skip straight to the next template
 * (spec section 4: "슬롯 값이 비어 있으면 그 템플릿을 건너뛰고 다음 것을
 * 쓴다. 빈칸이 그대로 출력되면 안 된다").
 */
export function fillSlots(text, slots) {
  let allFilled = true;
  const filled = String(text).replace(SLOT_PATTERN, (whole, key) => {
    const value = slots[key];
    if (value === undefined || value === null || value === '') {
      allFilled = false;
      return whole;
    }
    return String(value);
  });
  if (!allFilled) return null;
  return collapseDuplicateParticles(resolveParticleMarkers(filled));
}

/** Optional per-template filter, e.g. { role: 'intro' } for youtube-desc.json's mixed intro/closing pool. */
function matchesFilter(template, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => template[key] === value);
}

/**
 * TASK-S6 — resolves the rotation order for `pool`, optionally excluding
 * templates store/history.js says were already PUBLISHED for this
 * channel+platform (never just generated — see history.js's own doc
 * comment on getUsedTemplateIds). `historyContext` is entirely optional and
 * additive: omit it (or pass null) and this is byte-for-byte the same
 * pickDistinctIndices() call every pre-S6 caller already made.
 *
 * A failed or unavailable history lookup — no store/data/history.json yet,
 * a corrupt file, whatever — falls back to the plain rotation order rather
 * than throwing, so template selection behaves exactly as it did before S6
 * whenever history isn't usable (spec 4-1: "기록 조회가 실패하거나 파일이
 * 없으면 기존 시드 방식만 수행한다").
 *
 * @param {{channelId: string, platform: string, weeks?: number}} [historyContext]
 * @returns {{order: number[], warning: string|null}}
 */
function resolveRotationOrder(pool, setName, salt, historyContext) {
  if (!historyContext || !historyContext.channelId || !historyContext.platform) {
    return { order: pickDistinctIndices(setName, salt, pool.length, pool.length), warning: null };
  }
  let usedIds;
  try {
    usedIds = new Set(history.getUsedTemplateIds(historyContext.channelId, historyContext.platform, historyContext.weeks));
  } catch {
    return { order: pickDistinctIndices(setName, salt, pool.length, pool.length), warning: null };
  }
  if (usedIds.size === 0) {
    return { order: pickDistinctIndices(setName, salt, pool.length, pool.length), warning: null };
  }
  const { order, allExcluded } = pickDistinctIndicesExcluding(setName, salt, pool.length, (idx) => usedIds.has(pool[idx].id));
  const warning = allExcluded
    ? `${historyContext.platform} 템플릿이 최근 발행 기록 기준으로 전부 소진되어, 제외 없이 전체 풀에서 다시 선택합니다.`
    : null;
  return { order, warning };
}

/**
 * Picks ONE usable template via deterministic rotation (rotation.js), skips
 * any whose slots don't all resolve, and throws TemplatePoolError only when
 * literally none of them do — never substitutes a default sentence.
 *
 * @param {{channelId: string, platform: string, weeks?: number}} [historyContext] - TASK-S6, optional
 */
export function selectTemplate(templates, slots, setName, salt, filter = null, historyContext = null) {
  const pool = templates.filter((t) => matchesFilter(t, filter));
  if (pool.length === 0) {
    throw new TemplatePoolError(`조건에 맞는 템플릿이 없습니다 (filter=${JSON.stringify(filter)}).`);
  }
  const { order, warning } = resolveRotationOrder(pool, setName, salt, historyContext);
  const attempts = Math.min(order.length, MAX_TEMPLATE_ATTEMPTS);
  for (let i = 0; i < attempts; i += 1) {
    const template = pool[order[i]];
    const filled = fillSlots(template.text, slots);
    if (filled !== null) {
      return { id: template.id, text: filled, ...(warning ? { warning } : {}) };
    }
  }
  throw new TemplatePoolError('모든 템플릿의 슬롯을 채울 수 없어 사용할 템플릿이 없습니다.');
}

/**
 * Like selectTemplate(), but also enforces a platform character limit
 * (data/platformLimits.json) by retrying with the NEXT rotated template when
 * the filled text is too long — never by truncating a string (spec section
 * 5: "제한을 넘으면 잘라내지 말고 더 짧은 템플릿으로 재시도한다"). The
 * retry budget is capped at `maxRetries` (spec: 5) and only counts
 * over-limit attempts — a template skipped for an empty slot doesn't spend
 * a retry, since that's selectTemplate()'s ordinary skip behavior.
 * Returns { id, text, withinLimit: true } on success, or
 * { id: null, text: null, withinLimit: false } if nothing fit within the
 * retry budget (caller is expected to leave the field empty and warn).
 *
 * @param {{channelId: string, platform: string, weeks?: number}} [historyContext] - TASK-S6, optional
 */
export function selectTemplateWithinLimit(templates, slots, setName, salt, filter, options = {}, historyContext = null) {
  const { measure = (s) => s.length, maxLength = Infinity, maxRetries = 5 } = options;
  const pool = templates.filter((t) => matchesFilter(t, filter));
  if (pool.length === 0) {
    throw new TemplatePoolError(`조건에 맞는 템플릿이 없습니다 (filter=${JSON.stringify(filter)}).`);
  }
  const { order, warning } = resolveRotationOrder(pool, setName, salt, historyContext);
  const attempts = Math.min(order.length, MAX_TEMPLATE_ATTEMPTS);
  let retries = 0;
  for (let i = 0; i < attempts && retries < maxRetries; i += 1) {
    const template = pool[order[i]];
    const filled = fillSlots(template.text, slots);
    if (filled === null) continue;
    if (measure(filled) <= maxLength) {
      return { id: template.id, text: filled, withinLimit: true, ...(warning ? { warning } : {}) };
    }
    retries += 1;
  }
  return { id: null, text: null, withinLimit: false };
}

/**
 * TASK-S8 — like selectTemplateWithinLimit(), but also prefers a result that
 * clears a MINIMUM length (spec: "생성 결과가 최소 길이에 미달하면 더 긴
 * 템플릿으로 재시도한다"). A template that fits under maxLength but falls
 * short of minLength is kept as a fallback (never blanked — spec: "짧아도
 * 남기고 경고") while rotation keeps trying, within the same maxRetries
 * budget, for one that clears minLength too. Returns
 * `metMinLength: false` on the fallback case so the caller knows to warn.
 *
 * @param {{channelId: string, platform: string, weeks?: number}} [historyContext] - TASK-S6, optional
 */
export function selectTemplateWithMinMaxLength(templates, slots, setName, salt, filter, options = {}, historyContext = null) {
  const { measure = (s) => s.length, maxLength = Infinity, minLength = 0, maxRetries = 5 } = options;
  const pool = templates.filter((t) => matchesFilter(t, filter));
  if (pool.length === 0) {
    throw new TemplatePoolError(`조건에 맞는 템플릿이 없습니다 (filter=${JSON.stringify(filter)}).`);
  }
  const { order, warning } = resolveRotationOrder(pool, setName, salt, historyContext);
  const attempts = Math.min(order.length, MAX_TEMPLATE_ATTEMPTS);
  let fallback = null; // first template found that fit under maxLength, even if short of minLength
  let retries = 0;
  for (let i = 0; i < attempts && retries < maxRetries; i += 1) {
    const template = pool[order[i]];
    const filled = fillSlots(template.text, slots);
    if (filled === null) continue;
    const length = measure(filled);
    if (length > maxLength) { retries += 1; continue; }
    if (!fallback) fallback = { id: template.id, text: filled };
    if (length >= minLength) {
      return { id: template.id, text: filled, withinLimit: true, metMinLength: true, ...(warning ? { warning } : {}) };
    }
    retries += 1;
  }
  if (fallback) {
    return { id: fallback.id, text: fallback.text, withinLimit: true, metMinLength: false, ...(warning ? { warning } : {}) };
  }
  return { id: null, text: null, withinLimit: false, metMinLength: false };
}

/**
 * Picks up to `count` DISTINCT filled results (by rendered text) via
 * rotation — used for the 3 youtube title candidates. Never throws on a
 * shortfall (returns fewer than `count` if the pool can't supply more);
 * throws only if it can't fill even one.
 *
 * @param {{channelId: string, platform: string, weeks?: number}} [historyContext] - TASK-S6, optional
 */
export function selectDistinctTemplates(templates, slots, setName, salt, count, filter = null, historyContext = null) {
  const pool = templates.filter((t) => matchesFilter(t, filter));
  if (pool.length === 0) {
    throw new TemplatePoolError(`조건에 맞는 템플릿이 없습니다 (filter=${JSON.stringify(filter)}).`);
  }
  const { order } = resolveRotationOrder(pool, setName, salt, historyContext);
  const attempts = Math.min(order.length, MAX_TEMPLATE_ATTEMPTS);
  const results = [];
  const seenText = new Set();
  for (let i = 0; i < attempts && results.length < count; i += 1) {
    const template = pool[order[i]];
    const filled = fillSlots(template.text, slots);
    if (filled !== null && !seenText.has(filled)) {
      seenText.add(filled);
      results.push({ id: template.id, text: filled });
    }
  }
  if (results.length === 0) {
    throw new TemplatePoolError('모든 템플릿의 슬롯을 채울 수 없어 사용할 템플릿이 없습니다.');
  }
  return results;
}
