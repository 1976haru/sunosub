import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToUint32, pickIndex, pickDistinctIndices, rotatedSlice } from '../generate/rotation.js';

test('hashToUint32 is deterministic for the same input', () => {
  assert.equal(hashToUint32('set-a', 'salt-1'), hashToUint32('set-a', 'salt-1'));
});

test('hashToUint32 differs across salts for the same setName (independent rotation per slot)', () => {
  assert.notEqual(hashToUint32('set-a', 'salt-1'), hashToUint32('set-a', 'salt-2'));
});

test('pickIndex always lands inside [0, length)', () => {
  for (let length = 1; length <= 20; length += 1) {
    const idx = pickIndex('some-set-name', 'salt', length);
    assert.ok(idx >= 0 && idx < length, `index ${idx} out of range for length ${length}`);
  }
});

test('pickIndex returns 0 for a non-positive length instead of throwing', () => {
  assert.equal(pickIndex('x', 'y', 0), 0);
  assert.equal(pickIndex('x', 'y', -3), 0);
});

test('pickIndex is deterministic: same setName+salt+length always picks the same index', () => {
  const a = pickIndex('20260804_굿모닝추억라디오_70년대감성', 'yt-title', 12);
  const b = pickIndex('20260804_굿모닝추억라디오_70년대감성', 'yt-title', 12);
  assert.equal(a, b);
});

test('pickIndex differs for two different setNames (completion condition #6 mechanism)', () => {
  const a = pickIndex('20260804_굿모닝추억라디오_70년대감성', 'yt-title', 12);
  const b = pickIndex('20261225_굿모닝추억라디오_크리스마스', 'yt-title', 12);
  assert.notEqual(a, b, 'these two concrete setNames happen to hash to the same index — pick different examples');
});

test('pickDistinctIndices returns unique indices, capped by both count and length', () => {
  const result = pickDistinctIndices('set-x', 'salt', 5, 100);
  assert.equal(result.length, 5);
  assert.equal(new Set(result).size, 5);
  for (const i of result) assert.ok(i >= 0 && i < 5);
});

test('pickDistinctIndices is a deterministic walk: same inputs -> same order', () => {
  const a = pickDistinctIndices('set-y', 'salt', 10, 4);
  const b = pickDistinctIndices('set-y', 'salt', 10, 4);
  assert.deepEqual(a, b);
});

test('rotatedSlice returns a window of the requested size, wrapping around the pool', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  const slice = rotatedSlice('set-z', 'salt', pool, 8); // larger than pool — must wrap, not throw
  assert.equal(slice.length, 5); // capped at pool.length
});

test('rotatedSlice on an empty pool returns an empty array, not an error', () => {
  assert.deepEqual(rotatedSlice('set-z', 'salt', [], 5), []);
});

test('rotatedSlice is deterministic for the same setName', () => {
  const pool = Array.from({ length: 20 }, (_, i) => `tag${i}`);
  const a = rotatedSlice('set-w', 'yt-hashtags', pool, 15);
  const b = rotatedSlice('set-w', 'yt-hashtags', pool, 15);
  assert.deepEqual(a, b);
});
