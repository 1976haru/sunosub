import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireGeminiClient, withRetry } from '../lib/gemini.js';
import { currentKey } from '../lib/keyStore.js';
import { STYLE_TAGS, validateCopyText, generateFallbackCandidates } from '../lib/thumbnailCopyBank.js';
import { SCENE_PRESETS } from '../lib/scenePresets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const filesDir = path.join(__dirname, '..', 'output', 'thumbnails');
await fsp.mkdir(filesDir, { recursive: true });

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpeg|webp)$/i.test(file.mimetype)) {
      cb(new Error('PNG, JPG, WEBP 이미지만 업로드할 수 있습니다.'));
      return;
    }
    cb(null, true);
  },
});

const TEXT_MODEL = process.env.THUMBNAIL_TEXT_MODEL || 'gemini-3.5-flash';
const IMAGE_MODEL = process.env.THUMBNAIL_IMAGE_MODEL || process.env.SHORTS_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
const IMAGE_SIZE_DEFAULT = process.env.THUMBNAIL_IMAGE_SIZE || '2K';

const SAFETY_SUFFIX = 'Do not reproduce or reference any existing painting, artwork, film still, or copyrighted illustration. '
  + 'Do not depict any real or identifiable person, celebrity, or public figure. Do not include any brand logo or trademarked '
  + 'character. Do not create a meme-style juxtaposition or collage. Do not render any text, letters, numbers, captions, price '
  + 'tags, URLs, or social media handles in the image.';

// Always appended so every background — preset-seeded or freely typed — reads
// as a clean, professional photo rather than an AI-plastic render.
const QUALITY_BOOSTER = 'professional photography, photorealistic, cinematic lighting, natural color grading, soft depth '
  + 'of field, high dynamic range, crisp detail, clean composition, no harsh HDR, no oversaturation, no plastic-looking CGI.';
const ALBUM_COVER_PHRASE = 'Album cover aesthetic: iconic, simple, and readable at a small thumbnail size.';
const TEXT_SPACE_INSTRUCTION = 'Leave the upper third and center of the frame calm, uncluttered and low in fine detail so '
  + 'text can be overlaid there afterward, while keeping the rest of the composition rich and detailed.';

function safeId(value, fallback = `thumb-${Date.now()}`) {
  const clean = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return clean || fallback;
}

function safeName(value, fallback = 'asset') {
  const clean = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .slice(0, 100);
  return clean || fallback;
}

async function ensureProject(projectId) {
  const id = safeId(projectId);
  const dir = path.join(filesDir, id);
  await fsp.mkdir(dir, { recursive: true });
  return { id, dir };
}

function toPublicUrl(absolutePath) {
  const relative = path.relative(filesDir, absolutePath).split(path.sep).map(encodeURIComponent).join('/');
  return `/api/thumbnail/files/${relative}`;
}

function resolveFileUrl(fileUrl) {
  if (!fileUrl || !String(fileUrl).startsWith('/api/thumbnail/files/')) {
    throw new Error('로컬 파일 주소가 올바르지 않습니다.');
  }
  const relative = decodeURIComponent(String(fileUrl).slice('/api/thumbnail/files/'.length));
  const absolute = path.resolve(filesDir, relative);
  const base = path.resolve(filesDir) + path.sep;
  if (!absolute.startsWith(base)) throw new Error('허용되지 않은 파일 경로입니다.');
  return absolute;
}

function mimeExtension(mimeType) {
  if (/jpeg/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  return 'png';
}

async function filePartFromUrl(fileUrl) {
  const filePath = resolveFileUrl(fileUrl);
  const data = await fsp.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return { inlineData: { mimeType, data: data.toString('base64') } };
}

function isImageSizeRejection(error) {
  const message = String(error?.message || '');
  return /image[_ ]?size|invalid.*size|unsupported.*size/i.test(message);
}

// Requests the highest configured resolution first; some accounts/regions
// don't yet support the larger enum value, so this falls back to 1K once
// rather than failing the whole generation over an image-size mismatch.
async function generateImage(ai, contents, aspectRatio, imageSize) {
  try {
    return await withRetry(() => ai.models.generateContent({
      model: IMAGE_MODEL,
      contents,
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize } },
    }), { label: 'thumbnail/image' });
  } catch (error) {
    if (imageSize !== '1K' && isImageSizeRejection(error)) {
      return withRetry(() => ai.models.generateContent({
        model: IMAGE_MODEL,
        contents,
        config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize: '1K' } },
      }), { label: 'thumbnail/image' });
    }
    throw error;
  }
}

function extractInlineImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const imagePart = [...parts].reverse().find((part) => part.inlineData?.data);
  if (imagePart?.inlineData?.data) return imagePart.inlineData;
  const generated = response?.generatedImages?.[0]?.image;
  if (generated?.imageBytes) {
    return { data: generated.imageBytes, mimeType: generated.mimeType || 'image/png' };
  }
  throw new Error('이미지가 생성되지 않았습니다. 프롬프트 또는 API 사용 권한을 확인해 주세요.');
}

function getText(response) {
  const value = typeof response?.text === 'function' ? response.text() : response?.text;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part.text || '').join('').trim();
  if (!text) throw new Error('AI가 텍스트 결과를 반환하지 않았습니다.');
  return text;
}

function parseJson(text) {
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error('AI 결과를 JSON으로 해석하지 못했습니다.');
  }
}

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(currentKey()),
    models: { text: TEXT_MODEL, image: IMAGE_MODEL },
    styleTags: STYLE_TAGS,
  });
});

router.get('/scene-presets', (_req, res) => {
  res.json({ presets: SCENE_PRESETS });
});

router.post('/copy', async (req, res, next) => {
  try {
    const concept = String(req.body?.concept || '').replace(/\s+/g, ' ').trim();
    const avoid = Array.isArray(req.body?.avoid) ? req.body.avoid.slice(0, 60) : [];
    const count = Math.min(5, Math.max(3, Number(req.body?.count) || 5));

    if (!currentKey()) {
      const candidates = generateFallbackCandidates(concept, avoid, count);
      res.json({ candidates, usedFallback: true });
      return;
    }

    const tagList = STYLE_TAGS.map((t) => t.label).join(', ');
    const avoidBlock = avoid.length
      ? `\n\n[최근 사용한 문구 — 절대 반복하지 말 것]\n${avoid.slice(-30).join('\n')}`
      : '';
    const prompt = `당신은 유튜브 뮤직 채널 썸네일 카피라이터다. 아래 컨셉/키워드에 맞는 썸네일 문구 후보 ${count}개를 만들어라.

[컨셉/키워드]
${concept || '(자유 주제 — 편안한 노래 채널 톤으로)'}

[스타일 태그] 아래 태그 중에서 후보마다 하나씩 서로 다르게 배정: ${tagList}

[규칙]
- 한 후보는 최대 2줄
- 한 줄은 6~14자 내외의 한국어
- 구어체 허용, 자연스러운 말투
- "충격", "소름" 등 과장된 클릭베이트 금지
- 의료·건강 효능을 암시하는 표현 금지
- URL, 가격, 소셜 계정, 전화번호 표기 금지
- 실존 인물이나 브랜드명 언급 금지${avoidBlock}

JSON만 출력 (줄바꿈은 lines 배열 항목으로 분리, 문자열 안에 줄바꿈 문자를 넣지 말 것):
{"candidates":[{"lines":["1줄","2줄"],"styleTag":"위 스타일 태그 중 하나"}]}`;

    const ai = requireGeminiClient();
    const response = await withRetry(() => ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', temperature: 0.95, maxOutputTokens: 2048 },
    }), { label: 'thumbnail/copy' });
    const parsed = parseJson(getText(response));
    const raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const avoidSet = new Set(avoid.map((v) => String(v).trim()));
    const seen = new Set();
    const candidates = [];
    for (const item of raw) {
      const lines = Array.isArray(item?.lines) ? item.lines : [];
      const text = lines.map((l) => String(l || '').trim()).filter(Boolean).slice(0, 2).join('\n').trim()
        || String(item?.text || '').trim();
      if (!text || avoidSet.has(text) || seen.has(text)) continue;
      const { ok } = validateCopyText(text);
      if (!ok) continue;
      seen.add(text);
      candidates.push({ text, styleTag: String(item?.styleTag || '').trim() || STYLE_TAGS[0].label });
      if (candidates.length >= count) break;
    }
    if (candidates.length < count) {
      const filler = generateFallbackCandidates(concept, [...avoid, ...candidates.map((c) => c.text)], count - candidates.length);
      candidates.push(...filler);
    }
    res.json({ candidates, usedFallback: false });
  } catch (error) { next(error); }
});

