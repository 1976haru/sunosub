import { Router } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireGeminiClient, withRetry } from '../lib/gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectsDir = path.join(__dirname, '..', 'output', 'projects');
await fsp.mkdir(projectsDir, { recursive: true });

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

const TEXT_MODEL = process.env.SHORTS_TEXT_MODEL || 'gemini-3.5-flash';
const IMAGE_MODEL = process.env.SHORTS_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
const VIDEO_MODEL = process.env.SHORTS_VIDEO_MODEL || 'veo-3.1-generate-preview';

function safeId(value, fallback = `project-${Date.now()}`) {
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

function projectPath(projectId) {
  return path.join(projectsDir, safeId(projectId));
}

async function ensureProject(projectId) {
  const id = safeId(projectId);
  const dir = projectPath(id);
  await fsp.mkdir(path.join(dir, 'characters'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'images'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'videos'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'uploads'), { recursive: true });
  return { id, dir };
}

function toPublicUrl(absolutePath) {
  const relative = path.relative(projectsDir, absolutePath).split(path.sep).map(encodeURIComponent).join('/');
  return `/api/shorts/files/${relative}`;
}

function resolveFileUrl(fileUrl) {
  if (!fileUrl || !String(fileUrl).startsWith('/api/shorts/files/')) {
    throw new Error('로컬 파일 주소가 올바르지 않습니다.');
  }
  const relative = decodeURIComponent(String(fileUrl).slice('/api/shorts/files/'.length));
  const absolute = path.resolve(projectsDir, relative);
  const base = path.resolve(projectsDir) + path.sep;
  if (!absolute.startsWith(base)) throw new Error('허용되지 않은 파일 경로입니다.');
  return absolute;
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
    const firstObject = cleaned.indexOf('{');
    const lastObject = cleaned.lastIndexOf('}');
    if (firstObject >= 0 && lastObject > firstObject) {
      return JSON.parse(cleaned.slice(firstObject, lastObject + 1));
    }
    throw new Error('AI 결과를 JSON으로 해석하지 못했습니다. 다시 생성해 주세요.');
  }
}

async function generateJson(prompt, temperature = 0.8) {
  const ai = requireGeminiClient();
  const response = await withRetry(() => ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      temperature,
      maxOutputTokens: 20000,
    },
  }));
  return parseJson(getText(response));
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

function normalizeStory(raw, chapterCount) {
  const count = Math.min(15, Math.max(4, Number(chapterCount) || 8));
  const chapters = Array.isArray(raw.chapters) ? raw.chapters.slice(0, count) : [];
  if (!chapters.length) throw new Error('챕터가 생성되지 않았습니다.');
  raw.characters = Array.isArray(raw.characters) ? raw.characters.slice(0, 4) : [];
  raw.chapters = chapters.map((chapter, index) => ({
    chapterNumber: index + 1,
    chapterTitle: chapter.chapterTitle || `장면 ${index + 1}`,
    narration: chapter.narration || chapter.storySummary || '',
    subtitle: chapter.subtitle || chapter.narration || chapter.storySummary || '',
    durationSec: Math.max(3, Math.min(12, Number(chapter.durationSec) || 7)),
    imagePrompt: chapter.imagePrompt || '',
    videoPrompt: chapter.videoPrompt || '',
    soundCue: chapter.soundCue || '',
    imageUrl: null,
    videoUrl: null,
  }));
  raw.youtube = raw.youtube || {};
  return raw;
}

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
    models: { text: TEXT_MODEL, image: IMAGE_MODEL, video: VIDEO_MODEL },
  });
});

router.post('/topics', async (req, res, next) => {
  try {
    const { concept, audience = '전 연령', tone = '감동과 반전', genre = '드라마' } = req.body;
    if (!String(concept || '').trim()) throw new Error('스토리 아이디어를 입력해 주세요.');
    const prompt = `당신은 조회수 높은 세로형 유튜브 스토리 쇼츠 기획자다. 아래 조건에 맞는 서로 겹치지 않는 주제 10개를 제안하라. 반드시 JSON만 출력한다.

[사용자 아이디어]
${concept}

[대상 시청자] ${audience}
[장르] ${genre}
[분위기] ${tone}

JSON 형식:
{"topics":[{"id":"1","title":"짧고 강한 제목","summary":"2~3문장의 줄거리","hook":"첫 2초에 들어갈 궁금증 문장","appeal":"왜 클릭할지 한 문장"}]}

조건:
- 10개 정확히 생성
- 첫 장면에서 갈등이나 질문이 즉시 드러날 것
- 짧은 영상에서도 기승전결과 반전 또는 감정적 보상이 가능할 것
- 한국어 자연스러운 문장
- 다른 설명이나 마크다운 금지`;
    const data = await generateJson(prompt, 0.95);
    const topics = Array.isArray(data.topics) ? data.topics.slice(0, 10) : [];
    if (!topics.length) throw new Error('주제가 생성되지 않았습니다.');
    res.json({ topics });
  } catch (error) { next(error); }
});

