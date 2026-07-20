import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, '..', '.gemini_key');

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

// Batch file injects GEMINI_API_KEY into the environment on first run, but
// `npm run dev`/direct `node server.js` invocations skip the batch file, so
// the server also loads .gemini_key itself as a fallback source of truth.
export function loadKeyIntoEnv() {
  if (clean(process.env.GEMINI_API_KEY)) return clean(process.env.GEMINI_API_KEY);
  const fileKey = readKeyFile();
  if (fileKey) process.env.GEMINI_API_KEY = fileKey;
  return fileKey;
}

export function currentKey() {
  return clean(process.env.GEMINI_API_KEY);
}
