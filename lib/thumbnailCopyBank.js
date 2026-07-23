// Local (no-API-key) copy candidate bank + shared safety validation for the
// thumbnail/cover studio. Used as the source of truth when no Gemini key is
// configured, and as a post-filter on Gemini output either way.

export const STYLE_TAGS = [
  { id: 'curiosity', label: '호기심형' },
  { id: 'question', label: '질문형' },
  { id: 'emotional', label: '감성형' },
  { id: 'empathy', label: '공감형' },
  { id: 'luck', label: '기대감(행운)형' },
];

const BANNED_WORDS = [
  '충격', '소름', '경악', '헐', '대박사건', '충격적', '깜짝',
  '치료', '완치', '효능', '효과', '부작용', '질병', '질환', '처방', '통증완화',
];

const FORBIDDEN_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /\d{1,3}(,\d{3})*\s?원/,
  /[$₩]\s?\d/,
  /@[a-zA-Z0-9_]{2,}/,
  /\b01[016789]-?\d{3,4}-?\d{4}\b/,
];

function countChars(line) {
  return String(line || '').replace(/\s+/g, '').length;
}

// Advisory line-length check (spec target is 6~14 per line); kept lenient
// so occasional AI phrasing isn't rejected outright.
export function validateCopyText(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, reasons: ['empty'] };
  const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
  const reasons = [];
  if (lines.length < 1 || lines.length > 2) reasons.push('line-count');
  for (const line of lines) {
    const len = countChars(line);
    if (len < 4 || len > 18) reasons.push('line-length');
  }
  const lower = value.toLowerCase();
  if (BANNED_WORDS.some((word) => value.includes(word))) reasons.push('banned-word');
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(lower))) reasons.push('forbidden-pattern');
  return { ok: reasons.length === 0, reasons };
}

function shortKeyword(concept) {
  const clean = String(concept || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const firstChunk = clean.split(/[,.!?\n]/)[0].trim();
  const words = firstChunk.split(' ');
  let keyword = words[0] || '';
  for (let i = 1; i < words.length && (keyword + words[i]).length <= 6; i++) {
    keyword += words[i];
  }
  return keyword.slice(0, 6);
}

const TEMPLATES = {
  curiosity: [
    ['이 노래', '뭔가 다르다'],
    ['{kw} 속에', '숨은 이야기'],
    ['왜 다들', '이 노래를 찾을까'],
    ['한 번 들으면', '계속 생각나는 곡'],
  ],
  question: [
    ['오늘 기분', '어떠세요?'],
    ['이 멜로디', '기억나세요?'],
    ['{kw}', '좋아하세요?'],
    ['잠깐, 이 노래', '들어보실래요?'],
  ],
  emotional: [
    ['마음이', '따뜻해지는 노래'],
    ['{kw} 감성', '가득 담은 하루'],
    ['잔잔하게', '스며드는 시간'],
    ['조용히 듣기', '좋은 노래'],
  ],
  empathy: [
    ['다들 이런', '하루 있잖아요'],
    ['{kw}, 나만', '그런 거 아니죠'],
    ['지친 하루', '토닥토닥'],
    ['우리 모두의', '이야기 같은 노래'],
  ],
  luck: [
    ['오늘부터', '좋은 일만'],
    ['{kw} 들으면', '행운이 시작돼요'],
    ['이 노래 들으면', '좋은 일 생김'],
    ['행운을 부르는', '오늘의 플레이리스트'],
  ],
};

function fillTemplate(pair, keyword) {
  const fallback = keyword || '오늘';
  return pair.map((line) => line.replace('{kw}', fallback)).join('\n');
}

export function generateFallbackCandidates(concept, avoid = [], count = 5) {
  const keyword = shortKeyword(concept);
  const avoidSet = new Set((avoid || []).map((v) => String(v).trim()));
  const results = [];
  const tags = STYLE_TAGS;
  for (let i = 0; i < Math.max(3, Math.min(5, count)); i++) {
    const tag = tags[i % tags.length];
    const pool = TEMPLATES[tag.id];
    let candidate = null;
    const order = [...pool.keys()].sort(() => Math.random() - 0.5);
    for (const idx of order) {
      const text = fillTemplate(pool[idx], keyword);
      if (!avoidSet.has(text) && !results.some((r) => r.text === text)) {
        candidate = text;
        break;
      }
    }
    if (!candidate) candidate = fillTemplate(pool[0], keyword);
    results.push({ text: candidate, styleTag: tag.label, styleTagId: tag.id });
  }
  return results;
}

export { BANNED_WORDS, FORBIDDEN_PATTERNS };
