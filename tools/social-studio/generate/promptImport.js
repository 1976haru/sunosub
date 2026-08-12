/**
 * TASK-S10 작업 B (최우선) — export 모드: Claude Code/Codex에 붙여넣어 받은
 * JSON을 가져와 검증하고 textpack.json에 병합한다.
 *
 * 병합 기준(base)은 항상 out/{setName}/textpack.local.json이다 — 현재
 * textpack.json(이전에 이미 한 번 가져오기를 한 결과일 수 있음)이 아니다.
 * 그래야 프롬프트를 다시 붙여넣어 재시도할 때마다 매번 "깨끗한 local
 * 결과"에서 새로 병합되고, 이전 가져오기의 부분 실패가 누적되지 않는다.
 * textpack.local.json 자체는 이 파일이 절대 덮어쓰지 않는다 — 완료조건 7:
 * "언제든 되돌릴 수 있어야 한다".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHallucinationFacts, scanCandidateTextpack } from '../lint/hallucinationGuard.js';
import { renderMarkdown } from './textPack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, '..', 'out');

const MAX_SHORTS_ITEMS = 500;
const MAX_ARRAY_FIELD_ITEMS = 200;

export class PromptImportError extends Error {}

/** ```json ... ``` 코드펜스가 섞여 있으면 벗겨낸다. 코드펜스가 없으면 원문 그대로 사용한다. */
export function stripCodeFence(raw) {
  const text = String(raw ?? '');
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1] : text;
}

/**
 * 붙여넣은 JSON을 파싱한다. 실패 시 어느 위치가 잘못됐는지 알려준다
 * (완료조건 5: "조용히 실패하면 실패"). Node의 JSON.parse 에러 메시지에서
 * "position N"을 뽑아 몇 번째 행/열인지로 바꿔 보여준다.
 */
export function parseCandidateJson(raw) {
  const stripped = stripCodeFence(raw).trim();
  if (!stripped) {
    throw new PromptImportError('붙여넣은 내용이 비어 있습니다.');
  }
  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw new PromptImportError(`JSON 파싱에 실패했습니다. ${describeJsonParseError(error, stripped)}`);
  }
}

/**
 * Node(V8)의 JSON.parse 에러 메시지는 두 가지 형태다: 위치 정보가 있는
 * "... at position N (line L column C)"(대체로 긴 입력)와, 위치 없이
 * 문제 구간을 그대로 인용해 보여주는 짧은-입력 전용 형태. 전자는 행/열로
 * 다시 포맷하고, 후자는 V8이 이미 스니펫을 담아 주므로 메시지를 그대로
 * 전달한다 — 어느 쪽이든 "어느 위치가 잘못됐는지" 조용히 삼키지 않는다.
 */
function describeJsonParseError(error, text) {
  const message = String(error.message || '');
  const lineColMatch = /line (\d+) column (\d+)/.exec(message);
  if (lineColMatch) {
    return `${lineColMatch[1]}행 ${lineColMatch[2]}열 부근 — ${message}`;
  }
  const posMatch = /position (\d+)/.exec(message);
  if (posMatch) {
    const pos = Number(posMatch[1]);
    const upTo = text.slice(0, pos);
    const line = upTo.split('\n').length;
    const col = pos - upTo.lastIndexOf('\n');
    return `${line}행 ${col}열 부근 — ${message}`;
  }
  return message;
}

/**
 * candidate(가져온 텍스트팩 조각)를 localTextpack(항상 textpack.local.json)
 * 위에 병합한다. 환각 검사를 통과한 필드만 교체되고, 실패한 필드/애초에
 * candidate에 없는 필드는 local 값이 그대로 유지된다.
 *
 * titles[]/thread[] 같은 배열 필드는 항목 단위가 아니라 배열 전체 단위로
 * 교체한다 — 인덱스 하나만 걸러내면 "제목 후보 2번만 로컬"처럼 어울리지
 * 않는 조합이 생기기 때문이다. 배열 안 항목 중 하나라도 검사에 걸리면
 * 배열 전체를 로컬로 유지한다.
 */
