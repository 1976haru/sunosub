/**
 * TASK-S7 — social-studio 홈 화면 라우터 (셸 탭 연결용)
 *
 * 기존 packRoutes.js는 건드리지 않는다. 이 파일은 다음만 추가한다.
 *   GET  /social-studio/            홈 화면 (셸 탭이 iframe으로 여는 곳)
 *   GET  /social-studio/api/sets    out/ 아래 세트 목록
 *   POST /social-studio/api/generate 가사 JSON 업로드 → normalized + textpack 생성
 *
 * 외부 네트워크 요청 0건. 파일 경로는 out/ 아래로만 해석한다.
 */

import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSetPackPipeline } from '../parse/setPackLoader.js';
import { runGenerationPipeline } from '../generate/modeOrchestrator.js';
import { geminiStatus } from '../generate/geminiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME_HTML_PATH = path.join(__dirname, '..', 'web', 'home.html');
const OUT_ROOT = path.join(__dirname, '..', 'out');

const MAX_SETS = 500;
const MAX_UPLOAD_CHARS = 20 * 1024 * 1024;

const router = Router();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// GET /social-studio/ — 홈 화면
router.get('/', (_req, res, next) => {
  res.sendFile(HOME_HTML_PATH, (err) => { if (err) next(err); });
});

// GET /social-studio/api/sets — 세트 목록
router.get('/api/sets', (_req, res, next) => {
  try {
    if (!fs.existsSync(OUT_ROOT)) return res.json({ sets: [] });

    const names = fs.readdirSync(OUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .slice(0, MAX_SETS);

    const sets = [];
    for (let i = 0; i < names.length && i < MAX_SETS; i += 1) {
      const name = names[i];
      const dir = path.join(OUT_ROOT, name);
      const has = (f) => fs.existsSync(path.join(dir, f));
      let mtime = null;
      try { mtime = fs.statSync(dir).mtime.toISOString(); } catch { /* ignore */ }

      sets.push({
        setName: name,
        hasNormalized: has('normalized.json'),
        hasTextpack: has('textpack.json'),
        hasCards: fs.existsSync(path.join(dir, 'cards')),
        hasLintReport: has('lint-report.json'),
        hasSource: has('source.json'), // TASK CS-v1.9 작업 A — 제목 클릭 원클릭 재생성 가능 여부
        updatedAt: mtime,
      });
    }

    sets.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ sets });
  } catch (error) {
    next(error);
  }
});

// TASK-S10 — 완료조건 2: 모드를 지정하지 않으면 'local'. 잘못된 값도
// 'local'로 떨어진다(조용한 오동작보다 안전한 기본값이 우선).
const VALID_MODES = new Set(['local', 'export', 'gemini']);

// POST /social-studio/api/generate — 가사 JSON 내용을 받아 파이프라인 실행
router.post('/api/generate', async (req, res, next) => {
  let tmpFile = null;
  try {
    const content = String(req.body?.content || '');
    const youtubeUrl = String(req.body?.youtubeUrl || '').trim();
    const mode = VALID_MODES.has(req.body?.mode) ? req.body.mode : 'local';

    if (!content) throw httpError('가사 JSON 내용이 비어 있습니다.');
    if (content.length > MAX_UPLOAD_CHARS) throw httpError('파일이 너무 큽니다.');
    if (youtubeUrl && !/^https?:\/\//i.test(youtubeUrl)) {
      throw httpError('유튜브 주소 형식이 올바르지 않습니다.');
    }

    tmpFile = path.join(os.tmpdir(), `social-studio-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, content, 'utf8');

    const { normalized, report } = runSetPackPipeline(tmpFile);
    const generation = await runGenerationPipeline(normalized, { youtubeUrl, mode });
    const { textpack, outDir } = generation;

    // TASK CS-v1.9 작업 A — 원본 가사 JSON 보관. os.tmpdir()의 임시 파일은
    // 기존대로 finally에서 지운다(아래) — 이건 그와 별개로 out/<setName>/에
    // 사본을 남기는 단계다. 이게 있어야 세트 이름만으로 다시 생성할 재료가
    // 남는다(다음 작업). 저장 실패는 이번 생성 결과 자체를 막을 이유가
    // 아니므로 경고로만 알린다 — 이 경우 이 세트는 원클릭 재생성 대상에서
    // 빠진다.
    const sourceWarnings = [];
    try {
      fs.writeFileSync(path.join(outDir, 'source.json'), content, 'utf8');
      fs.writeFileSync(
        path.join(outDir, 'source.meta.json'),
        JSON.stringify({ youtubeUrl: youtubeUrl || null, savedAt: new Date().toISOString(), mode }, null, 2) + '\n',
        'utf8'
      );
    } catch (saveError) {
      sourceWarnings.push(
        `원본 가사 파일 보관 실패 — 이 세트는 제목 클릭으로 다시 만들 수 없습니다: ${saveError.message}`
      );
    }

    // TASK-S9 후속 — normalized.set.warnings(예: titleLocalized 폴백 [중요]
    // 경고)와 textpack.warnings는 서로 다른 배열이다. 이전엔 setWarnings로
    // 따로 응답에 실어 home.html의 JS가 화면에서만 합쳤는데, 이러면 응답의
    // warnings 필드만 보는 소비자(curl, 다른 화면, 향후 코드)는 곡 제목
    // 18개가 전부 영어로 나가는 경고를 놓친다. 응답 자체의 warnings를
    // 완결된 목록으로 만든다 — set.warnings를 앞에 두어(더 중대함) [중요]
    // 항목이 먼저 오게 하고, 중복은 제거한다.
    // TASK-S10 — generation.warnings는 gemini 모드의 폴백 사유(설정 미확인,
    // 429, JSON 파싱 실패 등) 같은, local 모드에는 없던 경고다. 위와 같은
    // 이유로 응답의 warnings 하나에 합친다.
    const mergedWarnings = [
      ...new Set([
        ...(normalized.set.warnings || []),
        ...(textpack.warnings || []),
        ...(generation.warnings || []),
        ...sourceWarnings,
      ]),
    ];

    res.json({
      ok: true,
      setName: normalized.set.setName,
      channelId: normalized.set.channelId,
      songCount: normalized.songs.length,
      coverage: report.coverage || null,
      unknownTerms: (report.unknownTerms || []).length,
      unmatchedEmotionArcs: (report.unmatchedEmotionArcs || []).length,
      warnings: mergedWarnings,
      errors: textpack.errors || [],
      outDir,
      packUrl: `/social-studio/pack/${encodeURIComponent(normalized.set.setName)}`,
      mode: generation.mode,
      prompt: generation.prompt || null,
      hasPrompt: Boolean(generation.prompt),
      usedFallback: generation.usedFallback || false,
      requestCount: typeof generation.requestCount === 'number' ? generation.requestCount : null,
    });
  } catch (error) {
    next(error);
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
  }
});

// GET /social-studio/api/gemini-status — TASK-S10: home.html의 "Gemini 자동" 모드 선택 시
// 오늘 사용한 요청 수와 설정 확인 여부를 보여준다. API 키 값 자체는 절대 응답에 넣지 않는다.
router.get('/api/gemini-status', (_req, res, next) => {
  try {
    res.json(geminiStatus());
  } catch (error) {
    next(error);
  }
});

export default router;
