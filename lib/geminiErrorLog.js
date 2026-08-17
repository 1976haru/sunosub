/*
 * TASK 후속 (이어서 번역 실패 원인 불명) — Gemini 호출 실패가 console.error로만
 * 나가서 터미널을 닫으면 증거가 사라졌다. lib/gemini.js의 withRetry가
 * 재시도할 때마다(429/5xx/기타, 성공 여부와 무관하게 매 실패 시도) 여기로
 * 기록하고, routes/yt.js는 "truncated"(응답은 왔지만 언어가 빠짐) 케이스를
 * 같은 파일에 같은 형식으로 남긴다 — 두 원인을 한곳에서 구분할 수 있어야
 * 하기 때문이다. 파일을 lib/gemini.js와 분리한 이유: routes/yt.js가
 * truncated를 기록하려면 이 로거를 직접 import해야 하는데, lib/gemini.js
 * 자체를 다시 import하게 하면 관심사가 섞인다(재시도 로직과 로깅은 다른
 * 책임).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', '.gemini_errors.log');

const MAX_BYTES = 5 * 1024 * 1024;
const RESPONSE_SNIPPET_MAX = 200;

// TASK 후속 — 응답 스니펫에 API 키처럼 보이는 긴 임의 문자열이 섞여 들어갈
// 가능성을 방어적으로 차단한다(CLAUDE.md 3.5: 키 값을 로그에 절대 노출하지
// 않는다). Gemini 응답 자체가 요청 키를 반환하는 경우는 없지만, "절대"
// 원칙이라 로그로 나가는 모든 텍스트에 동일하게 적용한다.
function redactSecrets(text) {
  return String(text || '').replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]');
}

function snippet(text) {
  const redacted = redactSecrets(text);
  return redacted.length > RESPONSE_SNIPPET_MAX ? `${redacted.slice(0, RESPONSE_SNIPPET_MAX)}…` : redacted;
}

/*
 * TASK 후속 — 오래된 것부터 잘라낸다. 5MB를 넘을 때마다 파일 전체를 다시
 * 읽어야 하지만, 로컬 개발 도구의 저빈도 에러 로그라 부담이 없다. 절반만
 * 남기는 이유는 "5MB를 살짝 넘을 때마다 매번 다시 자르는" 낭비를 피하기
 * 위해서다.
 */
function trimIfTooBig() {
  let stat;
  try {
    stat = fs.statSync(LOG_PATH);
  } catch {
    return; // 파일이 아직 없으면 자를 것도 없다
  }
  if (stat.size <= MAX_BYTES) return;
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const keepFrom = Math.floor(lines.length / 2);
    fs.writeFileSync(LOG_PATH, `${lines.slice(keepFrom).join('\n')}\n`, 'utf8');
  } catch {
    // 자르기 자체가 실패해도 실제 요청 흐름을 막을 이유는 아니다 — 다음 기록에서 다시 시도된다.
  }
}

/**
 * @param {object} entry - at은 이 함수가 채운다. 나머지는 호출부가 채운다.
 *   공통: label, tier, scope, languageCount, status, type('quota'|'server'|'truncated'|'other')
 *   quota/server/other: retryDelayMs, attempt, maxRetries, responseSnippet
 *   truncated: missingCount, responseSnippet
 */
export function logGeminiError(entry) {
  try {
    trimIfTooBig();
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // 로그 실패가 실제 Gemini 요청/응답 흐름을 막으면 안 된다 — 조용히 넘어간다.
  }
}

export { snippet as snippetForLog };
