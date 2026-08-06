/**
 * TASK-S5 — the only place in social-studio that makes a real HTTP request.
 * Every other tool in this project has "0 external network calls" as a
 * completion condition; this file is the one exception, and only ever runs
 * when the caller explicitly passed --publish (see publish/hatena.js).
 *
 * 4xx responses are never retried (the request itself is wrong — retrying
 * just repeats the same failure); 5xx and 429 retry up to
 * hatenaConfig.json's retry.maxAttempts, waiting retry.backoffMs[attempt]
 * between tries.
 */

import { extractEntryUrl } from './hatenaAtom.js';

const MAX_RETRY_LOOP_BOUND = 20; // explicit hard ceiling regardless of config (completion condition #13)

export class HatenaHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HatenaHttpError';
    this.status = status;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} params
 * @param {string} params.endpoint
 * @param {string} params.xml
 * @param {string} params.wsseHeader - full X-WSSE header value (already built by wsse.js)
 * @param {{maxAttempts:number, backoffMs:number[]}} params.retryConfig
 * @param {typeof fetch} [params.fetchImpl] - injectable for tests; defaults to global fetch
 * @returns {Promise<{status:number, entryUrl:string|null, attempts:number, rawBody:string}>}
 */
export async function postEntry({ endpoint, xml, wsseHeader, retryConfig, fetchImpl = fetch }) {
  const maxAttempts = Math.min(retryConfig.maxAttempts, MAX_RETRY_LOOP_BOUND);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'X-WSSE': wsseHeader,
        },
        body: xml,
      });
    } catch (networkError) {
      lastError = networkError;
      if (attempt < maxAttempts) {
        await sleep(retryConfig.backoffMs[Math.min(attempt - 1, retryConfig.backoffMs.length - 1)] || 1000);
        continue;
      }
      throw new HatenaHttpError(`네트워크 오류로 요청에 실패했습니다: ${networkError.message}`, {});
    }

    const rawBody = await response.text();

    if (response.status >= 200 && response.status < 300) {
      return { status: response.status, entryUrl: extractEntryUrl(rawBody), attempts: attempt, rawBody };
    }

    // 429 sits inside the 4xx numeric range but means "rate limited, try
    // again later" — the opposite of "this request is wrong" — so it must
    // NOT go down the no-retry 4xx path below. Caught by a test asserting
    // an actual retry count, not just by re-reading this range check.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      // 요청 자체가 잘못됨 — 재시도하지 않는다 (spec 완료조건 #11).
      throw new HatenaHttpError(`하테나 API가 요청을 거부했습니다 (${response.status}). 재시도하지 않습니다.`, {
        status: response.status,
        body: rawBody,
      });
    }

    // 5xx 또는 429 — 재시도 대상.
    lastError = new HatenaHttpError(`하테나 API 오류 (${response.status})`, { status: response.status, body: rawBody });
    if (attempt < maxAttempts) {
      await sleep(retryConfig.backoffMs[Math.min(attempt - 1, retryConfig.backoffMs.length - 1)] || 1000);
    }
  }

  throw lastError || new HatenaHttpError('알 수 없는 오류로 요청에 실패했습니다.', {});
}
