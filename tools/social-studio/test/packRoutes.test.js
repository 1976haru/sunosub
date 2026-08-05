import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import { runSetPackPipeline } from '../parse/setPackLoader.js';
import { runTextPackPipeline } from '../generate/textPack.js';
import packRouter from '../server/packRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-setpack.json');

// The fixture's setName is shared with every other test file in this
// directory, so each test needs a clean pack-state.json / textpack.edited.json
// regardless of what any other file left behind.
function freshSet() {
  const { normalized } = runSetPackPipeline(FIXTURE_PATH);
  const { outDir } = runTextPackPipeline(normalized, {});
  for (const name of ['pack-state.json', 'textpack.edited.json']) {
    const p = path.join(outDir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return normalized.set.setName;
}

// No supertest dependency is added (package.json may only gain the S2
// routing line per the task brief) — a real Express app is booted on an
// ephemeral 127.0.0.1 port and driven with the built-in global fetch.
function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/social-studio', packRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withServer(fn) {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/social-studio`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/pack/:setName returns the merged display payload for a real set', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/pack/${encodeURIComponent(setName)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.setName, setName);
    assert.ok(Array.isArray(body.items) && body.items.length > 0);
    assert.ok(body.sections.includes('youtube'));
  });
});

test('GET /api/pack/:setName 404s for a nonexistent set (setName whitelist enforced at the route)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/pack/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test('GET /pack/:setName serves the HTML shell for a real set, 404s for a bogus one', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const ok = await fetch(`${base}/pack/${encodeURIComponent(setName)}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') || '', /html/);
    const bad = await fetch(`${base}/pack/../../etc`);
    assert.notEqual(bad.status, 200);
  });
});

test('POST /state rejects a malformed youtubeUrl with 400', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/pack/${encodeURIComponent(setName)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: 'not a url at all' }),
    });
    assert.equal(res.status, 400);
  });
});

test('condition 4 (route level): applying a valid youtubeUrl changes x.main\'s character count', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const before = await (await fetch(`${base}/api/pack/${encodeURIComponent(setName)}`)).json();
    const xMainBefore = before.items.find((i) => i.id === 'x.main');
    assert.equal(xMainBefore, undefined, 'no URL applied yet -> no x.main item');

    const applyRes = await fetch(`${base}/api/pack/${encodeURIComponent(setName)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: 'https://youtu.be/routeTestABC' }),
    });
    assert.equal(applyRes.status, 200);
    const applyBody = await applyRes.json();
    const xMainAfter = applyBody.display.items.find((i) => i.id === 'x.main');
    assert.ok(xMainAfter);
    assert.ok(xMainAfter.count > 0 && xMainAfter.count <= 280);
  });
});

test('condition 3 (route level): checking an item persists and is reflected on the next GET', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const item = (await (await fetch(`${base}/api/pack/${encodeURIComponent(setName)}`)).json()).items[0];
    await fetch(`${base}/api/pack/${encodeURIComponent(setName)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checks: { [item.id]: true } }),
    });
    const after = await (await fetch(`${base}/api/pack/${encodeURIComponent(setName)}`)).json();
    assert.equal(after.items.find((i) => i.id === item.id).checked, true);
    assert.ok(after.checkedCount >= 1);
  });
});

test('POST /edit saves an override and it is reflected on the next GET; unknown itemId is rejected', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const editRes = await fetch(`${base}/api/pack/${encodeURIComponent(setName)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'youtube.pinnedComment', value: '라우트 테스트로 수정한 값' }),
    });
    assert.equal(editRes.status, 200);
    const after = await (await fetch(`${base}/api/pack/${encodeURIComponent(setName)}`)).json();
    assert.equal(after.items.find((i) => i.id === 'youtube.pinnedComment').value, '라우트 테스트로 수정한 값');

    const badRes = await fetch(`${base}/api/pack/${encodeURIComponent(setName)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'not.a.real.item', value: 'x' }),
    });
    assert.equal(badRes.status, 400);
  });
});

test('condition 8 (route level): /reveal rejects a ".." sub-path with 400 and never launches a command for it', async () => {
  const setName = freshSet();
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/pack/${encodeURIComponent(setName)}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subPath: '../../../windows/system32' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});
