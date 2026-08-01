import { Router } from 'express';
import { Type } from '@google/genai';
import { requireGeminiClient, withRetry } from '../lib/gemini.js';
import { currentKey } from '../lib/keyStore.js';
import { extractKeyless, fallbackOEmbed } from '../lib/ytKeyless.js';
import {
  buildAuthUrl,
  connectionAgeDays,
  consumeState,
  disconnect,
  exchangeCodeForTokens,
  getAccessToken,
  hasClientCredentials,
  isConnected,
  isProbablyExpired,
  readOAuthFile,
  redirectUri,
  rememberChannel,
  saveClientCredentials,
  TESTING_REFRESH_TOKEN_DAYS,
  youtubeApi,
} from '../lib/ytOAuth.js';
import { fetchSupportedLanguages, planLocalizations } from '../lib/ytLanguages.js';

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

/* ------------------------------------------------------------------ *
 * TASK CS-v1.6 — 유튜브 자동 등록 (videos.update: localizations)
 *
 * What YouTube actually offers here, and what it doesn't:
 *   - A video resource can carry a `localizations` map keyed by BCP-47 code.
 *     Viewers whose YouTube UI language matches a key see that localized
 *     title/description instead of the original. This is the feature the user
 *     saw; it is *not* YouTube auto-translating anything — we supply the text,
 *     which is exactly what this tool already produces.
 *   - Setting it requires `snippet.defaultLanguage` (the language the original
 *     title/description are written in) to be set on the same video.
 *   - videos.update is a full replace of every part named in `part`. Any
 *     property with an existing value that we omit gets DELETED. So every
 *     write below is strictly read-modify-write: videos.list first, keep the
 *     existing title/description/categoryId/tags and existing localizations,
 *     then merge ours on top. Never construct a snippet from scratch.
 *   - Quota: videos.update costs 50 units, videos.list 1, regardless of how
 *     many languages ride along in one call. The default daily quota is
 *     10,000 units, so ~190 videos/day — far past this channel's 12/week.
 * ------------------------------------------------------------------ */

function oauthStatePayload(port) {
  const file = readOAuthFile();
  return {
    hasClient: hasClientCredentials(),
    connected: isConnected(),
    channelTitle: file.channelTitle || '',
    channelId: file.channelId || '',
    connectedAt: file.connectedAt || '',
    connectionAgeDays: connectionAgeDays(),
    probablyExpired: isProbablyExpired(),
    testingTokenDays: TESTING_REFRESH_TOKEN_DAYS,
    redirectUri: redirectUri(port),
    clientIdPreview: file.clientId ? `${String(file.clientId).slice(0, 14)}…` : '',
  };
}

router.get('/oauth/status', (req, res) => {
  res.json(oauthStatePayload(req.socket.localPort));
});

router.post('/oauth/credentials', (req, res, next) => {
  try {
    saveClientCredentials(req.body?.clientId, req.body?.clientSecret);
    res.json({ ok: true, ...oauthStatePayload(req.socket.localPort) });
  } catch (error) { next(error); }
});

router.get('/oauth/start', (req, res, next) => {
  try {
    res.redirect(buildAuthUrl(req.socket.localPort));
  } catch (error) { next(error); }
});

/**
 * Google redirects the user's browser here after consent. This renders a plain
 * HTML page (not JSON) because a human is looking at it — it tells the opener
 * window to refresh its status and then closes itself.
 */
router.get('/oauth/callback', async (req, res) => {
  const page = (title, body, ok = true) => `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<title>${title}</title><style>body{font-family:"Malgun Gothic",system-ui,sans-serif;background:#0f1420;color:#e8edf7;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 10px;color:${ok ? '#5eead4' : '#fca5a5'}}p{color:#98a2b3;line-height:1.7;margin:0}</style></head>
<body><div><h1>${title}</h1><p>${body}</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'creator-studio:yt-oauth'},'*');}catch(e){}
setTimeout(function(){window.close();},${ok ? 1800 : 6000});</script></body></html>`;

  try {
    if (req.query.error) throw new Error(`구글에서 권한을 거부했습니다: ${req.query.error}`);
    if (!consumeState(req.query.state)) throw new Error('요청 검증에 실패했습니다(state 불일치). 연결을 처음부터 다시 시도해 주세요.');
    await exchangeCodeForTokens(req.query.code, req.socket.localPort);

    let channelTitle = '';
    try {
      const channels = await youtubeApi('channels', { query: { part: 'snippet', mine: 'true' } });
      const channel = channels?.items?.[0];
      if (channel) {
        channelTitle = channel.snippet?.title || '';
        rememberChannel({ channelId: channel.id, channelTitle });
      }
    } catch { /* the connection itself succeeded; the channel name is a nicety */ }

    res.send(page('연결되었습니다', `${channelTitle ? `채널: ${channelTitle}<br />` : ''}이 창은 곧 자동으로 닫힙니다.`));
  } catch (error) {
    res.status(400).send(page('연결하지 못했습니다', String(error.message || error), false));
  }
});

router.post('/oauth/disconnect', (req, res, next) => {
  try {
    disconnect();
    res.json({ ok: true, ...oauthStatePayload(req.socket.localPort) });
  } catch (error) { next(error); }
});

