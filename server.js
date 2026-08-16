import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeyIntoEnv, loadPaidKeyIntoEnv, writeKeyFile, writePaidKeyFile, currentKey, hasPaidKey } from './lib/keyStore.js';
import { projectsDir } from './routes/shorts.js';
import { filesDir as thumbnailFilesDir } from './routes/thumbnail.js';
import ytRouter from './routes/yt.js';
import shortsRouter from './routes/shorts.js';
import storyRouter from './routes/story.js';
import timelineRouter from './routes/timeline.js';
import thumbnailRouter from './routes/thumbnail.js';
import socialStudioPackRouter from './tools/social-studio/server/packRoutes.js'; // TASK-S2
import socialStudioHomeRouter from './tools/social-studio/server/homeRoutes.js'; // TASK-S7

loadKeyIntoEnv();
loadPaidKeyIntoEnv(); // TASK CS-v1.8 — optional; no-op if .gemini_key_paid / GEMINI_API_KEY_PAID isn't set

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5300);

app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));

// Shell UI at '/'
app.use(express.static(path.join(__dirname, 'public')));

// Each tool is loaded in the shell as an isolated static bundle.
app.use('/tools/yt', express.static(path.join(__dirname, 'tools', 'yt')));
app.use('/tools/timeline', express.static(path.join(__dirname, 'tools', 'timeline')));
app.use('/tools/shorts', express.static(path.join(__dirname, 'tools', 'shorts')));
app.use('/tools/storyboard', express.static(path.join(__dirname, 'tools', 'storyboard')));
app.use('/tools/thumbnail', express.static(path.join(__dirname, 'tools', 'thumbnail')));

// Story shorts generates images/videos on disk; serve them under its own namespace.
app.use('/api/shorts/files', express.static(projectsDir, { fallthrough: false }));
app.use('/api/thumbnail/files', express.static(thumbnailFilesDir, { fallthrough: false }));

app.get('/api/status', (_req, res) => {
  // TASK CS-v1.8 — paidKeyConfigured is reported alongside the free key's
  // status so the shell can show both badges; never the key values themselves.
  res.json({ ok: true, geminiConfigured: Boolean(currentKey()), paidKeyConfigured: hasPaidKey(), port: PORT });
});

app.post('/api/key', (req, res, next) => {
  try {
    const apiKey = String(req.body?.apiKey || '').trim();
    writeKeyFile(apiKey);
    process.env.GEMINI_API_KEY = apiKey;
    res.json({ ok: true, geminiConfigured: true, paidKeyConfigured: hasPaidKey() });
  } catch (error) {
    next(error);
  }
});

// TASK CS-v1.8 — separate endpoint for the paid tier (routes/yt.js's
// /translate and /regenerate only) so saving one key never touches the other.
app.post('/api/key/paid', (req, res, next) => {
  try {
    const apiKey = String(req.body?.apiKey || '').trim();
    writePaidKeyFile(apiKey);
    process.env.GEMINI_API_KEY_PAID = apiKey;
    res.json({ ok: true, geminiConfigured: Boolean(currentKey()), paidKeyConfigured: true });
  } catch (error) {
    next(error);
  }
});

app.use('/api/yt', ytRouter);
app.use('/api/shorts', shortsRouter);
app.use('/api/story', storyRouter);
app.use('/api/timeline', timelineRouter);
app.use('/api/thumbnail', thumbnailRouter);
app.use('/social-studio', socialStudioHomeRouter); // TASK-S7
app.use('/social-studio', socialStudioPackRouter); // TASK-S2

app.use((error, _req, res, _next) => {
  console.error(error?.message || error);
  const status = Number(error?.status || 500);
  res.status(status).json({ error: error?.message || '서버 처리 중 오류가 발생했습니다.', needsKey: Boolean(error?.needsKey) });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nCreator Studio가 실행되었습니다.`);
  console.log(`브라우저 주소: http://localhost:${PORT}`);
  console.log(`Gemini 키: ${currentKey() ? '설정됨' : '미설정 (일부 기능 제한)'}`);
  console.log(`유튜브 번역기 유료 키: ${hasPaidKey() ? '설정됨 (translate/regenerate가 이 키로 과금됨)' : '미설정 (무료 키로 동작)'}\n`);
});