export function mergeCandidateIntoTextpack(candidate, localTextpack, normalized) {
  const facts = buildHallucinationFacts(normalized);
  const { fieldResults, allErrors } = scanCandidateTextpack(candidate, facts);
  const resultByPath = new Map(fieldResults.map((f) => [f.path, f]));

  const merged = JSON.parse(JSON.stringify(localTextpack));
  const replaced = [];
  const keptLocal = [];

  function isUsable(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function applyScalar(pathLabel, value, setter) {
    if (!isUsable(value)) return;
    const check = resultByPath.get(pathLabel);
    if (check && !check.ok) {
      keptLocal.push({ path: pathLabel, reason: check.errors.join(' / ') });
      return;
    }
    setter(value);
    replaced.push(pathLabel);
  }

  function applyArray(pathPrefix, values, setter) {
    if (!Array.isArray(values) || values.length === 0) return;
    const bounded = values.slice(0, MAX_ARRAY_FIELD_ITEMS);
    let anyBad = false;
    const reasons = [];
    for (let i = 0; i < bounded.length; i += 1) {
      const check = resultByPath.get(`${pathPrefix}[${i}]`);
      if (check && !check.ok) {
        anyBad = true;
        reasons.push(...check.errors);
      }
    }
    if (anyBad) {
      keptLocal.push({ path: pathPrefix, reason: reasons.join(' / ') });
      return;
    }
    setter(bounded);
    replaced.push(pathPrefix);
  }

  if (candidate.youtube) {
    applyArray('youtube.titles', candidate.youtube.titles, (v) => { merged.youtube.titles = v; });
    applyScalar('youtube.description', candidate.youtube.description, (v) => { merged.youtube.description = v; });
    applyScalar('youtube.pinnedComment', candidate.youtube.pinnedComment, (v) => { merged.youtube.pinnedComment = v; });
  }

  if (Array.isArray(candidate.shorts)) {
    for (const s of candidate.shorts.slice(0, MAX_SHORTS_ITEMS)) {
      const item = Array.isArray(merged.shorts) ? merged.shorts.find((x) => x.trackNo === s.trackNo) : null;
      if (!item) continue; // local shorts에 없는 trackNo는 병합할 자리가 없으므로 무시
      applyScalar(`shorts[${s.trackNo}].titleKo`, s.titleKo, (v) => { item.titleKo = v; });
      applyScalar(`shorts[${s.trackNo}].descriptionKo`, s.descriptionKo, (v) => { item.descriptionKo = v; });
    }
  }

  if (candidate.instagram) {
    applyScalar('instagram.caption', candidate.instagram.caption, (v) => { merged.instagram.caption = v; });
  }

  if (candidate.x) {
    applyScalar('x.main', candidate.x.main, (v) => { merged.x.main = v; });
    applyArray('x.thread', candidate.x.thread, (v) => { merged.x.thread = v; });
    applyScalar('x.lyricQuote', candidate.x.lyricQuote, (v) => { merged.x.lyricQuote = v; });
  }

  if (candidate.facebook) {
    applyScalar('facebook.body', candidate.facebook.body, (v) => { merged.facebook.body = v; });
  }

  if (candidate.naver) {
    applyScalar('naver.title', candidate.naver.title, (v) => { merged.naver.title = v; });
    applyScalar('naver.bodyHtml', candidate.naver.bodyHtml, (v) => { merged.naver.bodyHtml = v; });
  }

  if (candidate.hatena) {
    applyScalar('hatena.title', candidate.hatena.title, (v) => { merged.hatena.title = v; });
    applyScalar('hatena.body', candidate.hatena.body, (v) => { merged.hatena.body = v; });
  }

  const metaCheck = resultByPath.get('meta');
  if (metaCheck && !metaCheck.ok) {
    keptLocal.push({ path: 'meta', reason: metaCheck.errors.join(' / ') });
  }

  merged.errors = [...new Set([...(localTextpack.errors || []), ...allErrors])];
  merged.mode = 'export';

  return { textpack: merged, replaced, keptLocal, errors: allErrors };
}

/**
 * 파일 I/O까지 포함한 전체 가져오기 흐름. out/{setName}/normalized.json과
 * textpack.local.json을 읽어 병합하고, out/{setName}/textpack.json +
 * textpack.md를 다시 쓴다. textpack.local.json은 절대 건드리지 않는다.
 */
export function importPromptResult(setName, rawPastedText) {
  const outDir = path.join(OUT_ROOT, setName);
  const normalizedPath = path.join(outDir, 'normalized.json');
  const localTextpackPath = path.join(outDir, 'textpack.local.json');

  if (!fs.existsSync(normalizedPath)) {
    throw new PromptImportError(`normalized.json이 없습니다 — 먼저 이 세트를 생성해야 합니다: ${setName}`);
  }
  if (!fs.existsSync(localTextpackPath)) {
    throw new PromptImportError('textpack.local.json이 없습니다 — 먼저 로컬 모드로 한 번 생성한 뒤 가져오기를 시도하세요.');
  }

  const normalized = JSON.parse(fs.readFileSync(normalizedPath, 'utf8').replace(/^﻿/, ''));
  const localTextpack = JSON.parse(fs.readFileSync(localTextpackPath, 'utf8').replace(/^﻿/, ''));

  const candidate = parseCandidateJson(rawPastedText);
  const { textpack, replaced, keptLocal, errors } = mergeCandidateIntoTextpack(candidate, localTextpack, normalized);

  fs.writeFileSync(path.join(outDir, 'textpack.json'), JSON.stringify(textpack, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'textpack.md'), renderMarkdown(textpack), 'utf8');

  return { textpack, replaced, keptLocal, errors, outDir };
}
