/**
 * TASK-S10 — 3단 비용 구조의 진입점. generate/textPack.js(local, S1)는
 * 건드리지 않는다 — 이 파일이 그 위에 export/gemini 분기를 얹는다.
 *
 * local은 항상 먼저 실행된다(모든 모드의 기준값이자 폴백값). export/gemini는
 * 그 위에 얹히는 추가 단계일 뿐, local 산출물(textpack.local.json)을 절대
 * 지우지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTextPackPipeline, renderMarkdown } from './textPack.js';
import { writePromptFile } from './promptExport.js';
import { runGeminiStorytelling } from './geminiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, '..', 'out');

const VALID_MODES = new Set(['local', 'export', 'gemini']);

/**
 * @param {object} normalized - setPackLoader.normalizeSetPack()의 결과 (set.storyMaterial 포함).
 * @param {object} options - generate/textPack.js가 받는 옵션(timelinePath, youtubeUrl, ...) + { mode }.
 */
export async function runGenerationPipeline(normalized, options = {}) {
  const mode = VALID_MODES.has(options.mode) ? options.mode : 'local';

  // local은 언제나 먼저 실행된다 — 세 모드의 공통 기준값이자, export/gemini가
  // 실패하거나 아직 사람이 가져오기를 하지 않았을 때의 유일한 출력이다.
  // runTextPackPipeline이 textpack.json/.md/local.json을 전부 쓴다(textPack.js
  // 참고) — export/gemini 분기가 실패해도 이 결과가 out/에 그대로 남는다.
  const { textpack: localTextpack, markdown: localMarkdown, outDir } = runTextPackPipeline(normalized, options);

  if (mode === 'local') {
    return { mode, textpack: localTextpack, markdown: localMarkdown, outDir, prompt: null, promptPath: null };
  }

  if (mode === 'export') {
    const { prompt, promptPath } = writePromptFile(normalized, localTextpack);
    // export 모드는 여기서 textpack.json을 바꾸지 않는다 — 사람이 Claude
    // Code/Codex에 prompt.md를 붙여넣고 받은 JSON을
    // POST /api/pack/:setName/import로 가져와야 병합이 일어난다
    // (generate/promptImport.js).
    return { mode, textpack: localTextpack, markdown: localMarkdown, outDir, prompt, promptPath };
  }

  // mode === 'gemini'
  const result = await runGeminiStorytelling(normalized, localTextpack);
  if (!result.usedFallback) {
    const markdown = renderMarkdown(result.textpack);
    fs.writeFileSync(path.join(outDir, 'textpack.json'), JSON.stringify(result.textpack, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'textpack.md'), markdown, 'utf8');
    return { mode, textpack: result.textpack, markdown, outDir, prompt: null, promptPath: null, ...result };
  }
  // 폴백: textpack.json은 이미 local 결과 그대로다(위에서 runTextPackPipeline이 씀) — 추가로 쓸 것이 없다.
  return { mode, textpack: localTextpack, markdown: localMarkdown, outDir, prompt: null, promptPath: null, ...result };
}
