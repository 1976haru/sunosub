import { GoogleGenAI } from '@google/genai';
import { currentKey } from './keyStore.js';

export function requireGeminiClient() {
  const apiKey = currentKey();
  if (!apiKey) {
    const error = new Error('Gemini API 키가 설정되지 않았습니다. 상단 배지에서 키를 입력해 주세요.');
    error.status = 400;
    error.needsKey = true;
    throw error;
  }
  return new GoogleGenAI({ apiKey });
}

function isRateLimitError(error) {
  const status = Number(error?.status || error?.code || 0);
  if (status === 429) return true;
  const message = String(error?.message || '');
  return /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
}

// Gemini's free tier enforces a low requests-per-minute limit. Retry a couple
// of times with exponential backoff before surfacing a friendly error.
export async function withRetry(fn, { retries = 2, baseDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  if (isRateLimitError(lastError)) {
    const error = new Error('Gemini 무료 한도(분당 요청 제한)에 도달했습니다. 잠시 후 다시 시도해 주세요.');
    error.status = 429;
    throw error;
  }
  throw lastError;
}