router.post('/story', async (req, res, next) => {
  try {
    const {
      topic,
      concept = '',
      audience = '전 연령',
      tone = '감동과 반전',
      genre = '드라마',
      visualStyle = '밝고 따뜻한 3D 애니메이션',
      chapterCount = 8,
      targetDuration = 60,
      language = '한국어',
    } = req.body;
    if (!topic) throw new Error('선택한 주제가 없습니다.');
    const count = Math.min(15, Math.max(4, Number(chapterCount) || 8));
    const seconds = Math.min(180, Math.max(20, Number(targetDuration) || 60));
    const topicText = typeof topic === 'string' ? topic : `${topic.title}\n${topic.summary}\n후킹: ${topic.hook}`;
    const prompt = `당신은 유튜브 세로형 스토리 쇼츠의 각본가, 콘티 작가, 이미지·영상 프롬프트 디렉터다. 아래 기획을 실제 제작 가능한 완성형 쇼츠 프로젝트로 만든다. 반드시 JSON만 출력한다.

[선택 주제]
${topicText}

[원래 아이디어]
${concept}
[대상] ${audience}
[장르] ${genre}
[분위기] ${tone}
[시각 스타일] ${visualStyle}
[출력 언어] ${language}
[장면 수] 정확히 ${count}개
[목표 총 길이] 약 ${seconds}초
[화면 비율] 9:16 세로

JSON 형식:
{
  "title":"쇼츠 제목",
  "hook":"첫 2초 후킹 내레이션",
  "synopsis":"전체 줄거리 3~5문장",
  "ending":"마지막 감정 또는 반전",
  "characters":[
    {"id":"char-1","name":"이름","role":"역할","age":"나이대","personality":"성격","appearance":"외형과 의상에 대한 상세한 한국어 설명","portraitPrompt":"동일 캐릭터 기준 이미지 생성을 위한 상세 영어 프롬프트"}
  ],
  "chapters":[
    {"chapterNumber":1,"chapterTitle":"장면 제목","narration":"실제로 읽을 자연스러운 내레이션 1~3문장","subtitle":"한 화면에 읽기 쉬운 짧은 자막","durationSec":7,"imagePrompt":"한 장의 세로 이미지 생성을 위한 매우 구체적인 영어 프롬프트","videoPrompt":"이 장면 이미지를 4~8초 영상으로 움직이기 위한 영어 프롬프트. 카메라와 동작, 분위기, 효과음 포함","soundCue":"배경음 또는 효과음 제안"}
  ],
  "youtube":{"title":"클릭을 부르는 제목","description":"영상 설명 3~6문장","hashtags":["#스토리쇼츠","#shorts"]}
}

필수 조건:
- chapters는 정확히 ${count}개
- 각 장면은 앞뒤 인과관계가 자연스럽고 같은 인물의 외형·의상이 일관될 것
- 첫 장면은 즉시 궁금증을 만들고 마지막은 반전·통쾌함·감동 중 하나를 줄 것
- 내레이션 전체가 약 ${seconds}초 안에 읽힐 분량
- 이미지 프롬프트에는 single unified image, vertical 9:16, no text, no watermark를 포함
- 영상 프롬프트에는 대사 자막을 넣지 말고 카메라 움직임과 피사체 행동을 명시
- 실존 유명인·저작권 캐릭터를 모방하지 말 것
- 마크다운과 JSON 밖 설명 금지`;
    const data = normalizeStory(await generateJson(prompt, 0.9), count);
    res.json({ project: data });
  } catch (error) { next(error); }
});

router.post('/image', async (req, res, next) => {
  try {
    const {
      projectId,
      prompt,
      referenceUrls = [],
      aspectRatio = '9:16',
      folder = 'images',
      name = `image-${Date.now()}`,
    } = req.body;
    if (!String(prompt || '').trim()) throw new Error('이미지 프롬프트가 없습니다.');
    const { id, dir } = await ensureProject(projectId);
    const ai = requireGeminiClient();
    const parts = [];
    for (const url of Array.isArray(referenceUrls) ? referenceUrls.slice(0, 4) : []) {
      if (url) parts.push(await filePartFromUrl(url));
    }
    const finalPrompt = `Create ONE single cohesive image for a vertical story short.
${prompt}

Strict requirements: ${aspectRatio} aspect ratio, full-bleed composition, no split screen, no collage, no text, no letters, no numbers, no captions, no watermark. Preserve the exact identity, facial features, hair, age, outfit and ethnicity of any supplied character reference images. Do not imitate a living artist or copyrighted franchise.`;
    parts.push({ text: finalPrompt });
    const response = await withRetry(() => ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio, imageSize: '1K' },
      },
    }));
    const image = extractInlineImage(response);
    const ext = mimeExtension(image.mimeType);
    const safeFolder = ['characters', 'images', 'uploads'].includes(folder) ? folder : 'images';
    const filePath = path.join(dir, safeFolder, `${safeName(name)}.${ext}`);
    await fsp.writeFile(filePath, Buffer.from(image.data, 'base64'));
    res.json({ projectId: id, url: toPublicUrl(filePath), mimeType: image.mimeType });
  } catch (error) { next(error); }
});