router.post('/generate-background', async (req, res, next) => {
  try {
    const {
      projectId,
      prompt,
      aspectRatio = '16:9',
      imageSize = IMAGE_SIZE_DEFAULT,
      name = `bg-${Date.now()}`,
    } = req.body;
    if (!String(prompt || '').trim()) throw new Error('배경 이미지 프롬프트가 없습니다.');
    const { id, dir } = await ensureProject(projectId);
    const ai = requireGeminiClient();
    const isCover = aspectRatio === '1:1';
    const finalPrompt = `Create ONE single cohesive background image for a YouTube ${isCover ? 'channel/album cover' : 'video thumbnail'}.
${prompt}

Strict requirements: ${aspectRatio} aspect ratio, full-bleed composition, no split screen, no collage, no text, no letters, no numbers, no captions, no watermark. ${TEXT_SPACE_INSTRUCTION} ${QUALITY_BOOSTER}${isCover ? ` ${ALBUM_COVER_PHRASE}` : ''} ${SAFETY_SUFFIX}`;
    const response = await generateImage(ai, [{ role: 'user', parts: [{ text: finalPrompt }] }], aspectRatio, imageSize);
    const image = extractInlineImage(response);
    const ext = mimeExtension(image.mimeType);
    const filePath = path.join(dir, `${safeName(name)}.${ext}`);
    await fsp.writeFile(filePath, Buffer.from(image.data, 'base64'));
    res.json({ projectId: id, url: toPublicUrl(filePath), mimeType: image.mimeType });
  } catch (error) { next(error); }
});

router.post('/remove-text', async (req, res, next) => {
  try {
    const {
      projectId,
      imageUrl,
      expand = false,
      aspectRatio = '16:9',
      name = `cleaned-${Date.now()}`,
    } = req.body;
    if (!imageUrl) throw new Error('처리할 이미지가 없습니다.');
    const { id, dir } = await ensureProject(projectId);
    const ai = requireGeminiClient();
    const basePart = await filePartFromUrl(imageUrl);
    const instruction = expand
      ? `Remove all existing text, captions, letters, numbers, logos and watermarks from this image, filling the removed areas naturally to match the surrounding style, lighting and composition. Then extend the image content outward (outpainting) on the sides so the final result fully fills a ${aspectRatio} widescreen frame, keeping the original subject centered and the background continuing seamlessly. Do not add any new text.`
      : 'Remove all existing text, captions, letters, numbers, logos and watermarks from this image. Fill the removed areas naturally to match the surrounding style, lighting and composition. Do not add any new text, and do not otherwise change the composition.';
    const response = await generateImage(
      ai,
      [{ role: 'user', parts: [basePart, { text: `${instruction} ${QUALITY_BOOSTER} ${SAFETY_SUFFIX}` }] }],
      aspectRatio,
      IMAGE_SIZE_DEFAULT,
    );
    const image = extractInlineImage(response);
    const ext = mimeExtension(image.mimeType);
    const filePath = path.join(dir, `${safeName(name)}.${ext}`);
    await fsp.writeFile(filePath, Buffer.from(image.data, 'base64'));
    res.json({ projectId: id, url: toPublicUrl(filePath), mimeType: image.mimeType });
  } catch (error) { next(error); }
});

router.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('업로드할 이미지가 없습니다.');
    if (String(req.body.ownershipConfirmed) !== 'true') {
      throw new Error('업로드 이미지의 본인 소유·라이선스 확인이 필요합니다.');
    }
    const { id, dir } = await ensureProject(req.body.projectId);
    const ext = mimeExtension(req.file.mimetype);
    const filePath = path.join(dir, `${safeName(req.body.name || path.parse(req.file.originalname).name)}-${Date.now()}.${ext}`);
    await fsp.writeFile(filePath, req.file.buffer);
    res.json({ projectId: id, url: toPublicUrl(filePath), mimeType: req.file.mimetype });
  } catch (error) { next(error); }
});

export default router;
