/**
 * TASK-S10 작업 D — 환각 차단 (export/gemini 모드가 만든 텍스트 검사).
 *
 * local 모드는 generate/textPack.js의 checkField()/checkTitleProvenance()가
 * 이미 연도·미번역 영어 유출·조사 중복을 검사한다(TASK-S1/S8). 이 모듈은
 * 그것을 대체하지 않는다 — 언어 모델이 개입하는 export/gemini 모드 전용으로
 * *추가되는* 검사다: 곡명 출처, 아티스트 실명, 가사 인용 진위, 곡 수 일치,
 * 차트/판매량/수상 같은 사실 주장 차단.
 *
 * 이 파일은 순수 검사만 한다 — "실패한 필드를 local 값으로 되돌리고 errors에
 * 기록"하는 병합 판단은 호출자(generate/promptImport.js, generate/geminiClient.js)
 * 의 몫이다. 그래야 두 호출자가 서로 다른 병합 정책(예: gemini는 폴백을
 * 자동으로, export는 가져오기 화면에 표시)을 가져도 이 모듈은 그대로 재사용된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTUAL_CLAIM_KEYWORDS_PATH = path.join(__dirname, '..', 'data', 'factualClaimKeywords.json');

// 명시적 반복 상한 (완료조건 13).
const MAX_QUOTE_SPANS = 200;
const MAX_CAPITALIZED_TOKENS = 500;
const MAX_LYRICS_JOIN_SONGS = 500;
const MAX_SHORTS_ITEMS = 500;
const MAX_THREAD_ITEMS = 200;
const MAX_TITLES_ITEMS = 50;

// 플랫폼/서비스 이름은 대문자로 시작하는 영어 토큰이지만 아티스트 실명이
// 아니다 — 오탐(false positive)을 막기 위한 최소한의 예외. "새어 나가는"
// 인명 목록(금지 아티스트 이름 리스트)과는 다른 것: 이건 채널이 정상적으로
// 언급하는 자기 브랜드/플랫폼 이름이다.
const ALLOWED_CAPITALIZED_WORDS = new Set([
  'YouTube', 'Instagram', 'Facebook', 'TikTok', 'Naver', 'Hatena', 'X', 'AM', 'FM', 'PM',
]);

let factualClaimKeywordsCache = null;

function loadFactualClaimKeywords() {
  if (factualClaimKeywordsCache) return factualClaimKeywordsCache;
  const raw = fs.readFileSync(FACTUAL_CLAIM_KEYWORDS_PATH, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  factualClaimKeywordsCache = (data.keywords || []).map((k) => k.toLowerCase());
  return factualClaimKeywordsCache;
}

function extractYears(text) {
  return new Set(String(text ?? '').match(/\b(?:19|20)\d{2}\b/g) || []);
}

/**
 * 입력 데이터(정답 세트)에서 검사에 필요한 사실 정보를 모은다. 세 모드가
 * 매번 같은 계산을 반복하지 않도록 한 번만 만들어 재사용한다.
 */
