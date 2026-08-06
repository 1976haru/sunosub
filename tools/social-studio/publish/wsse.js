/**
 * TASK-S5 — WSSE authentication for Hatena Blog's AtomPub API.
 *
 * Formula confirmed against the official spec
 * (https://developer.hatena.ne.jp/ja/documents/auth/apis/wsse, fetched
 * during implementation): "Nonce, Created, APIキーを文字列連結しSHA1
 * アルゴリズムでダイジェスト化して生成されたオクテット列を、Base64エンコード"
 * — concatenate Nonce + Created + API key, SHA1, then Base64 the digest.
 *
 * The one bug this project's own spec warned about by name: Nonce here
 * means the RAW random bytes, not the base64 string that goes in the
 * header's own Nonce="" field. Hashing the base64 *string* instead of the
 * raw bytes is a different (wrong) digest that may look plausible and fail
 * unpredictably — see wsse.test.js for a fixed fixture proving the two are
 * different values.
 */

import crypto from 'node:crypto';

const NONCE_BYTE_LENGTH = 16;

/** A fresh random nonce as raw bytes (NOT base64) — this is what goes into the SHA1 input. */
export function generateNonceBytes() {
  return crypto.randomBytes(NONCE_BYTE_LENGTH);
}

/**
 * @param {Buffer} nonceBytes - RAW bytes, not a base64 string
 * @param {string} created - ISO8601 timestamp string, exactly as it will appear in the Created="" field
 * @param {string} apiKey
 * @returns {string} base64-encoded SHA1 digest
 */
export function computeDigest(nonceBytes, created, apiKey) {
  if (!Buffer.isBuffer(nonceBytes)) {
    throw new TypeError('computeDigest: nonceBytes must be a Buffer of raw bytes, not a base64 string.');
  }
  const hash = crypto.createHash('sha1');
  hash.update(nonceBytes);
  hash.update(Buffer.from(created, 'utf8'));
  hash.update(Buffer.from(apiKey, 'utf8'));
  return hash.digest('base64');
}

/**
 * Builds the X-WSSE header VALUE (a single line — the multi-line form in
 * the spec's own example is just for readability, not literal transport
 * format).
 * @returns {{header: string, nonceBytes: Buffer, created: string}}
 */
export function buildWsseHeader({ username, apiKey, created, nonceBytes }) {
  const nonce = nonceBytes || generateNonceBytes();
  const digest = computeDigest(nonce, created, apiKey);
  const nonceBase64 = nonce.toString('base64');
  const header = `UsernameToken Username="${username}", PasswordDigest="${digest}", Nonce="${nonceBase64}", Created="${created}"`;
  return { header, nonceBytes: nonce, created };
}

/** Never let a real key value reach a log line, error message, or report file (spec section 3 + completion condition #8). */
export function maskSecret(value) {
  if (!value) return '(empty)';
  return '*'.repeat(Math.min(8, value.length));
}
