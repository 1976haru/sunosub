import { Router } from 'express';
import { Type } from '@google/genai';
import { requireGeminiClient, withRetry } from '../lib/gemini.js';
import { currentKey } from '../lib/keyStore.js';
import { extractKeyless, fallbackOEmbed } from '../lib/ytKeyless.js';

const router = Router();
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

function cleanEnv(value = '') {
  const text = String(value).trim();
  if (!text || text.includes('여기에_')) return '';
  return text;
}

function extractVideoId(input) {
  const text = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  try {
    const u = new URL(text);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
    if (u.hostname.includes('youtube.com')) {
      const fromQuery = u.searchParams.get('v');
      if (/^[A-Za-z0-9_-]{11}$/.test(fromQuery || '')) return fromQuery;
      const parts = u.pathname.split('/').filter(Boolean);
      const markerIndex = parts.findIndex((p) => ['shorts', 'embed', 'live'].includes(p));
      const id = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
  } catch { /* fall through to regex */ }
  const match = text.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

async function extractWithYouTubeApi(videoId) {
  const key = cleanEnv(process.env.YOUTUBE_API_KEY);
  if (!key) return null;
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('id', videoId);
  endpoint.searchParams.set('key', key);

  const response = await fetch(endpoint);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `YouTube API 오류 (${response.status})`);
  }
  const snippet = data?.items?.[0]?.snippet;
  if (!snippet) throw new Error('공개 영상 정보를 찾지 못했습니다. URL 또는 공개 상태를 확인해 주세요.');
  return {
    title: String(snippet.title || '').trim(),
    description: String(snippet.description || '').trim(),
    channelTitle: String(snippet.channelTitle || '').trim(),
    publishedAt: snippet.publishedAt || '',
    source: 'YouTube Data API',
  };
}

async function extractWithGemini(url) {
  const ai = requireGeminiClient();
  const prompt = `You are extracting public metadata from one YouTube video page.
Return the exact original video title and the full original description as shown by the uploader.
Do not summarize, translate, rewrite, invent, or add commentary.
If the full description cannot be verified, return the verified portion only and set descriptionIncomplete to true.
YouTube URL: ${url}`;

  const schema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      description: { type: Type.STRING },
      channelTitle: { type: Type.STRING },
      descriptionIncomplete: { type: Type.BOOLEAN },
    },
    required: ['title', 'description'],
  };

  const response = await withRetry(async () => {
    try {
      return await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          tools: [{ urlContext: {} }, { googleSearch: {} }],
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      });
    } catch {
      // Some account/model combinations restrict combining urlContext with
      // search at once; retry with search only before giving up.
      return ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      });
    }
  });

  if (!response.text) throw new Error('Gemini로부터 추출 결과를 받지 못했습니다.');
  const parsed = JSON.parse(response.text);
  if (!parsed.title) throw new Error('영상 제목을 확인하지 못했습니다.');
  return {
    title: String(parsed.title).trim(),
    description: String(parsed.description || '').trim(),
    channelTitle: String(parsed.channelTitle || '').trim(),
    descriptionIncomplete: Boolean(parsed.descriptionIncomplete),
    publishedAt: '',
    source: 'Gemini URL/검색 추출',
  };
}

function parseJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('빈 AI 응답입니다.');
  try { return JSON.parse(raw); } catch { /* try recovery below */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const startArray = raw.indexOf('[');
  const endArray = raw.lastIndexOf(']');
  if (startArray >= 0 && endArray > startArray) return JSON.parse(raw.slice(startArray, endArray + 1));
  const startObj = raw.indexOf('{');
  const endObj = raw.lastIndexOf('}');
  if (startObj >= 0 && endObj > startObj) return JSON.parse(raw.slice(startObj, endObj + 1));
  throw new Error('AI 응답을 JSON으로 해석하지 못했습니다.');
}

router.get('/status', (req, res) => {
  const hasGemini = Boolean(currentKey());
  res.json({
    ok: true,
    model: MODEL,
    geminiConfigured: hasGemini,
    youtubeApiConfigured: Boolean(cleanEnv(process.env.YOUTUBE_API_KEY)),
    mode: hasGemini ? 'gemini' : 'keyless',
  });
});

