import { Router } from 'express';
import { Type } from '@google/genai';
import { requireGeminiClient, withRetry } from '../lib/gemini.js';
import { currentKey } from '../lib/keyStore.js';

const router = Router();
const TOPICS_MODEL = process.env.STORYBOARD_TOPICS_MODEL || 'gemini-2.5-flash';
const CHAPTERS_MODEL = process.env.STORYBOARD_CHAPTERS_MODEL || 'gemini-2.5-pro';

router.get('/status', (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(currentKey()), models: { topics: TOPICS_MODEL, chapters: CHAPTERS_MODEL } });
});

router.post('/topics', async (req, res, next) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) throw new Error('스토리 내용을 입력해주세요.');
    const ai = requireGeminiClient();
    const fullPrompt = `${prompt}\n\n위 요청에 따라 흥미로운 스토리 주제 10개를 만들어줘. 각 주제는 두세 줄 분량의 짧은 요약이어야 해.`;

    const response = await withRetry(() => ai.models.generateContent({
      model: TOPICS_MODEL,
      contents: fullPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            topics: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING,
                description: '2-3줄로 요약된 스토리 주제',
              },
              description: '흥미로운 스토리 주제 10개 목록',
            },
          },
          required: ['topics'],
        },
        maxOutputTokens: 8192,
        temperature: 0.8,
        topK: 40,
        topP: 0.95,
      },
    }));

    const jsonText = response.text;
    if (!jsonText) throw new Error('No text found in generate topics response.');
    const parsed = JSON.parse(jsonText.trim());
    if (!parsed || !Array.isArray(parsed.topics)) throw new Error('Invalid or unexpected JSON structure for topics.');
    res.json({ topics: parsed.topics.slice(0, 10) });
  } catch (error) {
    error.message = `주제 생성에 실패했습니다: ${error.message}`;
    next(error);
  }
});

router.post('/chapters', async (req, res, next) => {
  try {
    const topic = String(req.body?.topic || '').trim();
    if (!topic) throw new Error('선택된 주제가 없습니다.');
    const ai = requireGeminiClient();
    const fullPrompt = `"${topic}"으로 15챕터 스토리를 만들어줘. 각 챕터별 스토리는 2-3줄로 요약하고, 각 챕터에 어울리는 이미지 프롬프트는 **영어로** 작성해줘. 이미지 프롬프트는 한국 웹툰 스타일에 적합해야 해.`;

    const response = await withRetry(() => ai.models.generateContent({
      model: CHAPTERS_MODEL,
      contents: fullPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chapters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  chapterNumber: { type: Type.INTEGER, description: '챕터 번호' },
                  chapterTitle: { type: Type.STRING, description: '챕터 제목' },
                  storySummary: { type: Type.STRING, description: '챕터 요약 스토리 (2-3줄)' },
                  imagePrompt: { type: Type.STRING, description: 'Image generation prompt in English, suitable for a Korean webtoon style.' },
                },
                required: ['chapterNumber', 'chapterTitle', 'storySummary', 'imagePrompt'],
              },
            },
          },
          required: ['chapters'],
        },
        maxOutputTokens: 8192,
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
      },
    }));

    const jsonText = response.text;
    if (!jsonText) throw new Error('No JSON response found for chapter generation.');
    const parsed = JSON.parse(jsonText.trim());
    if (!parsed || !Array.isArray(parsed.chapters)) throw new Error('Invalid or unexpected JSON structure for chapters.');
    res.json({ chapters: parsed.chapters });
  } catch (error) {
    error.message = `챕터 생성에 실패했습니다: ${error.message}`;
    next(error);
  }
});

export default router;
