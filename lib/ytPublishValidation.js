/*
 * TASK CS-v2.3 — "The request metadata is invalid."는 videos.update에 실려간
 * 40개 언어 중 하나가 유튜브 길이 제한을 넘으면 나는데, 나머지 39개가
 * 멀쩡해도 요청 전체가 거부된다(routes/yt.js의 videos.update는 한 번의 PUT).
 * 그래서 보내기 전에 서버가 직접 세어서 막는다 — 유튜브 문서가 명시하는
 * 제한(title 100자, description 5000자, tags 합계 500자)을 그대로 따른다.
 *
 * 길이는 Array.from()으로 센다. JS 문자열의 .length는 UTF-16 코드 유닛
 * 개수라 이모지·일부 한자처럼 서로게이트 쌍으로 인코딩되는 문자를 2로
 * 세어 실제보다 길게 나온다 — lib/ytLanguages.js의 planLocalizations()가
 * title을 자를 때 이미 같은 방식(Array.from(title).slice(0,100))을 쓰고
 * 있어서, 자르는 기준과 검증하는 기준이 어긋나지 않게 맞췄다.
 */

export const YT_LIMITS = Object.freeze({
  title: 100,
  description: 5000,
  tagsTotal: 500,
});

function charLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** snippet.title / snippet.description / snippet.tags(합계) 검증. */
export function validateSnippetLimits(snippet) {
  const problems = [];
  const title = charLength(snippet?.title);
  if (title > YT_LIMITS.title) {
    problems.push({ field: 'snippet.title', length: title, limit: YT_LIMITS.title });
  }
  const description = charLength(snippet?.description);
  if (description > YT_LIMITS.description) {
    problems.push({ field: 'snippet.description', length: description, limit: YT_LIMITS.description });
  }
  if (Array.isArray(snippet?.tags) && snippet.tags.length) {
    // 유튜브는 tags를 콤마로 이어붙인 하나의 문자열로 취급해 500자를 센다.
    const tagsTotal = charLength(snippet.tags.join(','));
    if (tagsTotal > YT_LIMITS.tagsTotal) {
      problems.push({ field: 'snippet.tags', length: tagsTotal, limit: YT_LIMITS.tagsTotal });
    }
  }
  return problems;
}

/**
 * localizations 맵(코드 -> {title, description?}) 전체를 검증한다.
 * 새로 등록하려는 항목(planned)과 기존에 이미 올라가 있던 항목(existing) 모두
 * 같은 맵으로 합쳐 넣어 호출해야 한다 — read-modify-write라 existing도 그대로
 * 다시 전송되기 때문에(CLAUDE.md 4.3), 예전에 등록된 것 중 지금 기준으로
 * 문제가 되는 항목도 여기서 걸러야 한다.
 */
export function validateLocalizationLimits(localizations) {
  const problems = [];
  for (const [code, entry] of Object.entries(localizations || {})) {
    const title = charLength(entry?.title);
    if (title > YT_LIMITS.title) {
      problems.push({ field: `localizations.${code}.title`, length: title, limit: YT_LIMITS.title, code });
    }
    if (entry?.description !== undefined) {
      const description = charLength(entry.description);
      if (description > YT_LIMITS.description) {
        problems.push({ field: `localizations.${code}.description`, length: description, limit: YT_LIMITS.description, code });
      }
    }
  }
  return problems;
}

export function validatePublishPayload({ snippet, localizations }) {
  return [...validateSnippetLimits(snippet), ...validateLocalizationLimits(localizations)];
}

const FIELD_LABELS = {
  'snippet.title': '영상 제목(snippet.title)',
  'snippet.description': '영상 설명(snippet.description)',
  'snippet.tags': '태그 전체 합계(snippet.tags)',
};

function fieldLabel(field) {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const m = /^localizations\.([^.]+)\.(title|description)$/.exec(field);
  if (m) return `${m[2] === 'title' ? '번역 제목' : '번역 설명'} (localizations.${m[1]}.${m[2]})`;
  return field;
}

/** problems[] -> 사람이 읽는 한 줄 요약. 프런트가 error.message로 그대로 보여준다. */
export function formatPublishProblems(problems) {
  return problems
    .map((p) => `${fieldLabel(p.field)}이(가) ${p.length}자로 유튜브 제한(${p.limit}자)을 넘습니다`)
    .join(' / ');
}
