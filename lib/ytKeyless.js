// Unofficial, no-API-key fallback for extracting a YouTube video's title and
// description. Used only when no Gemini key is configured. YouTube's page
// structure can change at any time, so every step here degrades gracefully
// down to the oEmbed endpoint (title only), which is the one official path
// that needs no key.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

function decodeHtmlEntities(text) {
  return String(text || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractFromPlayerResponse(html) {
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;\s*(?:var |const |let |<\/script>)/s);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const details = data?.videoDetails;
  if (!details?.title) return null;
  return {
    title: String(details.title).trim(),
    description: String(details.shortDescription || '').trim(),
    channelTitle: String(details.author || '').trim(),
    descriptionIncomplete: false,
    publishedAt: '',
    source: 'ytInitialPlayerResponse(비공식 파싱)',
  };
}

function extractFromOgMeta(html) {
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)?.[1];
  if (!ogTitle) return null;
  const ogDescription = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)?.[1];
  return {
    title: decodeHtmlEntities(ogTitle).trim(),
    description: decodeHtmlEntities(ogDescription || '').trim(),
    channelTitle: '',
    descriptionIncomplete: true,
    publishedAt: '',
    source: 'og:meta(비공식 파싱)',
  };
}

export async function extractKeyless(canonicalUrl) {
  const response = await fetch(canonicalUrl, { headers: BROWSER_HEADERS });
  if (!response.ok) throw new Error(`유튜브 페이지 요청 실패 (${response.status})`);
  const html = await response.text();
  const result = extractFromPlayerResponse(html) || extractFromOgMeta(html);
  if (!result) throw new Error('페이지에서 제목을 찾지 못했습니다.');
  return result;
}

export async function fallbackOEmbed(url) {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('format', 'json');
  const response = await fetch(endpoint);
  if (!response.ok) return null;
  const data = await response.json();
  return {
    title: String(data.title || '').trim(),
    description: '',
    channelTitle: String(data.author_name || '').trim(),
    descriptionIncomplete: true,
    publishedAt: '',
    source: 'YouTube oEmbed(제목만)',
  };
}
