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
import { runTextPackPipeline } from '../generate/textPack.js';

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
        updatedAt: mtime,
      });
    }

    sets.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ sets });
  } catch (error) {
    next(error);
  }
});

// POST /social-studio/api/generate — 가사 JSON 내용을 받아 파이프라인 실행
router.post('/api/generate', (req, res, next) => {
  let tmpFile = null;
  try {
    const content = String(req.body?.content || '');
    const youtubeUrl = String(req.body?.youtubeUrl || '').trim();

    if (!content) throw httpError('가사 JSON 내용이 비어 있습니다.');
    if (content.length > MAX_UPLOAD_CHARS) throw httpError('파일이 너무 큽니다.');
    if (youtubeUrl && !/^https?:\/\//i.test(youtubeUrl)) {
      throw httpError('유튜브 주소 형식이 올바르지 않습니다.');
    }

    tmpFile = path.join(os.tmpdir(), `social-studio-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, content, 'utf8');

    const { normalized, report } = runSetPackPipeline(tmpFile);
    const { textpack, outDir } = runTextPackPipeline(normalized, { youtubeUrl });

    res.json({
      ok: true,
      setName: normalized.set.setName,
      channelId: normalized.set.channelId,
      songCount: normalized.songs.length,
      coverage: report.coverage || null,
      unknownTerms: (report.unknownTerms || []).length,
      unmatchedEmotionArcs: (report.unmatchedEmotionArcs || []).length,
      warnings: textpack.warnings || [],
      errors: textpack.errors || [],
      outDir,
      packUrl: `/social-studio/pack/${encodeURIComponent(normalized.set.setName)}`,
    });
  } catch (error) {
    next(error);
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
  }
});

export default router;
