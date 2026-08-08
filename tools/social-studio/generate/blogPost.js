/**
 * TASK-S1 — Naver blog (Korean channel) and Hatena (Japanese channel) posts.
 */

import { loadTemplateFile, selectTemplateWithinLimit, TemplatePoolError } from './slotFiller.js';
import { rotatedSlice } from './rotation.js';
import { buildSetSlots } from './youtubeSet.js';
import { loadLexicon } from '../parse/lexicon.js';
import { formatSongListLine } from './songListFormat.js';

const IMAGE_MARKER = '<!-- IMAGE:cover -->';
const PERSONAL_COMMENT_MARKER = '<!-- 여기에 직접 한 줄 -->';

function buildSongListHtml(songs) {
  const items = songs.map((s) => `<li>${formatSongListLine(s)}</li>`).join('\n');
  return `<ul>\n${items}\n</ul>`;
}

// ---------------------------------------------------------------------------
// Naver (Korean channel)
// ---------------------------------------------------------------------------

export function generateNaver(normalized, { channelId, hashtagPool, limits, youtubeUrl, excludeSceneNouns } = {}) {
  const setName = normalized.set.setName;
  const templates = loadTemplateFile(channelId, 'naver');
  const slots = buildSetSlots(normalized, { youtubeUrl, excludeSceneNouns });
  const warnings = [];

  const titlePick = selectTemplateWithinLimit(templates, slots, setName, 'nv-title', { role: 'title' }, { maxRetries: 5 });
  if (!titlePick.withinLimit) warnings.push('네이버 블로그 제목을 만들지 못했습니다.');

  const introPick = selectTemplateWithinLimit(templates, slots, setName, 'nv-body-intro', { role: 'body-intro' }, { maxRetries: 5 });
  if (!introPick.withinLimit) warnings.push('네이버 블로그 본문 도입부를 만들지 못했습니다.');

  const bodyHtml = [
    IMAGE_MARKER,
    introPick.withinLimit ? introPick.text : '',
    buildSongListHtml(normalized.songs),
    PERSONAL_COMMENT_MARKER,
    '<p></p>',
  ].filter(Boolean).join('\n');

  const tags = rotatedSlice(setName, 'nv-tags', hashtagPool.naver, limits.naver.tagMax);

  return {
    title: titlePick.withinLimit ? titlePick.text : null,
    bodyHtml,
    tags,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Hatena (Japanese channel only)
// ---------------------------------------------------------------------------

/**
 * Generates a Hatena post only when the set's output language is Japanese
 * AND the ja lexicon actually has content — an empty ja/*.json (S0 shipped
 * only empty skeletons; see docs/social-package-spec.md) would otherwise
 * produce English leaking into a "Japanese" post, which spec section 3⑦
 * explicitly forbids. Either case is a skip-with-warning, never a crash.
 */
export function generateHatena(normalized, { channelId } = {}) {
  if (normalized.set.outputLanguage !== 'ja') {
    return { title: null, body: null, category: null, warnings: ['일본 채널이 아니므로 하테나 글을 생략했습니다.'] };
  }
  const jaNouns = loadLexicon('ja', 'nouns');
  if (Object.keys(jaNouns.entries).length === 0) {
    return { title: null, body: null, category: null, warnings: ['일본어 사전이 비어 있어 하테나 글 생성을 생략했습니다.'] };
  }
  // Not reachable yet: no ja templates exist until a real ja setpack + filled
  // ja lexicon arrive (see docs/social-package-spec.md section 1).
  try {
    loadTemplateFile(channelId, 'hatena');
  } catch (error) {
    if (error instanceof TemplatePoolError) {
      return { title: null, body: null, category: null, warnings: ['하테나 템플릿이 아직 없어 생략했습니다.'] };
    }
    throw error;
  }
  throw new Error('generateHatena: ja 템플릿이 준비된 이후의 경로는 아직 구현되지 않았습니다.');
}
