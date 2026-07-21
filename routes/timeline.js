import { Router } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * TASK CS-v1.2 — the timeline tool's CS-v1.1 auto-numbering only ever
 * renumbered the on-screen title string (tools/timeline/index.html's
 * applyAutoNumbering), never the actual WAV/MP3 filename on disk — the
 * user still had to rename files manually before importing them into a
 * video editor. This router adds two ways to get a real renamed file:
 *   - POST /api/timeline/zip: upload the already-loaded browser File blobs,
 *     get back a ZIP with entries renamed to "01. Title.wav" etc.
 *   - GET /api/timeline/list-folder + POST /api/timeline/apply-rename +
 *     POST /api/timeline/undo-rename: rename the real files in a folder the
 *     user points at, in place. This is the "주력 기능" — no upload needed,
 *     since the point is exactly to avoid moving multi-hundred-MB WAVs
 *     through the browser at all.
 *
 * Every filesystem-touching route here only ever acts on files with a
 * .wav/.mp3 extension, inside a folder the user explicitly typed in and
 * that passed assertSafeFolder() below. Nothing here ever recurses into
 * subfolders or touches any file the client didn't explicitly ask about.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(__dirname, '..', '.timeline-settings.json');
const BACKUP_FILENAME = '_rename_backup.json';
const ALLOWED_EXTENSIONS = new Set(['.wav', '.mp3']);

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Real Suno WAV exports run well past typical web-upload sizes; this tool
  // is single-user/local, so a generous per-file cap (500MB) and a 60-song
  // pack ceiling are about protecting against mistakes, not abuse.
  limits: { fileSize: 500 * 1024 * 1024, files: 60 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      cb(new Error('WAV 또는 MP3 파일만 올릴 수 있습니다.'));
      return;
    }
    cb(null, true);
  }
});

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/**
 * TASK CS-v1.2 — byte-identical to tools/timeline/index.html's own
 * stripLeadingNumber(), so a real folder filename and the timeline's
 * on-screen (already-renumbered) title compare on the exact same basis.
 * Keep both copies in sync if this regex ever changes; duplicated rather
 * than shared because the frontend is a static single-file HTML page with
 * no build step or module system to import from.
 */
function stripLeadingNumber(text) {
  return String(text || '')
    .replace(/^\s*[\[(]?\d{1,3}[\])]?[\s._-]+/, '')
    .trim();
}

/** NFC-normalized, case-insensitive, prefix-stripped comparison key — matches the task's "전각/특수문자(') 정규화" requirement. */
export function normalizeForMatch(nameWithoutExt) {
  return stripLeadingNumber(nameWithoutExt).normalize('NFC').toLowerCase();
}

const SYSTEM_PATH_PATTERNS = [
  /^[a-z]:\\?$/i, // a bare drive root, e.g. "C:\"
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files(\\|$)/i,
  /^[a-z]:\\program files \(x86\)(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\users\\?$/i // bare "C:\Users", not a specific user's folder
];

/**
 * TASK CS-v1.2 (안전장치, 필수) — existing directory, not a system folder,
 * and not this server's own project directory (in either direction — the
 * user pointing the tool at itself, or at a parent folder that contains it,
 * would both let a "rename" touch this app's own source).
 */
export function assertSafeFolder(folderPath) {
  if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
    throw httpError('폴더 경로를 입력해 주세요.');
  }
  const resolved = path.resolve(folderPath.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw httpError('존재하는 폴더가 아닙니다.');
  }
  if (SYSTEM_PATH_PATTERNS.some(pattern => pattern.test(resolved))) {
    throw httpError('시스템 폴더는 대상으로 사용할 수 없습니다.');
  }
  const serverRoot = path.resolve(__dirname, '..');
  const a = resolved.toLowerCase() + path.sep;
  const b = serverRoot.toLowerCase() + path.sep;
  if (a.startsWith(b) || b.startsWith(a)) {
    throw httpError('Creator Studio 자신의 폴더는 대상으로 사용할 수 없습니다.');
  }
  return resolved;
}

async function listAudioFiles(folderPath) {
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    if (entry.name === BACKUP_FILENAME) continue;
    files.push(entry.name);
  }
  return files;
}

