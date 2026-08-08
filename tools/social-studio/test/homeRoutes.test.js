import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import homeRouter from '../server/homeRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');
const OUT_ROOT = path.join(__dirname, '..', 'out');

// Same "real Express app on an ephemeral port" pattern as packRoutes.test.js
// — no supertest dependency, just the built-in global fetch.
function startServer() {
  const app = express();
  app.use(express.json({ limit: '80mb' }));
  app.use('/social-studio', homeRouter);
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

test('GET /social-studio/ serves the home.html shell', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /소셜 스튜디오/);
  });
});

test('GET /social-studio/api/sets returns {sets: []} when out/ has nothing (never 404s)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/sets');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sets));
  });
});

test('POST /social-studio/api/generate with an empty body is a 400, not a 404 (route exists)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    assert.equal(res.status, 400);
  });
});

// --- TASK-S9 후속 작업 2: 응답 warnings에 set.warnings가 합쳐져 있어야 한다 ---

test('완료조건 2: POST /api/generate response warnings includes the [중요] titleLocalized-fallback warning (merged from normalized.set.warnings, not just textpack.warnings)', async () => {
  const content = fs.readFileSync(FIXTURE_V2_PATH, 'utf8').replace(/^﻿/, '');
  let setName;
  await withServer(async (base) => {
    const res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    setName = body.setName;
    const importantWarning = body.warnings.find((w) => w.startsWith('[중요]') && w.includes('titleLocalized 누락'));
    assert.ok(importantWarning, `expected a [중요] titleLocalized warning in response.warnings, got: ${JSON.stringify(body.warnings)}`);
    // No duplicate strings — the merge in homeRoutes.js must dedupe.
    assert.equal(new Set(body.warnings).size, body.warnings.length, `expected no duplicate warnings, got: ${JSON.stringify(body.warnings)}`);
  });
  fs.rmSync(path.join(OUT_ROOT, setName), { recursive: true, force: true });
});

test('POST /api/generate response warnings has no duplicates even when set.warnings and textpack.warnings happen to overlap', async () => {
  // v1 fixture: titleLocalized present (no fallback warning), but exercises
  // the same merge path with a real, smaller warnings set (seasonMoment
  // promotion note) to confirm the general case doesn't duplicate either.
  const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-setpack.json'), 'utf8').replace(/^﻿/, '');
  let setName;
  await withServer(async (base) => {
    const res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    setName = body.setName;
    assert.equal(new Set(body.warnings).size, body.warnings.length);
    assert.ok(!body.warnings.some((w) => w.includes('titleLocalized 누락')), 'v1 has a real titleLocalized, should never warn about a fallback');
  });
  fs.rmSync(path.join(OUT_ROOT, setName), { recursive: true, force: true });
});
