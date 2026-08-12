/**
 * TASK-S10 작업 C — gemini 모드. 기본 비활성(완료조건 10) — options.mode가
 * 명시적으로 'gemini'일 때만 이 파일의 함수가 호출된다. 그 안에서도
 * data/geminiConfig.json의 confirmed:true가 아니면 네트워크 호출을 아예
 * 시도하지 않고 local로 폴백한다 — 실제 무료 티어 한도를 Google AI
 * Studio 대시보드에서 확인하기 전에는 추정값으로 동작시키지 않는다(스펙
 * 작업 C: "추정값을 코드에 넣지 말고 실제 대시보드 값을 기록한다").
 *
 * lib/gemini.js(requireGeminiClient/withRetry)와 lib/keyStore.js(currentKey)를
 * 그대로 재사용한다 — CLAUDE.md 3.5: "Gemini 키는 lib/keyStore.js를 통해서만".
 * 이미 썸네일 생성(routes/thumbnail.js)이 쓰는 것과 같은 재시도/키 조회
 * 로직이므로 중복 구현하지 않는다.
 *
 * 한 번의 실행이 정확히 하나의 generateContent 호출만 만든다(반복문 없음)
 * — "세트 하나에 여러 번 부르지 않는다"는 스펙 요구사항을 코드 구조 자체로
 * 보장한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireGeminiClient, withRetry } from '../../../lib/gemini.js';
import { currentKey } from '../../../lib/keyStore.js';
import { renderPrompt } from './promptExport.js';
import { parseCandidateJson, mergeCandidateIntoTextpack } from './promptImport.js';
import { recordGeminiRequest, getTodayGeminiRequestCount } from '../store/geminiUsage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEMINI_CONFIG_PATH = path.join(__dirname, '..', 'data', 'geminiConfig.json');

function loadGeminiConfig() {
  const raw = fs.readFileSync(GEMINI_CONFIG_PATH, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

function fallback(localTextpack, warnings) {
  return { textpack: localTextpack, replaced: [], keptLocal: [], errors: [], usedFallback: true, warnings, requestCount: getTodayGeminiRequestCount() };
}

/**
 * @param {object} normalized - storyMaterial을 포함한 normalizeSetPack() 결과.
 * @param {object} localTextpack - 이미 생성된 local 모드 결과 (병합 기준이자 폴백 값).
 * @returns {Promise<{textpack, replaced, keptLocal, errors, usedFallback, warnings, requestCount}>}
 */
export async function runGeminiStorytelling(normalized, localTextpack) {
  const config = loadGeminiConfig();
  const warnings = [];

  if (!config.confirmed) {
    warnings.push(
      'Gemini 설정이 아직 확인되지 않았습니다 (data/geminiConfig.json의 confirmed:false) — 네트워크 호출 없이 local 결과를 사용합니다. Google AI Studio 대시보드(https://aistudio.google.com/rate-limit)에서 실제 무료 티어 한도를 확인한 뒤 이 파일을 채우세요.'
    );
    return fallback(localTextpack, warnings);
  }
  if (!config.model) {
    warnings.push('data/geminiConfig.json에 model이 설정되지 않았습니다 — local 결과를 사용합니다.');
    return fallback(localTextpack, warnings);
  }
  if (!currentKey()) {
    warnings.push('Gemini API 키가 설정되지 않았습니다 (lib/keyStore.js) — local 결과를 사용합니다.');
    return fallback(localTextpack, warnings);
  }

  // storyMaterial로 이미 추려진 자료만 전송한다(가사 전문 미전송) — promptExport.renderPrompt()가
  // 만드는 프롬프트 자체가 storyMaterial(최대 20행)과 곡 제목만 담고, 원본 lyrics 전문은
  // 넣지 않는다 (parse/storyMaterial.js 참조).
  const prompt = renderPrompt(normalized, localTextpack);

  let responseText;
  try {
    const ai = requireGeminiClient();
    const response = await withRetry(
      () => ai.models.generateContent({ model: config.model, contents: prompt }),
      { retries: config.maxRetries ?? 3 }
    );
    recordGeminiRequest();
    responseText = response?.text ?? response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } catch (error) {
    // 429(한도 초과)를 포함한 모든 호출 실패는 오류로 중단하지 않고 local로 폴백한다.
    warnings.push(`Gemini 호출에 실패해 local 결과로 대체합니다: ${error.message}`);
    return fallback(localTextpack, warnings);
  }

  let candidate;
  try {
    candidate = parseCandidateJson(responseText);
  } catch (error) {
    warnings.push(`Gemini 응답을 JSON으로 해석하지 못해 local 결과로 대체합니다: ${error.message}`);
    return fallback(localTextpack, warnings);
  }

  const { textpack, replaced, keptLocal, errors } = mergeCandidateIntoTextpack(candidate, localTextpack, normalized);
  textpack.mode = 'gemini';
  return { textpack, replaced, keptLocal, errors, usedFallback: false, warnings, requestCount: getTodayGeminiRequestCount() };
}

export function geminiStatus() {
  const config = loadGeminiConfig();
  return {
    confirmed: Boolean(config.confirmed),
    model: config.model,
    hasApiKey: Boolean(currentKey()),
    requestCountToday: getTodayGeminiRequestCount(),
  };
}
