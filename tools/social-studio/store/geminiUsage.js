/**
 * TASK-S10 작업 C — "오늘 사용한 요청 수" 표시용 카운터. 썸네일 생성용
 * Gemini 키와 같은 키를 공유하되(CLAUDE.md 3.5), 호출 수는 이 카운터로
 * social-studio 쪽만 별도 합산한다 — 다른 도구(썸네일)의 호출까지 이
 * 파일이 셀 필요는 없다(호출부가 다르므로 계정 전체 총량은 Google AI
 * Studio 대시보드가 진실의 원천이다. 이 카운터는 "오늘 이 화면에서 몇 번
 * 눌렀는지"를 사용자에게 보여주는 참고용).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './atomicWrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const USAGE_PATH = path.join(DATA_DIR, 'geminiUsage.json');

function loadUsage() {
  if (!fs.existsSync(USAGE_PATH)) return { version: 1, days: {} };
  try {
    const raw = fs.readFileSync(USAGE_PATH, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    if (!data || typeof data.days !== 'object' || data.days === null) return { version: 1, days: {} };
    return data;
  } catch {
    return { version: 1, days: {} }; // 손상된 카운터 파일은 표시용 데이터이므로 조용히 초기화(history.json과 달리 백업할 가치가 없음)
  }
}

function todayKey(now) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function recordGeminiRequest(now = new Date()) {
  const usage = loadUsage();
  const key = todayKey(now);
  usage.days[key] = (usage.days[key] || 0) + 1;
  atomicWriteJson(USAGE_PATH, usage);
  return usage.days[key];
}

export function getTodayGeminiRequestCount(now = new Date()) {
  const usage = loadUsage();
  return usage.days[todayKey(now)] || 0;
}
