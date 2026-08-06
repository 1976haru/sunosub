/**
 * TASK-S2 — local-only API for the copy/paste screen (web/pack.html).
 *
 * Mounted at '/social-studio' on the SAME app instance server.js already
 * binds to 127.0.0.1 only (see CLAUDE.md 3.1) — this router adds no new
 * listener or interface, so "127.0.0.1 외 바인딩 금지" is satisfied by
 * construction, not by anything in this file.
 *
 * Every :setName is re-validated against out/'s real directory listing on
 * every request via packState.isValidSetName() — never trusted from the
 * URL alone. /reveal never accepts a client-supplied path; it only ever
 * opens the already-whitelisted out/{setName} directory (or a validated
 * sub-path inside it), and launches the OS file-manager via execFile with
 * an argument array — never a shell string — so there's no injection
 * surface even if path validation had a bug.
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isValidSetName,
  buildDisplayItems,
  saveState,
  saveEdit,
  revertEdit,
  isKnownItemId,
  resolveWithinOutDir,
  PackStateError,
} from '../store/packState.js';
import * as history from '../store/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACK_HTML_PATH = path.join(__dirname, '..', 'web', 'pack.html');

const router = Router();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function requireValidSetName(req) {
  const { setName } = req.params;
  if (!isValidSetName(setName)) {
    throw httpError(`존재하지 않는 세트입니다: ${setName}`, 404);
  }
  return setName;
}

// GET /social-studio/pack/:setName — the screen itself
router.get('/pack/:setName', (req, res, next) => {
  try {
    requireValidSetName(req); // 404s early for a bogus set rather than serving a shell that'll just fail its first fetch
    res.type('html').send(fs.readFileSync(PACK_HTML_PATH, 'utf8'));
  } catch (error) {
    next(error);
  }
});

// GET /social-studio/api/pack/:setName — merged textpack + edits + state
router.get('/api/pack/:setName', (req, res, next) => {
  try {
    const setName = requireValidSetName(req);
    res.json(buildDisplayItems(setName));
  } catch (error) {
    next(error);
  }
});

/** Rejects a value that isn't a syntactically valid http(s) URL. Empty string is allowed — it clears the saved URL. */
function isValidHttpUrl(value) {
  if (value === '' || value === undefined || value === null) return true;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * TASK-S6 — a platform section counts as "published" in store/data/history.json
 * only once EVERY item in that section is checked on the copy/paste screen
 * (spec 4-3: 완료 체크). Runs after every /state write so checking or
 * unchecking any box keeps history.js's status in sync with what the screen
 * actually shows — checked-complete -> 'published', anything less ->
 * 'generated'. A missing history entry (lint hasn't run yet for this
 * set/platform, so there's nothing to flip) is silently skipped rather than
 * surfaced as an error to the user.
 */
function syncPublishStatus(setName, display) {
  for (const section of display.sections) {
    const sectionItems = display.items.filter((i) => i.section === section);
    const complete = sectionItems.length > 0 && sectionItems.every((i) => i.checked);
    try {
      history.setStatus(`${setName}#${section}`, complete ? 'published' : 'generated');
    } catch {
      // no history entry yet for this set/platform — nothing to sync
    }
  }
}

// POST /social-studio/api/pack/:setName/state — youtubeUrl and/or checkmarks
router.post('/api/pack/:setName/state', (req, res, next) => {
  try {
    const setName = requireValidSetName(req);
    const body = req.body || {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'youtubeUrl')) {
      const url = String(body.youtubeUrl ?? '').trim();
      if (!isValidHttpUrl(url)) {
        throw httpError('URL 형식이 올바르지 않습니다.');
      }
      patch.youtubeUrl = url;
    }
    if (body.checks && typeof body.checks === 'object') {
      const checks = {};
      const entries = Object.entries(body.checks).slice(0, 500); // explicit bound
      for (const [itemId, checked] of entries) {
        if (!isKnownItemId(setName, itemId)) continue; // silently ignore unknown ids rather than erroring the whole batch
        checks[itemId] = Boolean(checked);
      }
      patch.checks = checks;
    }
    const state = saveState(setName, patch);
    const display = buildDisplayItems(setName);
    syncPublishStatus(setName, display);
    res.json({ ok: true, state, display });
  } catch (error) {
    next(error);
  }
});

// POST /social-studio/api/pack/:setName/edit — save or revert one item's override text
router.post('/api/pack/:setName/edit', (req, res, next) => {
  try {
    const setName = requireValidSetName(req);
    const { itemId, value, revert } = req.body || {};
    if (!itemId || typeof itemId !== 'string') {
      throw httpError('itemId가 필요합니다.');
    }
    if (!isKnownItemId(setName, itemId)) {
      throw httpError(`알 수 없는 itemId입니다: ${itemId}`);
    }
    const edits = revert ? revertEdit(setName, itemId) : saveEdit(setName, itemId, String(value ?? ''));
    res.json({ ok: true, edits, display: buildDisplayItems(setName) });
  } catch (error) {
    next(error);
  }
});

// POST /social-studio/api/pack/:setName/reveal — open the set's out/ folder in the OS file manager
router.post('/api/pack/:setName/reveal', (req, res, next) => {
  try {
    const setName = requireValidSetName(req);
    const subPath = typeof req.body?.subPath === 'string' ? req.body.subPath : '';
    let target;
    try {
      target = resolveWithinOutDir(setName, subPath);
    } catch (error) {
      throw httpError(error.message, 400);
    }

    const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    // execFile with an argument array — never a shell string — so `target`
    // (already whitelisted above) can't be interpreted as shell syntax even
    // if it contained special characters.
    execFile(command, [target], (error) => {
      // explorer.exe on Windows commonly "fails" (non-zero exit) even when
      // it opens the window successfully; this is a fire-and-forget
      // convenience action, so we log but don't fail the request on it.
      if (error) console.error('[social-studio] reveal command error:', error.message);
    });
    res.json({ ok: true, target });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  const status = Number(error?.status) || (error instanceof PackStateError ? 400 : 500);
  res.status(status).json({ error: error?.message || '서버 처리 중 오류가 발생했습니다.' });
});

export default router;
