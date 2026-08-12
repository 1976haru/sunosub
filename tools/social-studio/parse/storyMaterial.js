/**
 * TASK-S10 작업 A — storytelling material extraction (local/export/gemini
 * 세 모드 전부의 입력 재료). setPackLoader.js의 normalizeSetPack()이
 * 세션 세터 프로모션(section 7) 직전에 이 모듈을 호출해 set.storyMaterial을
 * 만든다. 기존 S0 로직은 건드리지 않는다 — 이 파일은 추가 전용이다.
 *
 * 원문(영문 가사)을 그대로 보존하고 번역하지 않는다 — 번역은 S1(생성 단계)
 * 이후, export/gemini 모드가 실제로 문장을 만들 때의 일이다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePhrase } from './lexicon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENSORY_LEXICON_PATH = path.join(__dirname, '..', 'data', 'lexicon', 'sensory.json');

// 명시적 반복 상한 (CLAUDE.md 관행 + TASK-S10 완료조건 13).
const MAX_LINES_PER_SONG = 3;
const MAX_LINES_PER_SET = 20;
const MAX_SONGS_SCANNED = 500; // setPackLoader.js의 MAX_SONGS_PER_SET과 동일한 상한
const MAX_DISTINCT_CHOICES = 500;
const MAX_SENSORY_WINDOW_WORDS = 3;
const MAX_LINE_WORDS_SCANNED = 200;

const SECTION_TAG_PATTERN = /^\s*\[[^\]]*\]\s*/; // "[Verse 1] " 같은 선행 태그
const SECTION_TAG_ONLY_PATTERN = /^\s*\[[^\]]*\]\s*$/; // 줄 전체가 태그뿐인 경우

let sensoryLexiconCache = null;

function loadSensoryLexicon() {
  if (sensoryLexiconCache) return sensoryLexiconCache;
  const raw = fs.readFileSync(SENSORY_LEXICON_PATH, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw);
  const entries = {};
  for (const [key, value] of Object.entries(data.entries || {})) {
    entries[normalizePhrase(key)] = value;
  }
  sensoryLexiconCache = entries;
  return entries;
}

/**
 * 가사 원문을 줄 단위로 분리한다. 섹션 태그([Verse 1], [Chorus] 등)를
 * 제거하고, 태그만 있던 줄/빈 줄은 버린다. 완료조건: "[Verse 1] 같은
 * 태그가 남아 있으면 실패" — 태그 전용 줄과 줄 앞에 붙은 태그 둘 다 처리.
 */
export function splitLyricLines(lyrics) {
  const rawLines = String(lyrics ?? '').split(/\r\n|\r|\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length && i < 2000; i += 1) {
    const line = rawLines[i];
    if (SECTION_TAG_ONLY_PATTERN.test(line)) continue;
    const stripped = line.replace(SECTION_TAG_PATTERN, '').trim();
    if (stripped) lines.push(stripped);
  }
  return lines;
}

/**
 * 이미지가 강한 행 우선순위: 구체 명사 사전(nouns/timewords) 매치가 많고
 * 동사로 보이는 단어(어미 기반 휴리스틱)가 있는 행일수록 높은 점수.
 * 후렴 반복행은 같은 문자열이 두 번째 나오면 제외한다(한 번만).
 */
function scoreLine(line, nounsLex, timewordsLex, stopwords) {
  const words = line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_LINE_WORDS_SCANNED);

  let concreteHits = 0;
  let hasVerbLike = false;
  for (const word of words) {
    if (nounsLex.entries[word] || timewordsLex.entries[word]) concreteHits += 1;
    if (!hasVerbLike && word.length > 4 && !stopwords.has(word)) {
      if (word.endsWith('ing') || word.endsWith('ed') || word.endsWith('s')) hasVerbLike = true;
    }
  }
  return concreteHits * 2 + (hasVerbLike ? 1 : 0) + (words.length >= 4 ? 1 : 0);
}

/**
 * 한 곡의 가사에서 이미지가 강한 행을 최대 MAX_LINES_PER_SONG개 뽑는다.
 * 점수 내림차순, 동점이면 원래 등장 순서 유지. 원문 그대로 반환한다.
 */
export function extractImageLines(lyrics, nounsLex, timewordsLex, stopwords) {
  const lines = splitLyricLines(lyrics);
  const seen = new Set(); // 후렴 반복행은 한 번만
  const candidates = [];
  for (let i = 0; i < lines.length && i < 500; i += 1) {
    const line = lines[i];
    const key = normalizePhrase(line);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ line, order: candidates.length, score: scoreLine(line, nounsLex, timewordsLex, stopwords) });
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates.slice(0, MAX_LINES_PER_SONG).map((c) => c.line);
}

/**
 * 감각 분류(sound/sight/touch/smell/taste). data/lexicon/sensory.json 사전
 * 기반, longest-match-first. 판정 불가 항목은 category:"unknown"으로 남기고
 * 버리지 않는다.
 */
export function classifySensoryPhrases(line, sensoryLex) {
  const tokens = line
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_LINE_WORDS_SCANNED);

  const results = [];
  let i = 0;
  let iterations = 0;
  while (i < tokens.length && iterations < MAX_LINE_WORDS_SCANNED) {
    iterations += 1;
    let matched = false;
    const maxWindow = Math.min(MAX_SENSORY_WINDOW_WORDS, tokens.length - i);
    for (let windowSize = maxWindow; windowSize >= 1 && !matched; windowSize -= 1) {
      const candidate = tokens.slice(i, i + windowSize).join(' ');
      const key = normalizePhrase(candidate);
      const entry = sensoryLex[key];
      if (entry) {
        results.push({ en: candidate, category: entry.category });
        i += windowSize;
        matched = true;
      }
    }
    if (!matched) i += 1;
  }
  return results;
}

