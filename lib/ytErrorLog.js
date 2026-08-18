/*
 * TASK CS-v2.3 — youtubeApi()가 4xx/5xx를 받으면 지금까지는 data.error.message
 * 한 줄만 남기고 data.error.errors[]({reason, location, locationType, message})를
 * 버렸다. "The request metadata is invalid." 같은 총괄 메시지만으로는 title이
 * 문제인지 tags가 문제인지 알 방법이 없었다. lib/geminiErrorLog.js와 같은
 * 모양으로 별도 파일에 남기는 이유도 동일하다: routes/yt.js와 lib/ytOAuth.js가
 * 이 로거만 가져다 쓰면 되고, 실제 요청/재시도 로직과 로깅 책임이 섞이지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', '.yt_errors.log');

const MAX_BYTES = 5 * 1024 * 1024;

// CLAUDE.md 3.5와 같은 원칙: 로그로 나가는 텍스트에서도 키·토큰처럼 보이는
// 긴 임의 문자열은 남기지 않는다. YouTube 에러 응답이 액세스 토큰을 그대로
// 되돌려주는 경우는 없지만 "절대" 원칙이라 방어적으로 동일하게 적용한다.
function redactSecrets(text) {
  return String(text || '').replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]');
}

function trimIfTooBig() {
  let stat;
  try {
    stat = fs.statSync(LOG_PATH);
  } catch {
    return;
  }
  if (stat.size <= MAX_BYTES) return;
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const keepFrom = Math.floor(lines.length / 2);
    fs.writeFileSync(LOG_PATH, `${lines.slice(keepFrom).join('\n')}\n`, 'utf8');
  } catch {
    // 자르기 실패가 실제 요청 흐름을 막을 이유는 아니다.
  }
}

/**
 * @param {object} entry - at은 이 함수가 채운다.
 *   pathname, method, status, message, errors(구글 원본 errors[] 배열 그대로)
 */
export function logYtApiError(entry) {
  try {
    trimIfTooBig();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
      message: redactSecrets(entry?.message),
      errors: Array.isArray(entry?.errors)
        ? entry.errors.map((e) => ({ ...e, message: redactSecrets(e?.message) }))
        : entry?.errors,
    });
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // 로그 실패가 실제 YouTube 요청 흐름을 막으면 안 된다.
  }
}
