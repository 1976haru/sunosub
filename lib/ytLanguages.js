/**
 * TASK CS-v1.6 — the translator tool has always labelled languages in Korean
 * ("포르투갈어 (브라질)"), which is fine for a human reading a CSV but useless
 * to the YouTube Data API: `localizations` is keyed by BCP-47 / ISO 639-1
 * codes ("pt-BR"). This module is the bridge.
 *
 * Every label maps to a *candidate list*, not a single code, because YouTube's
 * supported-language set is its own thing and changes over time: "nl-BE" may
 * simply not exist as a YouTube application language, in which case the plain
 * "nl" entry is still a perfectly good place to put a Dutch translation.
 * resolveLanguageCode() walks the candidates against the live list fetched
 * from i18nLanguages.list and takes the first one YouTube actually accepts —
 * so this file never has to be "correct about YouTube" on its own, it only has
 * to be correct about *which language the label means*.
 */

/** label -> candidate BCP-47 codes, most specific first. */
export const LANGUAGE_CODE_CANDIDATES = {
  '한국어': ['ko'],
  '광둥어 (홍콩)': ['zh-HK', 'yue', 'zh-TW'],
  '그린란드어': ['kl'],
  '네덜란드어 (네덜란드)': ['nl-NL', 'nl'],
  '네덜란드어 (벨기에)': ['nl-BE', 'nl'],
  '노르웨이어': ['no', 'nb'],
  '덴마크어': ['da'],
  '독일어 (독일)': ['de-DE', 'de'],
  '독일어 (스위스)': ['de-CH', 'de'],
  '독일어 (오스트리아)': ['de-AT', 'de'],
  '러시아어': ['ru'],
  '루마니아어': ['ro'],
  '말레이어': ['ms'],
  '베트남어': ['vi'],
  '벵골어 (인도)': ['bn'],
  '스웨덴어': ['sv'],
  '스페인어 (멕시코)': ['es-MX', 'es-419', 'es'],
  '스페인어 (라틴 아메리카)': ['es-419', 'es'],
  '스페인어 (스페인)': ['es-ES', 'es'],
  '아랍어': ['ar'],
  '영어 (미국)': ['en-US', 'en'],
  '영어 (영국)': ['en-GB', 'en'],
  '영어 (인도)': ['en-IN', 'en'],
  '영어 (캐나다)': ['en-CA', 'en'],
  '이탈리아어': ['it'],
  '인도네시아어': ['id'],
  '일본어': ['ja'],
  '중국어 (싱가포르)': ['zh-SG', 'zh-Hans', 'zh-CN', 'zh'],
  '태국어': ['th'],
  '튀르키예어 (터키어)': ['tr'],
  '페르시아어': ['fa'],
  '포르투갈어 (브라질)': ['pt-BR', 'pt'],
  '포르투갈어 (포르투갈)': ['pt-PT', 'pt'],
  '폴란드어': ['pl'],
  '프랑스어 (벨기에)': ['fr-BE', 'fr'],
  '프랑스어 (스위스)': ['fr-CH', 'fr'],
  '프랑스어 (캐나다)': ['fr-CA', 'fr'],
  '프랑스어 (프랑스)': ['fr-FR', 'fr'],
  '필리핀어': ['fil', 'tl'],
  '힌디어': ['hi'],
  '그리스어': ['el'],
  '헝가리어': ['hu'],
  '체코어': ['cs'],
  '우크라이나어': ['uk'],
  '히브리어': ['iw', 'he'],
  '아프리칸스어': ['af'],
  '아이슬란드어': ['is'],
  '카탈로니아어': ['ca'],
  '슬로바키아어': ['sk'],
  '핀란드어': ['fi'],
  '크로아티아어': ['hr'],
};

const SUPPORTED_CACHE_MS = 12 * 60 * 60 * 1000;
let supportedCache = null;

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase();
}