export function buildHallucinationFacts(normalized) {
  const validTitles = new Set();
  const allowedCapitalizedTokens = new Set([...ALLOWED_CAPITALIZED_WORDS]);
  const inputYears = new Set();
  const lyricsCorpus = [];

  for (const w of String(normalized.set.channelLabel || '').match(/[A-Za-z][A-Za-z'-]*/g) || []) {
    allowedCapitalizedTokens.add(w);
  }
  for (const y of extractYears(normalized.set.channelLabel || '')) inputYears.add(y);
  for (const y of extractYears(normalized.set.conceptLabel || '')) inputYears.add(y);
  for (const y of extractYears(normalized.set.setName || '')) inputYears.add(y);

  const songs = normalized.songs.slice(0, MAX_LYRICS_JOIN_SONGS);
  for (const s of songs) {
    validTitles.add(s.title);
    validTitles.add(s.titleLocalized);
    lyricsCorpus.push({ trackNo: s.trackNo, text: s.lyrics || '' });
    for (const y of extractYears(s.title)) inputYears.add(y);
    for (const y of extractYears(s.lyrics)) inputYears.add(y);
    for (const y of extractYears(s.listenerSituation?.raw)) inputYears.add(y);
    // 곡 제목/가사 안의 대문자 시작 단어는 이미 입력에 존재하는 고유명사이므로
    // 아티스트 실명 오탐에서 제외한다 (예: 곡 제목 "Morning Kettle Waltz"의
    // "Morning"/"Kettle"/"Waltz").
    for (const w of `${s.title} ${s.lyrics}`.match(/[A-Z][A-Za-z'-]*/g) || []) {
      allowedCapitalizedTokens.add(w);
      if (allowedCapitalizedTokens.size >= MAX_CAPITALIZED_TOKENS) break;
    }
  }

  return {
    validTitles,
    allowedCapitalizedTokens,
    inputYears,
    lyricsCorpus,
    trackCount: normalized.songs.length,
  };
}

// ---------------------------------------------------------------------------
// 개별 검사
// ---------------------------------------------------------------------------

/** "…", "…", '…' 로 감싼 인용구를 찾는다. 너무 짧은(3자 미만) 인용은 잡음이 많아 제외. */
function findQuotedSpans(text) {
  const pattern = /["“”'‘’]([^"“”'‘’]{3,200})["“”'‘’]/g;
  const spans = [];
  let match;
  let iterations = 0;
  while ((match = pattern.exec(text)) && iterations < MAX_QUOTE_SPANS) {
    iterations += 1;
    spans.push(match[1]);
  }
  return spans;
}

function checkYears(text, facts) {
  const errors = [];
  for (const year of extractYears(text)) {
    if (!facts.inputYears.has(year)) {
      errors.push(`입력 데이터에 없는 연도(${year})가 출력에 등장했습니다.`);
    }
  }
  return errors;
}

/**
 * 아티스트 실명 검출 — 목록 방식이 아니라 "입력에 없는 대문자 시작 인명형
 * 토큰"을 잡는다 (스펙 요구사항: 목록 방식은 반드시 새어 나간다). 1~2단어
 * 연속 Title-Case 시퀀스를 후보로 보고, allowedCapitalizedTokens(곡
 * 제목/가사/채널명에 이미 등장한 단어 + 플랫폼 이름)에 없으면 차단한다.
 */
function checkArtistNameLeak(text, facts) {
  const errors = [];
  const pattern = /\b([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\b/g;
  let match;
  let iterations = 0;
  while ((match = pattern.exec(text)) && iterations < MAX_CAPITALIZED_TOKENS) {
    iterations += 1;
    const first = match[1];
    const second = match[2] || null;
    if (facts.allowedCapitalizedTokens.has(first) && (!second || facts.allowedCapitalizedTokens.has(second))) continue;
    const full = second ? `${first} ${second}` : first;
    errors.push(`입력 데이터에 없는 인명형 표현 "${full}"이 출력에 등장했습니다 — 아티스트 실명일 가능성으로 차단합니다.`);
  }
  return errors;
}

/** 인용부호로 감싼 문장이 실제 가사(원문) 안의 실존 문자열인지 확인한다. */
function checkLyricQuotes(text, facts) {
  const errors = [];
  for (const quote of findQuotedSpans(text)) {
    const foundIn = facts.lyricsCorpus.find((l) => l.text.includes(quote));
    if (!foundIn) {
      errors.push(`가사 원문에 없는 인용입니다: "${quote}"`);
    }
  }
  return errors;
}

/** "18곡", "총 18곡" 같은 곡 수 언급이 실제 트랙 수와 일치하는지 확인한다. */
function checkSongCountMentions(text, facts) {
  const errors = [];
  const pattern = /(\d{1,3})\s*곡/g;
  let match;
  let iterations = 0;
  while ((match = pattern.exec(text)) && iterations < MAX_QUOTE_SPANS) {
    iterations += 1;
    const n = Number(match[1]);
    if (n !== facts.trackCount) {
      errors.push(`언급된 곡 수(${n}곡)가 실제 곡 수(${facts.trackCount}곡)와 다릅니다.`);
    }
  }
  return errors;
}

function checkFactualClaims(text) {
  const errors = [];
  const lower = text.toLowerCase();
  for (const keyword of loadFactualClaimKeywords()) {
    if (lower.includes(keyword)) {
      errors.push(`차트/판매량/수상 등 입력에 없는 사실 주장으로 보이는 표현("${keyword}")이 출력에 등장했습니다.`);
    }
  }
  return errors;
}

/**
 * HTML 필드(naver.bodyHtml)에서 태그/주석을 제거한 뒤 검사한다 —
 * generate/textPack.js의 checkField(isHtml)와 동일한 이유.
 */
function stripHtml(text) {
  return text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
}

/**
 * 필드 하나를 검사한다. `opts.skipArtistCheck`/`skipFactualCheck`는
 * x.lyricQuote처럼 원문 그대로 통과해야 하는 필드용 예외.
 */
export function checkHallucinationField(text, facts, opts = {}) {
  if (!text) return { ok: true, errors: [] };
  const scanText = opts.isHtml ? stripHtml(text) : text;
  const errors = [
    ...checkYears(scanText, facts),
    ...checkLyricQuotes(scanText, facts),
    ...checkSongCountMentions(scanText, facts),
  ];
  if (!opts.skipArtistCheck) errors.push(...checkArtistNameLeak(scanText, facts));
  if (!opts.skipFactualCheck) errors.push(...checkFactualClaims(scanText));
  return { ok: errors.length === 0, errors };
}

/** meta.songTitlesUsed(있다면)를 입력 곡 목록과 대조한다. */
export function checkSongTitleProvenance(songTitlesUsed, facts) {
  const errors = [];
  if (!Array.isArray(songTitlesUsed)) return errors;
  for (let i = 0; i < songTitlesUsed.length && i < MAX_TITLES_ITEMS; i += 1) {
    const title = songTitlesUsed[i];
    if (!facts.validTitles.has(title)) {
      errors.push(`곡명 검사: 입력 데이터에 없는 곡 제목 "${title}"이 출력에 등장했습니다.`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// candidate textpack 전체 스캔 — export/gemini 모드가 만든 후보 JSON을 받아
// 필드별 결과를 돌려준다. 병합(로컬 폴백) 판단은 호출자가 한다.
// ---------------------------------------------------------------------------

/**
 * @param {object} candidate - export/gemini가 만든 candidate textpack(전체 또는 일부).
 * @param {object} facts - buildHallucinationFacts(normalized)의 결과.
 * @returns {{fieldResults: Array<{path:string, ok:boolean, errors:string[]}>, allErrors: string[]}}
 */
export function scanCandidateTextpack(candidate, facts) {
  const fieldResults = [];

  function check(path_, text, opts) {
    if (text === undefined || text === null) return;
    const result = checkHallucinationField(String(text), facts, opts);
    fieldResults.push({ path: path_, ok: result.ok, errors: result.errors });
  }

  if (candidate.youtube) {
    const titles = Array.isArray(candidate.youtube.titles) ? candidate.youtube.titles.slice(0, MAX_TITLES_ITEMS) : [];
    titles.forEach((t, i) => check(`youtube.titles[${i}]`, t));
    check('youtube.description', candidate.youtube.description);
    check('youtube.pinnedComment', candidate.youtube.pinnedComment);
  }

  if (Array.isArray(candidate.shorts)) {
    candidate.shorts.slice(0, MAX_SHORTS_ITEMS).forEach((s) => {
      check(`shorts[${s.trackNo}].titleKo`, s.titleKo);
      check(`shorts[${s.trackNo}].descriptionKo`, s.descriptionKo);
    });
  }

  if (candidate.instagram) {
    check('instagram.caption', candidate.instagram.caption);
  }

  if (candidate.x) {
    check('x.main', candidate.x.main);
    const thread = Array.isArray(candidate.x.thread) ? candidate.x.thread.slice(0, MAX_THREAD_ITEMS) : [];
    thread.forEach((t, i) => check(`x.thread[${i}]`, t));
    // lyricQuote: 원문 그대로의 영어 인용이 기대되는 필드 — 아티스트/사실주장
    // 검사는 건너뛰고 연도·가사원문포함 여부만 확인한다 (textPack.js의
    // passthroughOrKorean과 같은 예외).
    check('x.lyricQuote', candidate.x.lyricQuote, { skipArtistCheck: true, skipFactualCheck: true });
  }

  if (candidate.facebook) {
    check('facebook.body', candidate.facebook.body);
  }

  if (candidate.naver) {
    check('naver.title', candidate.naver.title);
    check('naver.bodyHtml', candidate.naver.bodyHtml, { isHtml: true });
  }

  if (candidate.hatena) {
    check('hatena.title', candidate.hatena.title);
    check('hatena.body', candidate.hatena.body);
  }

  const metaErrors = checkSongTitleProvenance(candidate.meta?.songTitlesUsed, facts);
  if (candidate.meta && typeof candidate.meta.songCount === 'number' && candidate.meta.songCount !== facts.trackCount) {
    metaErrors.push(`meta.songCount(${candidate.meta.songCount})가 실제 곡 수(${facts.trackCount})와 다릅니다.`);
  }
  if (metaErrors.length > 0) fieldResults.push({ path: 'meta', ok: false, errors: metaErrors });

  const allErrors = fieldResults.filter((f) => !f.ok).flatMap((f) => f.errors);
  return { fieldResults, allErrors };
}
