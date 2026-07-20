import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeyIntoEnv, writeKeyFile, currentKey } from './lib/keyStore.js';
import { projectsDir } from './routes/shorts.js';
import ytRouter from './routes/yt.js';
import shortsRouter from './routes/shorts.js';
import storyRouter from './routes/story.js';

loadKeyIntoEnv();

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

// Story shorts generates images/videos on disk; serve them under its own namespace.
app.use('/api/shorts/files', express.static(projectsDir, { fallthrough: false }));

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, geminiConfigured: Boolean(currentKey()), port: PORT });
});

app.post('/api/key', (req, res, next) => {
  try {
    const apiKey = String(req.body?.apiKey || '').trim();
    writeKeyFile(apiKey);
    process.env.GEMINI_API_KEY = apiKey;
    res.json({ ok: true, geminiConfigured: true });
  } catch (error) {
    next(error);
  }
});

app.use('/api/yt', ytRouter);
app.use('/api/shorts', shortsRouter);
app.use('/api/story', storyRouter);

app.use((error, _req, res, _next) => {
  console.error(error?.message || error);
  const status = Number(error?.status || 500);
  res.status(status).json({ error: error?.message || '서버 처리 중 오류가 발생했습니다.', needsKey: Boolean(error?.needsKey) });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nCreator Studio가 실행되었습니다.`);
  console.log(`브라우저 주소: http://localhost:${PORT}`);
  console.log(`Gemini 키: ${currentKey() ? '설정됨' : '미설정 (일부 기능 제한)'}\n`);
});
