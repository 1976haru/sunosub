import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateNonceBytes, computeDigest, buildWsseHeader, maskSecret } from '../publish/wsse.js';

// Fixed fixture values — computed independently via a standalone Node script
// (documented in the completion report) so this test file itself doesn't
// have to "prove itself" using the same code it's testing.
const FIXED_NONCE = Buffer.from('fixed-test-nonce-001', 'utf8');
const FIXED_CREATED = '2026-08-05T12:00:00Z';
const FIXED_API_KEY = 'test-api-key-secret-value';
const EXPECTED_DIGEST_CORRECT = 'KE17N8eTRbVBPa0h778X3W8/3YI=';

// --- completion condition 2 ---

test('condition 2: computeDigest on a fixed nonce/created/apiKey matches the expected precomputed value', () => {
  const digest = computeDigest(FIXED_NONCE, FIXED_CREATED, FIXED_API_KEY);
  assert.equal(digest, EXPECTED_DIGEST_CORRECT);
});

test('condition 2: hashing the base64 NONCE STRING instead of raw bytes produces a DIFFERENT digest (the bug the spec warned about)', () => {
  const correct = computeDigest(FIXED_NONCE, FIXED_CREATED, FIXED_API_KEY);

  // The wrong implementation: treat the base64-encoded nonce as the hash input.
  const nonceBase64String = FIXED_NONCE.toString('base64');
  const wrongDigest = computeDigest(Buffer.from(nonceBase64String, 'utf8'), FIXED_CREATED, FIXED_API_KEY);

  assert.notEqual(correct, wrongDigest, 'raw-bytes digest and base64-string digest must differ, or the implementation is hashing the wrong thing');
});

test('computeDigest rejects a non-Buffer nonce (guards against accidentally passing the base64 string)', () => {
  assert.throws(() => computeDigest('not-a-buffer', FIXED_CREATED, FIXED_API_KEY), TypeError);
});

test('computeDigest is deterministic for the same inputs', () => {
  assert.equal(
    computeDigest(FIXED_NONCE, FIXED_CREATED, FIXED_API_KEY),
    computeDigest(FIXED_NONCE, FIXED_CREATED, FIXED_API_KEY)
  );
});

test('computeDigest changes if any one input changes', () => {
  const base = computeDigest(FIXED_NONCE, FIXED_CREATED, FIXED_API_KEY);
  assert.notEqual(base, computeDigest(Buffer.from('different-nonce', 'utf8'), FIXED_CREATED, FIXED_API_KEY));
  assert.notEqual(base, computeDigest(FIXED_NONCE, '2026-01-01T00:00:00Z', FIXED_API_KEY));
  assert.notEqual(base, computeDigest(FIXED_NONCE, FIXED_CREATED, 'different-key'));
});

// --- buildWsseHeader ---

test('buildWsseHeader produces the UsernameToken format with the base64 Nonce (not raw bytes) in the header', () => {
  const { header, nonceBytes, created } = buildWsseHeader({ username: 'testuser', apiKey: FIXED_API_KEY, created: FIXED_CREATED, nonceBytes: FIXED_NONCE });
  assert.match(header, /^UsernameToken Username="testuser", PasswordDigest="[^"]+", Nonce="[^"]+", Created="2026-08-05T12:00:00Z"$/);
  assert.ok(header.includes(FIXED_NONCE.toString('base64')));
  assert.equal(nonceBytes, FIXED_NONCE);
  assert.equal(created, FIXED_CREATED);
});

test('buildWsseHeader embeds the correct digest computed the same way computeDigest does', () => {
  const { header } = buildWsseHeader({ username: 'testuser', apiKey: FIXED_API_KEY, created: FIXED_CREATED, nonceBytes: FIXED_NONCE });
  assert.ok(header.includes(EXPECTED_DIGEST_CORRECT));
});

test('generateNonceBytes returns 16 raw bytes, different each call', () => {
  const a = generateNonceBytes();
  const b = generateNonceBytes();
  assert.ok(Buffer.isBuffer(a));
  assert.equal(a.length, 16);
  assert.notEqual(a.toString('hex'), b.toString('hex'));
});

// --- maskSecret (completion condition #8's building block) ---

test('maskSecret never contains any character from the original secret', () => {
  const secret = 'super-secret-api-key-value';
  const masked = maskSecret(secret);
  assert.ok(!masked.includes(secret));
  assert.match(masked, /^\*+$/, 'masked output should be asterisks only, no leaked characters');
});

test('maskSecret on empty/undefined does not throw', () => {
  assert.equal(maskSecret(''), '(empty)');
  assert.equal(maskSecret(undefined), '(empty)');
});
