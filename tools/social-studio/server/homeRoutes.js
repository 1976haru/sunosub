/**
 * TASK-S7 — social-studio 홈 화면 라우터 (셸 탭 연결용)
 *
 * 기존 packRoutes.js는 건드리지 않는다. 이 파일은 다음만 추가한다.
 *   GET  /social-studio/            홈 화면 (셸 탭이 iframe으로 여는 곳)
 *   GET  /social-studio/api/sets    out/ 아래 세트 목록
 *   POST /social-studio/api/generate 가사 JSON 업로드 → normalized + textpack 생성
 *   POST /social-studio/api/sets/:setName/regenerate 저장된 원본으로 재생성 (CS-v1.9)
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

// TASK CS-v1.9 작업 B — setName은 URL 경로 세그먼트에서 온다. Express가
// 퍼센트 인코딩을 디코드해 req.params.setName에 슬래시를 되살릴 수 있으므로
// (CLAUDE.md 4.2의 "서버가 전부 재검증한다" 원칙), 문자 화이트리스트와
// resolve() 후 OUT_ROOT 하위인지 이중으로 확인한다.
function resolveSetDir(setName) {
  const raw = String(setName || '');
  if (!raw || raw === '.' || raw === '..' || /[\\/]/.test(raw)) {
    throw httpError('세트 이름이 올바르지 않습니다.');
  }
  const resolvedRoot = path.resolve(OUT_ROOT);
  const resolvedDir = path.resolve(resolvedRoot, raw);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
    throw httpError('세트 이름이 올바르지 않습니다.');
  }
  return resolvedDir;
}

// TASK CS-v1.9 작업 B — /api/generate와 /api/sets/:setName/regenerate가
// 정확히 같은 응답 형태를 내도록(요구사항 5) 한 곳에서만 조립한다. 두
// 엔드포인트가 각자 이 객체를 베껴 쓰면 나중에 한쪽만 고치고 잊는 사고가
// 난다.
function buildGenerationResult(normalized, report, generation, extraWarnings = []) {
  const { textpack, outDir } = generation;
  const mergedWarnings = [
    ...new Set([
      ...(normalized.set.warnings || []),
      ...(textpack.warnings || []),
      ...(generation.warnings || []),
      ...extraWarnings,
    ]),
  ];

  return {
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
  };
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

    // TASK CS-v1.9 작업 A — 원본 가사 JSON 보관. os.tmpdir()의 임시 파일은
    // 기존대로 finally에서 지운다(아래) — 이건 그와 별개로 out/<setName>/에
    // 사본을 남기는 단계다. 이게 있어야 세트 이름만으로 다시 생성(작업 B)할
    // 재료가 남는다. 저장 실패는 이번 생성 결과 자체를 막을 이유가 아니므로
    // 경고로만 알린다 — 이 경우 이 세트는 원클릭 재생성 대상에서 빠진다.
    const sourceWarnings = [];
    try {
      fs.writeFileSync(path.join(generation.outDir, 'source.json'), content, 'utf8');
      fs.writeFileSync(
        path.join(generation.outDir, 'source.meta.json'),
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
    // TASK CS-v1.9 작업 B — 이 응답 조립을 buildGenerationResult()로
    // 옮겼다: /api/sets/:setName/regenerate가 정확히 같은 형태를 내야
    // 해서(요구사항 5), 인라인으로 두 벌 유지하면 한쪽만 고치고 잊는 사고가
    // 난다.
    res.json(buildGenerationResult(normalized, report, generation, sourceWarnings));
  } catch (error) {
    next(error);
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
  }
});

// POST /social-studio/api/sets/:setName/regenerate — TASK CS-v1.9 작업 B:
// 저장해둔 out/<setName>/source.json + source.meta.json으로 /api/generate와
// 동일한 파이프라인을 다시 돌린다. 파일을 다시 찾거나 방식을 다시 고를
// 필요가 없다 — "2. 만들어진 세트" 목록에서 제목만 클릭하면 되는 원클릭
// 생성의 서버쪽 절반이다.
router.post('/api/sets/:setName/regenerate', async (req, res, next) => {
  let tmpFile = null;
  try {
    const setDir = resolveSetDir(req.params.setName);
    const sourcePath = path.join(setDir, 'source.json');
    if (!fs.existsSync(sourcePath)) {
      throw httpError('이 세트는 원본 가사 파일이 없어 다시 생성할 수 없습니다.', 404);
    }

    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(setDir, 'source.meta.json'), 'utf8'));
    } catch {
      // source.meta.json이 없거나 손상됐어도 source.json만으로 재생성은 가능하다
      // (youtubeUrl 없이 진행) — 재생성 자체를 막지 않는다.
    }

    const content = fs.readFileSync(sourcePath, 'utf8');
    const youtubeUrl = typeof meta.youtubeUrl === 'string' ? meta.youtubeUrl : '';
    // TASK CS-v1.9 작업 B 요구사항 3 — 원클릭의 목적은 "좋은 결과물을 바로"이므로
    // 기본 모드는 품질이 가장 높은 gemini다. local(작업 A 이전 세트의 등록 당시
    // 모드)로 되돌리고 싶다면 본문에 mode를 명시한다.
    const mode = VALID_MODES.has(req.body?.mode) ? req.body.mode : 'gemini';

    tmpFile = path.join(os.tmpdir(), `social-studio-regen-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, content, 'utf8');

    const { normalized, report } = runSetPackPipeline(tmpFile);
    const generation = await runGenerationPipeline(normalized, { youtubeUrl, mode });

    res.json(buildGenerationResult(normalized, report, generation));
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