/** The authorized account's own uploads — so the user picks a video instead of pasting an ID. */
router.get('/my-videos', async (req, res, next) => {
  try {
    const channels = await youtubeApi('channels', { query: { part: 'contentDetails,snippet', mine: 'true' } });
    const channel = channels?.items?.[0];
    const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) throw Object.assign(new Error('연결된 계정에서 채널을 찾지 못했습니다.'), { status: 404 });
    rememberChannel({ channelId: channel.id, channelTitle: channel.snippet?.title });

    const items = await youtubeApi('playlistItems', {
      query: {
        part: 'snippet,contentDetails',
        playlistId: uploadsId,
        maxResults: Math.min(50, Math.max(1, Number(req.query.maxResults) || 25)),
        pageToken: req.query.pageToken || '',
      },
    });
    res.json({
      channelTitle: channel.snippet?.title || '',
      nextPageToken: items.nextPageToken || '',
      videos: (items.items || []).map((item) => ({
        videoId: item.contentDetails?.videoId || '',
        title: item.snippet?.title || '',
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '',
        thumbnail: item.snippet?.thumbnails?.default?.url || '',
      })).filter((v) => v.videoId),
    });
  } catch (error) { next(error); }
});

/** Current localizations already on a video — lets the user see what will be added vs overwritten. */
router.get('/localizations', async (req, res, next) => {
  try {
    const videoId = extractVideoId(String(req.query.videoId || ''));
    if (!videoId) throw Object.assign(new Error('영상 ID를 확인하지 못했습니다.'), { status: 400 });
    const data = await youtubeApi('videos', { query: { part: 'snippet,localizations', id: videoId } });
    const video = data?.items?.[0];
    if (!video) throw Object.assign(new Error('영상을 찾지 못했습니다.'), { status: 404 });
    res.json({
      videoId,
      title: video.snippet?.title || '',
      channelId: video.snippet?.channelId || '',
      defaultLanguage: video.snippet?.defaultLanguage || '',
      existing: Object.entries(video.localizations || {}).map(([code, value]) => ({ code, title: value?.title || '' })),
    });
  } catch (error) { next(error); }
});

/**
 * dryRun=true resolves language codes and reports exactly what would be
 * written, without touching YouTube at all beyond a read — the same
 * "미리보기 → 적용" shape the timeline rename tool already uses, and for the
 * same reason: this writes to a live public channel.
 */
router.post('/publish-localizations', async (req, res, next) => {
  try {
    const videoId = extractVideoId(String(req.body?.videoId || ''));
    if (!videoId) throw Object.assign(new Error('영상 URL 또는 11자리 영상 ID를 입력해 주세요.'), { status: 400 });
    const defaultLanguage = String(req.body?.defaultLanguage || 'ko').trim() || 'ko';
    const dryRun = Boolean(req.body?.dryRun);
    const translations = Array.isArray(req.body?.translations) ? req.body.translations : [];
    if (!translations.length) throw Object.assign(new Error('등록할 번역 결과가 없습니다.'), { status: 400 });

    const accessToken = await getAccessToken();
    const supported = await fetchSupportedLanguages({ accessToken });
    const { planned, skipped } = planLocalizations(translations, supported);

    const listed = await youtubeApi('videos', { query: { part: 'snippet,localizations', id: videoId } });
    const video = listed?.items?.[0];
    if (!video) throw Object.assign(new Error('영상을 찾지 못했습니다. 비공개/삭제된 영상이거나 ID가 틀렸을 수 있습니다.'), { status: 404 });

    const myChannelId = readOAuthFile().channelId;
    if (myChannelId && video.snippet?.channelId && video.snippet.channelId !== myChannelId) {
      throw Object.assign(
        new Error('연결된 계정의 채널 영상이 아닙니다. 본인 채널에 올린 영상만 번역을 등록할 수 있습니다.'),
        { status: 403 }
      );
    }

    const existing = video.localizations || {};
    const overwriting = planned.filter((p) => existing[p.code]).map((p) => p.code);

    if (dryRun) {
      return res.json({
        dryRun: true,
        videoId,
        videoTitle: video.snippet?.title || '',
        currentDefaultLanguage: video.snippet?.defaultLanguage || '',
        defaultLanguage,
        planned,
        skipped,
        overwriting,
        existingCount: Object.keys(existing).length,
      });
    }

    if (!planned.length) throw Object.assign(new Error('등록 가능한 언어가 하나도 없습니다.'), { status: 400 });

    // Read-modify-write: everything already on the video is carried over
    // verbatim, because videos.update deletes any omitted property.
    const localizations = { ...existing };
    for (const item of planned) {
      localizations[item.code] = { title: item.title, description: item.description };
    }
    const snippet = {
      title: video.snippet?.title || '',
      description: video.snippet?.description || '',
      categoryId: video.snippet?.categoryId || '10',
      defaultLanguage,
    };
    if (Array.isArray(video.snippet?.tags) && video.snippet.tags.length) snippet.tags = video.snippet.tags;

    const updated = await youtubeApi('videos', {
      method: 'PUT',
      query: { part: 'snippet,localizations' },
      body: { id: videoId, snippet, localizations },
    });

    res.json({
      ok: true,
      videoId,
      videoTitle: updated?.snippet?.title || video.snippet?.title || '',
      defaultLanguage,
      publishedCount: planned.length,
      published: planned.map((p) => ({ language: p.language, code: p.code, note: p.note })),
      skipped,
      overwriting,
      totalLocalizations: Object.keys(updated?.localizations || localizations).length,
      quotaNote: 'videos.update 1회 = 50 유닛 (기본 일일 한도 10,000 유닛)',
    });
  } catch (error) { next(error); }
});

export default router;