/**
 * i18nLanguages.list costs 1 quota unit and needs only an API key OR an OAuth
 * token, so it is cheap enough to call once per session. If it fails for any
 * reason (no key configured yet, offline, quota) we return null rather than
 * throwing — resolveLanguageCode() then falls back to "trust the first
 * candidate", which is the pre-validation behaviour and still works for the
 * plain codes (ja/en/es/...) that make up almost every real publish.
 */
export async function fetchSupportedLanguages({ apiKey = '', accessToken = '' } = {}) {
  if (supportedCache && Date.now() - supportedCache.at < SUPPORTED_CACHE_MS) {
    return supportedCache.value;
  }
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/i18nLanguages');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('hl', 'ko');
  if (!accessToken && apiKey) endpoint.searchParams.set('key', apiKey);

  try {
    const response = await fetch(endpoint, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!response.ok) return null;
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) return null;
    const value = items.map((item) => ({
      code: String(item.snippet?.hl || item.id || ''),
      name: String(item.snippet?.name || ''),
    })).filter((x) => x.code);
    supportedCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

/**
 * @param {string} label      e.g. '포르투갈어 (브라질)'
 * @param {Array|null} supported  result of fetchSupportedLanguages(), or null
 * @returns {{code:string, exact:boolean, reason:string}}
 *   exact=false means we had to fall back to a broader language (nl-BE -> nl)
 *   or could not verify the code at all; the caller surfaces that to the user
 *   instead of silently publishing to a language they didn't pick.
 */
export function resolveLanguageCode(label, supported = null) {
  const candidates = LANGUAGE_CODE_CANDIDATES[String(label || '').trim()];
  if (!candidates?.length) {
    return { code: '', exact: false, reason: '이 언어의 유튜브 언어 코드를 알지 못합니다.' };
  }
  if (!supported) {
    return { code: candidates[0], exact: true, reason: '지원 언어 목록을 확인하지 못해 기본 코드를 사용했습니다.' };
  }
  const supportedSet = new Set(supported.map((x) => normalizeCode(x.code)));
  for (let i = 0; i < candidates.length; i++) {
    if (supportedSet.has(normalizeCode(candidates[i]))) {
      return {
        code: candidates[i],
        exact: i === 0,
        reason: i === 0 ? '' : `유튜브가 ${candidates[0]}를 지원하지 않아 ${candidates[i]}로 등록합니다.`,
      };
    }
  }
  return { code: '', exact: false, reason: `유튜브가 지원하지 않는 언어입니다 (${candidates.join(', ')}).` };
}

/**
 * Resolves a whole result set at once and reports collisions. Two labels can
 * legitimately collapse onto the same YouTube code (both "네덜란드어 (네덜란드)"
 * and "네덜란드어 (벨기에)" become "nl" if nl-BE is unsupported) — YouTube only
 * stores one localization per code, so the second one would silently overwrite
 * the first. We keep the first and report the rest as skipped.
 */
export function planLocalizations(results, supported = null) {
  const planned = [];
  const skipped = [];
  const usedCodes = new Map();

  for (const result of results) {
    const label = String(result?.language || '').trim();
    const title = String(result?.translatedTitle || '').trim();
    const description = String(result?.translatedDescription || '');
    const { code, exact, reason } = resolveLanguageCode(label, supported);

    if (!code) {
      skipped.push({ language: label, code: '', reason: reason || '언어 코드를 찾지 못했습니다.' });
      continue;
    }
    if (!title) {
      skipped.push({ language: label, code, reason: '번역 제목이 비어 있습니다.' });
      continue;
    }
    if (usedCodes.has(code)) {
      skipped.push({ language: label, code, reason: `이미 ${usedCodes.get(code)}가 같은 코드(${code})를 사용합니다.` });
      continue;
    }
    usedCodes.set(code, label);
    planned.push({
      language: label,
      code,
      title: Array.from(title).slice(0, 100).join(''),
      description,
      note: exact ? '' : reason,
    });
  }
  return { planned, skipped };
}