/**
 * TASK-S10 작업 A — normalized songs(이미 titleLocalized/emotionArc 등이
 * 계산된 상태, seasonMoment 세트-레벨 프로모션 *이전*)로부터
 * set.storyMaterial을 만든다. 프로모션 이전이어야 하는 이유: 프로모션이
 * 실행되면 각 곡의 seasonMoment가 null로 지워지는데, openingScene은 그
 * 원문이 필요하다 — setPackLoader.js는 프로모션 블록보다 먼저 이 함수를
 * 호출한다.
 *
 * @param {object[]} normalizedSongs - normalizeSetPack()의 songs 배열(맵 직후, 프로모션 전).
 * @param {{nounsLex: object, timewordsLex: object, stopwords: Set<string>}} lex - setPackLoader.js가 이미 로드해 둔 출력언어 사전. 이 함수는 사전 파일을 다시 읽지 않는다.
 */
export function buildStoryMaterial(normalizedSongs, lex) {
  const sensoryLex = loadSensoryLexicon();
  const songs = normalizedSongs.slice(0, MAX_SONGS_SCANNED);

  // --- lyricLines: 세트 전체 풀, 곡당 최대 3행, 세트 전체 최대 20행 ---
  const lyricLines = []; // [{trackNo, text}]
  for (const song of songs) {
    if (lyricLines.length >= MAX_LINES_PER_SET) break;
    const picked = extractImageLines(song.lyrics, lex.nounsLex, lex.timewordsLex, lex.stopwords);
    for (const line of picked) {
      if (lyricLines.length >= MAX_LINES_PER_SET) break;
      lyricLines.push({ trackNo: song.trackNo, text: line });
    }
  }

  // --- openingScene: 첫 곡 ---
  const firstSong = songs[0] || null;
  const openingScene = firstSong
    ? {
        trackNo: firstSong.trackNo,
        raw: firstSong.seasonMoment || firstSong.lyricThemeText?.raw || firstSong.listenerSituation?.raw || null,
        lyricLines: lyricLines.filter((l) => l.trackNo === firstSong.trackNo).map((l) => l.text),
      }
    : { trackNo: null, raw: null, lyricLines: [] };

  // --- emotionJourney ---
  const lastSong = songs[songs.length - 1] || null;
  const steps = [];
  for (let i = 0; i < songs.length && i < MAX_SONGS_SCANNED; i += 1) {
    const s = songs[i];
    if (s.emotionArc?.parsed) {
      steps.push(`${s.emotionArc.from?.ko ?? s.emotionArc.from?.en ?? '?'} -> ${s.emotionArc.to?.ko ?? s.emotionArc.to?.en ?? '?'}`);
    }
  }
  const emotionJourney = {
    from: firstSong?.emotionArc?.parsed ? (firstSong.emotionArc.from?.ko ?? firstSong.emotionArc.from?.en ?? null) : null,
    to: lastSong?.emotionArc?.parsed ? (lastSong.emotionArc.to?.ko ?? lastSong.emotionArc.to?.en ?? null) : null,
    steps,
  };

  // --- sensoryDetails: 세트 전체, lyricLines 풀에서 감각 어휘 추출 ---
  const sensoryDetails = [];
  for (const { trackNo, text } of lyricLines) {
    const hits = classifySensoryPhrases(text, sensoryLex);
    for (const hit of hits) {
      sensoryDetails.push({ trackNo, en: hit.en, category: hit.category });
    }
  }

  // --- distinctChoices ---
  const distinctChoices = [];
  const seenChoices = new Set();
  for (let i = 0; i < songs.length && i < MAX_DISTINCT_CHOICES; i += 1) {
    const dc = songs[i].distinctChoice;
    if (dc && !seenChoices.has(dc)) {
      seenChoices.add(dc);
      distinctChoices.push(dc);
    }
  }

  // --- pov: 첫 곡 기준 (v2 전용 필드, 없으면 null) ---
  const pov = firstSong?.pov ?? null;

  // --- timeSpan: 첫 곡/마지막 곡에서 매치된 time 카테고리 용어의 원문 ---
  function firstTimeTerm(song) {
    if (!song) return null;
    const pools = [song.listenerSituation?.matchedTerms || [], song.lyricThemeText?.matchedTerms || []];
    for (const pool of pools) {
      for (const m of pool) {
        if (m.category === 'time') return m.term;
      }
    }
    return null;
  }
  function lastTimeTerm(song) {
    if (!song) return null;
    const pools = [song.listenerSituation?.matchedTerms || [], song.lyricThemeText?.matchedTerms || []];
    let last = null;
    for (const pool of pools) {
      for (const m of pool) {
        if (m.category === 'time') last = m.term;
      }
    }
    return last;
  }

  const timeSpan = {
    from: firstTimeTerm(firstSong),
    to: lastTimeTerm(lastSong) ?? firstTimeTerm(lastSong),
  };

  return {
    openingScene,
    emotionJourney,
    sensoryDetails,
    distinctChoices,
    pov,
    timeSpan,
    lyricLines, // [{trackNo, text}] — 프롬프트/환각 검사(가사 인용 대조)가 재사용
  };
}