router.post('/extract', async (req, res, next) => {
  try {
    const url = String(req.body?.url || '').trim();
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: '올바른 YouTube URL 또는 11자리 비디오 ID를 입력해 주세요.' });
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const hasGemini = Boolean(currentKey());

    let result;
    let apiError = '';
    if (cleanEnv(process.env.YOUTUBE_API_KEY)) {
      try {
        result = await extractWithYouTubeApi(videoId);
      } catch (error) {
        apiError = error.message;
      }
    }

    if (!result) {
      if (hasGemini) {
        try {
          result = await extractWithGemini(canonicalUrl);
        } catch (geminiError) {
          const fallback = await fallbackOEmbed(canonicalUrl).catch(() => null);
          if (!fallback) throw geminiError;
          result = fallback;
          result.warning = `설명 추출 실패: ${geminiError.message}`;
        }
      } else {
        try {
          result = await extractKeyless(canonicalUrl);
        } catch (pageError) {
          const fallback = await fallbackOEmbed(canonicalUrl).catch(() => null);
          if (!fallback) throw pageError;
          result = fallback;
          result.warning = `설명 추출 실패(비공식 파싱): ${pageError.message}`;
        }
      }
    }

    if (apiError && result) {
      result.warning = `YouTube API 사용 실패 후 대체 추출: ${apiError}`;
    }
    res.json({ ...result, videoId, url: canonicalUrl });
  } catch (error) {
    next(error);
  }
});

router.post('/translate', async (req, res, next) => {
  try {
    if (!currentKey()) {
      const error = new Error('무료 Gemini 키를 설정하면 번역할 수 있습니다. 상단 배지에서 키를 입력해 주세요.');
      error.status = 400;
      error.needsKey = true;
      throw error;
    }
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    const languages = Array.isArray(req.body?.languages) ? req.body.languages.map(String).filter(Boolean) : [];
    if (!title) return res.status(400).json({ error: '번역할 제목이 없습니다.' });
    if (!languages.length) return res.status(400).json({ error: '번역 언어를 하나 이상 선택해 주세요.' });
    if (languages.length > 10) return res.status(400).json({ error: '한 번에 최대 10개 언어까지 처리할 수 있습니다.' });

    const ai = requireGeminiClient();
    const prompt = `You are a professional YouTube metadata localization translator.
Translate the Korean title and description into every target language listed below.

Target languages:
${languages.map((x, i) => `${i + 1}. ${x}`).join('\n')}

Rules:
1. Return exactly one object per requested target language, in the same order.
2. language must exactly match the target-language label supplied above.
3. translatedTitle must be natural, clickable, and no more than 100 Unicode characters.
4. Preserve tags such as [playlist], [Playlist], and emojis.
5. Translate normal hashtags naturally, but keep numeric hashtags such as #7080.
6. Preserve timestamps and track-list song titles at the end of the description exactly as written. Do not translate those lines.
7. Keep URLs, email addresses, credits, handles, and proper names unchanged unless a standard localized form is clearly appropriate.
8. Do not add explanations, quotation marks, or extra marketing claims.

Original title:
${title}

Original description:
${description}`;

    const response = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              language: { type: Type.STRING },
              translatedTitle: { type: Type.STRING },
              translatedDescription: { type: Type.STRING },
            },
            required: ['language', 'translatedTitle', 'translatedDescription'],
          },
        },
      },
    }));
    const parsed = parseJsonText(response.text);
    if (!Array.isArray(parsed)) throw new Error('번역 결과 형식이 올바르지 않습니다.');
    const normalized = parsed.map((item, index) => ({
      language: languages[index] || String(item.language || ''),
      translatedTitle: String(item.translatedTitle || '').trim().slice(0, 100),
      translatedDescription: String(item.translatedDescription || '').trim(),
    }));
    res.json({ results: normalized, model: MODEL });
  } catch (error) {
    next(error);
  }
});

router.post('/regenerate', async (req, res, next) => {
  try {
    if (!currentKey()) {
      const error = new Error('무료 Gemini 키를 설정하면 재생성할 수 있습니다.');
      error.status = 400;
      error.needsKey = true;
      throw error;
    }
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    const language = String(req.body?.language || '').trim();
    const field = req.body?.field === 'description' ? 'description' : 'title';
    if (!language) return res.status(400).json({ error: '대상 언어가 없습니다.' });
    const ai = requireGeminiClient();

    const prompt = field === 'title'
      ? `Translate and rewrite this YouTube title naturally in ${language}. Maximum 100 Unicode characters. Preserve [playlist] and emojis. Return only the title, with no quotes or explanation.\n\nOriginal title:\n${title}`
      : `Translate and rewrite this YouTube description naturally in ${language}. Translate normal hashtags, preserve emojis, URLs, timestamps, and track-list song-title lines exactly. Return only the description, with no explanation.\n\nOriginal description:\n${description}`;

    const response = await withRetry(() => ai.models.generateContent({ model: MODEL, contents: prompt }));
    const text = String(response.text || '').trim();
    if (!text) throw new Error('재생성 결과가 비어 있습니다.');
    res.json({ text: field === 'title' ? text.slice(0, 100) : text });
  } catch (error) {
    next(error);
  }
});

export default router;