router.post('/edit-image', async (req, res, next) => {
  try {
    const { projectId, imageUrl, instruction, name = `edited-${Date.now()}`, aspectRatio = '9:16' } = req.body;
    if (!imageUrl || !String(instruction || '').trim()) throw new Error('수정할 이미지와 지시문이 필요합니다.');
    const { id, dir } = await ensureProject(projectId);
    const ai = requireGeminiClient();
    const basePart = await filePartFromUrl(imageUrl);
    const response = await withRetry(() => ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{
        role: 'user',
        parts: [
          basePart,
          { text: `Edit the supplied image according to this request: ${instruction}. Preserve character identity and the existing visual style unless explicitly asked otherwise. Return one single cohesive ${aspectRatio} image. No text, captions, letters, numbers, watermark, collage or split screen.` },
        ],
      }],
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize: '1K' } },
    }));
    const image = extractInlineImage(response);
    const ext = mimeExtension(image.mimeType);
    const filePath = path.join(dir, 'images', `${safeName(name)}.${ext}`);
    await fsp.writeFile(filePath, Buffer.from(image.data, 'base64'));
    res.json({ projectId: id, url: toPublicUrl(filePath), mimeType: image.mimeType });
  } catch (error) { next(error); }
});

router.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('업로드할 이미지가 없습니다.');
    const { id, dir } = await ensureProject(req.body.projectId);
    const folder = req.body.folder === 'characters' ? 'characters' : req.body.folder === 'images' ? 'images' : 'uploads';
    const ext = mimeExtension(req.file.mimetype);
    const filePath = path.join(dir, folder, `${safeName(req.body.name || path.parse(req.file.originalname).name)}-${Date.now()}.${ext}`);
    await fsp.writeFile(filePath, req.file.buffer);
    res.json({ projectId: id, url: toPublicUrl(filePath), mimeType: req.file.mimetype });
  } catch (error) { next(error); }
});

router.post('/video', async (req, res, next) => {
  try {
    const { projectId, imageUrl, prompt, aspectRatio = '9:16', name = `scene-${Date.now()}` } = req.body;
    if (!imageUrl || !String(prompt || '').trim()) throw new Error('영상 시작 이미지와 프롬프트가 필요합니다.');
    const { id, dir } = await ensureProject(projectId);
    const ai = requireGeminiClient();
    const imagePath = resolveFileUrl(imageUrl);
    const bytes = await fsp.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    let operation = await withRetry(() => ai.models.generateVideos({
      model: VIDEO_MODEL,
      prompt: `${prompt}\nCreate one continuous story-short shot. No captions, no on-screen text, no watermark. Preserve the character and composition from the starting image.`,
      image: { imageBytes: bytes.toString('base64'), mimeType },
      config: { numberOfVideos: 1, resolution: '720p', aspectRatio },
    }));
    const deadline = Date.now() + 25 * 60 * 1000;
    while (!operation.done) {
      if (Date.now() > deadline) throw new Error('영상 생성 대기 시간이 25분을 초과했습니다. 잠시 후 다시 시도해 주세요.');
      await new Promise((resolve) => setTimeout(resolve, 10000));
      operation = await ai.operations.getVideosOperation({ operation });
    }
    const video = operation.response?.generatedVideos?.[0]?.video;
    if (!video) {
      const detail = operation.error?.message || '영상 파일이 반환되지 않았습니다.';
      throw new Error(detail);
    }
    const videoPath = path.join(dir, 'videos', `${safeName(name)}.mp4`);
    await ai.files.download({ file: video, downloadPath: videoPath });
    res.json({ projectId: id, url: toPublicUrl(videoPath) });
  } catch (error) { next(error); }
});

router.post('/projects/save', async (req, res, next) => {
  try {
    const { projectId, project } = req.body;
    const { id, dir } = await ensureProject(projectId);
    const payload = { ...project, projectId: id, savedAt: new Date().toISOString() };
    await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(payload, null, 2), 'utf8');
    res.json({ ok: true, projectId: id, url: toPublicUrl(path.join(dir, 'project.json')) });
  } catch (error) { next(error); }
});

router.get('/projects/:projectId/bundle', async (req, res, next) => {
  try {
    const id = safeId(req.params.projectId);
    const dir = projectPath(id);
    await fsp.access(dir);
    res.attachment(`${id}-story-shorts.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', next);
    archive.pipe(res);
    archive.directory(dir, false);
    await archive.finalize();
  } catch (error) { next(error); }
});

export default router;
