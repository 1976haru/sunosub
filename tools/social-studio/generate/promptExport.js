/**
 * TASK-S10 작업 B (최우선) — export 모드: Claude Code/Codex에 붙여넣을
 * prompt.md를 만든다. 프롬프트 문구 자체는 templates/prompts/storytelling.
 * {ko,ja}.md에 있다 — 이 파일은 {{PLACEHOLDER}}를 세트별 데이터로 채우기만
 * 한다 (CLAUDE.md/스펙 금지사항: "프롬프트 문구를 코드에 하드코딩").
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEMPLATES_PROMPTS_DIR = path.join(ROOT, 'templates', 'prompts');
const BANNED_PHRASES_PATH = path.join(ROOT, 'data', 'bannedPhrases.json');
const PLATFORM_LIMITS_PATH = path.join(ROOT, 'data', 'platformLimits.json');
const OUT_ROOT = path.join(ROOT, 'out');

const MAX_SONGS_LISTED = 500; // setPackLoader.js의 MAX_SONGS_PER_SET과 동일한 상한
const MAX_SHORTS_LISTED = 500;

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

/** data/bannedPhrases.json의 _shared + channelId 전용 목록을 합친다 (lint/socialLint.js의 mergeBannedPhrases와 동일한 규칙). */
function mergeBannedPhrases(channelId) {
  const config = loadJson(BANNED_PHRASES_PATH);
  return [...(config._shared || []), ...(config[channelId] || [])];
}

function buildBannedPhrasesText(channelId) {
  const phrases = mergeBannedPhrases(channelId);
  if (phrases.length === 0) return '(등록된 금지 표현 없음)';
  return phrases.map((p) => `- ${p}`).join('\n');
}

function buildSongListText(normalized) {
  const lines = [];
  for (let i = 0; i < normalized.songs.length && i < MAX_SONGS_LISTED; i += 1) {
    const s = normalized.songs[i];
    const localized = s.titleLocalizedFallback ? '' : ` (${s.titleLocalized})`;
    lines.push(`${s.trackNo}. ${s.title}${localized}`);
  }
  return lines.join('\n');
}

function buildPlatformLimitsText() {
  const limits = loadJson(PLATFORM_LIMITS_PATH);
  return [
    `- 유튜브 제목: ${limits.youtube.titleMin}~${limits.youtube.titleMax}자, 후보 3개`,
    `- 유튜브 설명: 최대 ${limits.youtube.descMax}자`,
    `- 인스타그램 캡션: ${limits.instagram.captionMin}~${limits.instagram.captionMax}자`,
    `- X(트위터) 본문: ${limits.x.postMin}~${limits.x.postMax}자 (URL은 ${limits.x.urlLength}자로 계산)`,
    `- 페이스북 본문: 최소 ${limits.facebook.postMin}자`,
  ].join('\n');
}

/** localTextpack.shorts에 이미 정해진 트랙 번호만 스토리텔링 모드도 그대로 따른다 (병합 시 shorts[].trackNo가 어긋나지 않도록). */
function buildShortsTrackNosText(localTextpack) {
  const trackNos = (localTextpack?.shorts || []).slice(0, MAX_SHORTS_LISTED).map((s) => s.trackNo);
  return trackNos.length > 0 ? trackNos.join(', ') : '(없음)';
}

function loadTemplate(outputLanguage) {
  const fileName = outputLanguage === 'ja' ? 'storytelling.ja.md' : 'storytelling.ko.md';
  const filePath = path.join(TEMPLATES_PROMPTS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`스토리텔링 프롬프트 템플릿을 찾을 수 없습니다: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function fillTemplate(template, values) {
  let filled = template;
  for (const [key, value] of Object.entries(values)) {
    filled = filled.split(`{{${key}}}`).join(value);
  }
  return filled;
}

/**
 * @param {object} normalized - normalizeSetPack()의 결과 (set.storyMaterial 포함해야 함).
 * @param {object} localTextpack - 같은 세트를 local 모드로 먼저 생성한 결과 (shorts 트랙 번호 정렬용).
 * @returns {string} 채워진 프롬프트 마크다운 전문.
 */
export function renderPrompt(normalized, localTextpack) {
  if (!normalized.set.storyMaterial) {
    throw new Error('normalized.set.storyMaterial이 없습니다 — setPackLoader.js가 먼저 실행되어야 합니다.');
  }
  const template = loadTemplate(normalized.set.outputLanguage);
  return fillTemplate(template, {
    CHANNEL_LABEL: normalized.set.channelLabel,
    CONCEPT_LABEL: normalized.set.conceptLabel || normalized.set.channelLabel,
    SET_NAME: normalized.set.setName,
    SONG_COUNT: String(normalized.songs.length),
    BANNED_PHRASES: buildBannedPhrasesText(normalized.set.channelId),
    SONG_LIST: buildSongListText(normalized),
    STORY_MATERIAL_JSON: JSON.stringify(normalized.set.storyMaterial, null, 2),
    PLATFORM_LIMITS: buildPlatformLimitsText(),
    SHORTS_TRACK_NOS: buildShortsTrackNosText(localTextpack),
  });
}

/** out/{setName}/prompt.md로 저장한다. */
export function writePromptFile(normalized, localTextpack) {
  const prompt = renderPrompt(normalized, localTextpack);
  const outDir = path.join(OUT_ROOT, normalized.set.setName);
  fs.mkdirSync(outDir, { recursive: true });
  const promptPath = path.join(outDir, 'prompt.md');
  fs.writeFileSync(promptPath, prompt, 'utf8');
  return { prompt, promptPath };
}