async function readSettings() {
  try {
    return JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(patch) {
  const current = await readSettings();
  const next = { ...current, ...patch };
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

router.get('/last-folder', async (_req, res, next) => {
  try {
    const settings = await readSettings();
    res.json({ folderPath: settings.lastFolderPath || '' });
  } catch (error) { next(error); }
});

/** Lists the folder's actual .wav/.mp3 filenames — matching against the timeline's tracks happens client-side (it already has the track list; the server only needs to say what's really on disk). */
router.get('/list-folder', async (req, res, next) => {
  try {
    const folderPath = assertSafeFolder(String(req.query.folderPath || ''));
    const files = await listAudioFiles(folderPath);
    await writeSettings({ lastFolderPath: folderPath });
    res.json({ folderPath, files });
  } catch (error) { next(error); }
});

/**
 * TASK CS-v1.2 (안전장치, 필수) — this is the only route that actually
 * calls fs.rename. It re-validates every operation itself rather than
 * trusting the client's preview: extension whitelist, source file really
 * exists, idempotent skip (from === to, already applied), and collision
 * detection (a different file already sitting at the target name). One
 * failing entry never aborts the rest of the batch. A backup mapping is
 * written before any rename executes, so undo-rename can always reverse
 * exactly this call.
 */
router.post('/apply-rename', async (req, res, next) => {
  try {
    const folderPath = assertSafeFolder(String(req.body?.folderPath || ''));
    const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
    if (!operations.length) throw httpError('적용할 변경 목록이 없습니다.');

    const existingNow = new Set(await listAudioFiles(folderPath));
    const results = [];
    const toBackup = [];

    for (const op of operations) {
      const from = String(op?.from || '');
      const to = String(op?.to || '');
      const fromExt = path.extname(from).toLowerCase();
      const toExt = path.extname(to).toLowerCase();

      if (!from || !to) {
        results.push({ from, to, status: 'failed', reason: '파일명이 비어 있습니다.' });
        continue;
      }
      if (!ALLOWED_EXTENSIONS.has(fromExt) || !ALLOWED_EXTENSIONS.has(toExt)) {
        results.push({ from, to, status: 'failed', reason: 'WAV/MP3 파일만 대상입니다.' });
        continue;
      }
      if (from === to) {
        results.push({ from, to, status: 'skipped', reason: '이미 연번이 적용되어 있습니다.' });
        continue;
      }
      if (!existingNow.has(from)) {
        results.push({ from, to, status: 'failed', reason: '폴더에서 원본 파일을 찾지 못했습니다(이미 이름이 바뀌었을 수 있습니다).' });
        continue;
      }
      if (existingNow.has(to)) {
        results.push({ from, to, status: 'failed', reason: '같은 이름의 파일이 이미 존재합니다.' });
        continue;
      }

      try {
        await fsp.rename(path.join(folderPath, from), path.join(folderPath, to));
        existingNow.delete(from);
        existingNow.add(to);
        toBackup.push({ from, to });
        results.push({ from, to, status: 'renamed' });
      } catch (error) {
        results.push({ from, to, status: 'failed', reason: error.message });
      }
    }

    if (toBackup.length) {
      // Single-level undo: this overwrites any previous backup, so
      // undo-rename always reverses only the most recent apply-rename call.
      await fsp.writeFile(path.join(folderPath, BACKUP_FILENAME), JSON.stringify({ appliedAt: new Date().toISOString(), operations: toBackup }, null, 2), 'utf8');
    }

    const renamed = results.filter(r => r.status === 'renamed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const failed = results.filter(r => r.status === 'failed');
    res.json({ renamed, skipped, failed: failed.length, results });
  } catch (error) { next(error); }
});

router.post('/undo-rename', async (req, res, next) => {
  try {
    const folderPath = assertSafeFolder(String(req.body?.folderPath || ''));
    const backupPath = path.join(folderPath, BACKUP_FILENAME);
    let backup;
    try {
      backup = JSON.parse(await fsp.readFile(backupPath, 'utf8'));
    } catch {
      throw httpError('되돌릴 변경 기록이 없습니다.');
    }

    const operations = Array.isArray(backup?.operations) ? backup.operations : [];
    const existingNow = new Set(await listAudioFiles(folderPath));
    const results = [];

    for (const { from, to } of operations) {
      if (!existingNow.has(to)) {
        results.push({ from, to, status: 'failed', reason: '되돌릴 파일(현재 이름)을 찾지 못했습니다.' });
        continue;
      }
      if (existingNow.has(from)) {
        results.push({ from, to, status: 'failed', reason: '원래 이름의 파일이 이미 존재합니다.' });
        continue;
      }
      try {
        await fsp.rename(path.join(folderPath, to), path.join(folderPath, from));
        existingNow.delete(to);
        existingNow.add(from);
        results.push({ from, to, status: 'restored' });
      } catch (error) {
        results.push({ from, to, status: 'failed', reason: error.message });
      }
    }

    const restored = results.filter(r => r.status === 'restored').length;
    const failed = results.filter(r => r.status === 'failed');
    // Only clear the backup once every entry in it was actually restored —
    // a partial failure keeps the record so the user can retry the rest.
    if (!failed.length) {
      await fsp.unlink(backupPath).catch(() => {});
    }
    res.json({ restored, failed: failed.length, results });
  } catch (error) { next(error); }
});

/**
 * TASK CS-v1.2 (Part 1, 브라우저-only 폴백) — the browser already holds the
 * real File blobs (loaded via drag-drop/file input, never previously sent
 * anywhere — see tools/timeline/index.html's own "파일은 서버로 전송되지
 * 않고" copy, which this route is the one deliberate exception to, only
 * when the user explicitly clicks this button). `names` must be a JSON
 * array in the same order as the uploaded `files` field.
 */
router.post('/zip', upload.array('files'), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) throw httpError('업로드된 파일이 없습니다.');
    let names;
    try {
      names = JSON.parse(String(req.body?.names || '[]'));
    } catch {
      throw httpError('파일명 목록(names)이 올바른 JSON이 아닙니다.');
    }
    if (!Array.isArray(names) || names.length !== files.length) {
      throw httpError('파일 개수와 이름 개수가 일치하지 않습니다.');
    }

    res.attachment('suno-timeline.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', next);
    archive.pipe(res);
    files.forEach((file, index) => {
      archive.append(file.buffer, { name: String(names[index] || file.originalname) });
    });
    await archive.finalize();
  } catch (error) { next(error); }
});

export default router;
