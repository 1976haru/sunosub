/**
 * TASK-S1 — deterministic template rotation.
 *
 * There's no publish-history database yet (that's S6), so "rotation" here
 * means: hash `setName` (+ a per-slot salt) into an index. Same set run
 * twice picks the same templates (completion condition #5); a different
 * set's hash almost certainly lands on a different index (condition #6).
 * All rotation logic lives in this one file on purpose, so S6 can swap the
 * body of pickIndex() for a history-aware version without touching anything
 * that calls it.
 */

import crypto from 'node:crypto';

/** 32-bit unsigned int derived from sha256(`${setName}:${salt}`). Pure function — no I/O, no Math.random. */
export function hashToUint32(setName, salt = '') {
  const digest = crypto.createHash('sha256').update(`${setName}::${salt}`).digest();
  return digest.readUInt32BE(0);
}

/** Deterministic index in [0, length). Returns 0 for length <= 0. */
export function pickIndex(setName, salt, length) {
  if (!Number.isInteger(length) || length <= 0) return 0;
  return hashToUint32(setName, salt) % length;
}

/**
 * Returns `count` distinct indices into an array of `length` items, starting
 * from the deterministic pickIndex() position and walking forward. Used
 * where multiple *different* picks are needed from the same pool (e.g. 3
 * youtube title candidates) — walking is itself deterministic, so the same
 * setName always yields the same set of indices in the same order.
 * Bounded by `length` (can't return more distinct indices than exist).
 */
export function pickDistinctIndices(setName, salt, length, count) {
  if (!Number.isInteger(length) || length <= 0) return [];
  const start = pickIndex(setName, salt, length);
  const result = [];
  const seen = new Set();
  const cap = Math.min(count, length);
  for (let step = 0; step < length && result.length < cap; step += 1) {
    const idx = (start + step) % length;
    if (!seen.has(idx)) {
      seen.add(idx);
      result.push(idx);
    }
  }
  return result;
}

/**
 * TASK-S6 — like pickDistinctIndices, but skips indices the caller marks as
 * "excluded" (used to keep already-published templates out of rotation —
 * see store/history.js's getUsedTemplateIds and slotFiller.js's
 * historyContext parameter). If EVERY index is excluded, exclusion is
 * dropped entirely and the full, ordinary order is returned instead
 * (spec 4-1 step 4: an exhausted pool must never block generation) —
 * `allExcluded` tells the caller this happened so it can log a warning.
 *
 * A brand-new export, not a change to pickDistinctIndices' own behavior —
 * every existing caller of pickDistinctIndices is completely unaffected.
 *
 * @param {(index: number) => boolean} [isExcluded] - called with indices into [0, length)
 */
export function pickDistinctIndicesExcluding(setName, salt, length, isExcluded) {
  const fullOrder = pickDistinctIndices(setName, salt, length, length);
  if (typeof isExcluded !== 'function') return { order: fullOrder, allExcluded: false };

  const filtered = [];
  const scanCap = fullOrder.length; // explicit bound — fullOrder is already length-capped
  for (let i = 0; i < scanCap; i += 1) {
    if (!isExcluded(fullOrder[i])) filtered.push(fullOrder[i]);
  }
  if (filtered.length === 0) return { order: fullOrder, allExcluded: true };
  return { order: filtered, allExcluded: false };
}

/**
 * Rotates the starting offset used to slice a fixed-size window (e.g. 15 of
 * 45 pooled hashtags) out of a pool, so different sets pull a different
 * (but internally stable) slice.
 */
export function rotatedSlice(setName, salt, pool, windowSize) {
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const size = Math.min(windowSize, pool.length);
  const start = pickIndex(setName, salt, pool.length);
  const out = [];
  for (let i = 0; i < size; i += 1) {
    out.push(pool[(start + i) % pool.length]);
  }
  return out;
}
