import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSetPackFile, validateSetPack, normalizeSetPack } from '../parse/setPackLoader.js';
import { generateTextPack } from '../generate/textPack.js';
import { renderPrompt, writePromptFile } from '../generate/promptExport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_V2_PATH = path.join(__dirname, 'fixtures', 'sample-setpack-v2.json');
const OUT_ROOT = path.join(__dirname, '..', 'out');

function loadV2() {
  const data = readSetPackFile(FIXTURE_V2_PATH);
  const { warnings } = validateSetPack(data);
  return normalizeSetPack(data, warnings).normalized;
}

function baseValidSong(overrides = {}) {
  return {
    trackNo: 1,
    title: 'Test Title',
    listenerSituation: 'watching the window at dusk',
    emotionArc: 'sleepy heaviness opening into steady comfort',
    hookPhrase: 'a hook',
    lyrics: 'The kettle sings a note I know\r\nSteam climbs slow where mornings go',
    pov: 'firstPerson',
    ...overrides,
  };
}

test('renderPrompt leaves no unfilled {{PLACEHOLDER}} tokens', () => {
  const normalized = loadV2();
  const localTextpack = generateTextPack(normalized, {});
  const prompt = renderPrompt(normalized, localTextpack);
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/, `expected no leftover placeholders, found: ${(prompt.match(/\{\{[A-Z_]+\}\}/g) || []).join(', ')}`);
});

test('renderPrompt embeds the song list (numbered, real titles) and the storyMaterial JSON (with real lyric lines)', () => {
  const normalized = loadV2();
  const localTextpack = generateTextPack(normalized, {});
  const prompt = renderPrompt(normalized, localTextpack);
  assert.match(prompt, /1\.\s*Morning Kettle Waltz/);
  assert.match(prompt, /18\.\s*The Afternoon Spring Seeped In/);
  assert.match(prompt, /"lyricLines"/);
  assert.match(prompt, /Steam climbs slow where mornings go/);
});

test('renderPrompt embeds channel banned phrases and platform character limits', () => {
  const normalized = loadV2();
  const localTextpack = generateTextPack(normalized, {});
  const prompt = renderPrompt(normalized, localTextpack);
  assert.match(prompt, /구독과 알림/); // _shared banned phrase
  assert.match(prompt, /인스타그램 캡션/);
});

test('renderPrompt lists only the shorts track numbers that the local textpack actually generated (keeps shorts[] alignment on merge)', () => {
  const normalized = loadV2();
  const localTextpack = generateTextPack(normalized, {});
  const prompt = renderPrompt(normalized, localTextpack);
  const trackNos = localTextpack.shorts.map((s) => String(s.trackNo));
  for (const t of trackNos) {
    assert.ok(prompt.includes(t), `expected shorts track number ${t} to appear in the prompt`);
  }
});

test('renderPrompt picks the ja template for a ja-output channel and does not leave placeholders unfilled', () => {
  const data = {
    meta: {
      setName: 'jp-unit-test-set',
      channelId: 'jp-test-channel',
      channelLabel: 'テストチャンネル',
      songCount: 1,
      lyricLanguage: 'english',
    },
    songs: [baseValidSong()],
  };
  const { warnings } = validateSetPack(data);
  const { normalized } = normalizeSetPack(data, warnings);
  assert.equal(normalized.set.outputLanguage, 'ja');
  const prompt = renderPrompt(normalized, { shorts: [] });
  assert.match(prompt, /ストーリーテリング/);
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
});

test('renderPrompt throws a clear error when normalized.set.storyMaterial is missing', () => {
  const normalized = loadV2();
  const broken = { ...normalized, set: { ...normalized.set, storyMaterial: undefined } };
  assert.throws(() => renderPrompt(broken, { shorts: [] }), /storyMaterial/);
});

test('writePromptFile writes out/{setName}/prompt.md', () => {
  const normalized = loadV2();
  const localTextpack = generateTextPack(normalized, {});
  const { promptPath, prompt } = writePromptFile(normalized, localTextpack);
  assert.ok(fs.existsSync(promptPath));
  const onDisk = fs.readFileSync(promptPath, 'utf8');
  assert.equal(onDisk, prompt);
  assert.equal(promptPath, path.join(OUT_ROOT, normalized.set.setName, 'prompt.md'));
});
