/**
 * TASK-S4 — entry point. Reads S0's normalized.json, renders the cover +
 * tracklist(s) + CTA cards via @napi-rs/canvas, and writes
 * out/{setName}/cards/*.jpg + updates out/{setName}/manifest.json.
 *
 * Independent of S1/S2/S3 — the only input this needs is normalized.json
 * (S0's output) plus, for the CTA phrase, S1's already-existing
 * youtube-pinned template pool (reused via slotFiller.js, not copied).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { renderCoverCard } from './cardLayouts/cover.js';
import { renderTracklistCard } from './cardLayouts/tracklist.js';
import { renderCtaCard, buildCtaText } from './cardLayouts/cta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'out');
const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');
const CARD_SPECS_PATH = path.join(ROOT, 'data', 'cardSpecs.json');

const COVER_SOURCE_CANDIDATES = ['cover-source.jpg', 'cover-source.jpeg', 'cover-source.png', 'cover-source.webp'];
const MAX_TRACKLIST_CARDS = 50; // explicit bound — well past any realistic set size

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

export function loadCardSpecs() {
  return loadJson(CARD_SPECS_PATH);
}

// ---------------------------------------------------------------------------
// Fonts — explicit error on anything missing, never a silent system-font
// fallback (spec 4-1 and completion condition #5).
// ---------------------------------------------------------------------------

class MissingFontError extends Error {}

function requireFont(fontConfig) {
  const filePath = path.join(FONTS_DIR, fontConfig.file);
  if (!fs.existsSync(filePath)) {
    throw new MissingFontError(
      `번들 폰트 파일이 없습니다: ${filePath} — Microsoft 시스템 폰트로 조용히 대체하지 않습니다. 파일을 assets/fonts/에 두세요.`
    );
  }
  if (!GlobalFonts.families.some((f) => f.family === fontConfig.family)) {
    const registered = GlobalFonts.registerFromPath(filePath, fontConfig.family);
    if (!registered) {
      throw new MissingFontError(`폰트 등록에 실패했습니다: ${filePath}`);
    }
  }
  return fontConfig.family;
}

/** Registers every font cardSpecs.json declares and returns their family names, keyed the same way. Throws MissingFontError if any file is absent. */
export function registerRequiredFonts(cardSpecs) {
  const families = {};
  for (const [key, config] of Object.entries(cardSpecs.fonts)) {
    families[key] = requireFont(config);
  }
  return families;
}

/** Korean channels use serifKr/sansKr as named; Japanese channels only ever have Noto Serif JP bundled (spec 4-1's font list has no "Sans JP"), so it fills both roles. */
function resolveFontsForLanguage(families, isJapanese) {
  if (isJapanese) return { serifKr: families.serifJp, sansKr: families.serifJp };
  return { serifKr: families.serifKr, sansKr: families.sansKr };
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

export function loadNormalized(setName) {
  const filePath = path.join(OUT_ROOT, setName, 'normalized.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`normalized.json이 없습니다: ${filePath} (S0을 먼저 실행하세요)`);
  }
  return loadJson(filePath);
}

/** out/{setName}/cover-source.{jpg,jpeg,png,webp} if present, else null (cards.js falls back to a plain color background). */
async function loadCoverSourceImage(outDir) {
  for (const candidate of COVER_SOURCE_CANDIDATES) {
    const filePath = path.join(outDir, candidate);
    if (fs.existsSync(filePath)) {
      return { image: await loadImage(filePath), sourcePath: filePath };
    }
  }
  return { image: null, sourcePath: null };
}

// ---------------------------------------------------------------------------
// JPEG encode with a size-limited quality retry (spec section 3 + completion condition #9)
// ---------------------------------------------------------------------------

export function encodeJpegWithinSizeLimit(canvas, outputSpecs) {
  let quality = outputSpecs.quality;
  let attempts = 0;
  let buffer = canvas.toBuffer('image/jpeg', quality);

  while (
    buffer.length > outputSpecs.maxFileSizeBytes &&
    attempts < outputSpecs.qualityRetryMax &&
    quality > outputSpecs.minQuality
  ) {
    attempts += 1;
    quality = Math.max(outputSpecs.minQuality, quality - outputSpecs.qualityStep);
    buffer = canvas.toBuffer('image/jpeg', quality);
  }

  return { buffer, quality, attempts, withinLimit: buffer.length <= outputSpecs.maxFileSizeBytes };
}

// ---------------------------------------------------------------------------
// manifest.json (assets.cards[]) — atomic write, preserves any other fields
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function updateManifestCards(outDir, cardRelativePaths) {
  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest = { assets: {} };
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = loadJson(manifestPath);
    } catch {
      manifest = { assets: {} };
    }
  }
  manifest.assets = manifest.assets || {};
  manifest.assets.cards = cardRelativePaths;
  atomicWriteJson(manifestPath, manifest);
  return manifestPath;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function chunkSongs(songs, size) {
  const chunks = [];
  for (let i = 0; i < songs.length && chunks.length < MAX_TRACKLIST_CARDS; i += size) {
    chunks.push(songs.slice(i, i + size));
  }
  return chunks;
}

/**
 * @param {string} setName
 * @param {object} [options]
 * @param {'4:5'|'1:1'} [options.sizePreset] - overrides cardSpecs.json's canvas.sizePreset
 * @param {string} [options.youtubeUrl] - forwarded as a CTA template slot if the pool wants it
 */
export async function generateCards(setName, options = {}) {
  const cardSpecs = loadCardSpecs();
  const normalized = loadNormalized(setName);
  const isJapanese = normalized.set.outputLanguage === 'ja';

  const families = registerRequiredFonts(cardSpecs);
  const fonts = resolveFontsForLanguage(families, isJapanese);

  const sizePreset = options.sizePreset || cardSpecs.canvas.sizePreset;
  const size = cardSpecs.canvas.sizes[sizePreset];
  if (!size) throw new Error(`알 수 없는 카드 크기 프리셋입니다: ${sizePreset}`);

  const outDir = path.join(OUT_ROOT, setName);
  const cardsDir = path.join(outDir, 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });

  const { image: coverImage } = await loadCoverSourceImage(outDir);
  const warnings = [];
  if (!coverImage) {
    warnings.push(`out/${setName}/cover-source.{jpg,png,webp}가 없어 단색 배경으로 대체했습니다.`);
  }

  const cardFiles = [];
  let cardIndex = 1;

  function writeCard(canvas, baseName) {
    const { buffer, quality, attempts, withinLimit } = encodeJpegWithinSizeLimit(canvas, cardSpecs.output);
    if (!withinLimit) {
      warnings.push(`${baseName}이(가) 최소 품질(${cardSpecs.output.minQuality})에서도 ${cardSpecs.output.maxFileSizeBytes}바이트를 초과합니다.`);
    }
    const fileName = `${String(cardIndex).padStart(2, '0')}_${baseName}.jpg`;
    cardIndex += 1;
    fs.writeFileSync(path.join(cardsDir, fileName), buffer);
    cardFiles.push({ fileName, quality, retryAttempts: attempts, bytes: buffer.length });
    return fileName;
  }

  // --- cover ---
  const coverCanvas = createCanvas(size.width, size.height);
  renderCoverCard(coverCanvas.getContext('2d'), size.width, size.height, {
    channelLabel: normalized.set.channelLabel,
    conceptLabel: normalized.set.conceptLabel || '',
    trackCount: normalized.set.trackCount,
    coverImage,
  }, cardSpecs, fonts);
  writeCard(coverCanvas, 'cover');

  // --- tracklist(s): every song appears on exactly one card, in trackNo order ---
  const sortedSongs = [...normalized.songs].sort((a, b) => a.trackNo - b.trackNo);
  const chunks = chunkSongs(sortedSongs, cardSpecs.tracklist.tracksPerCard);
  for (const chunk of chunks) {
    const canvas = createCanvas(size.width, size.height);
    renderTracklistCard(canvas.getContext('2d'), size.width, size.height, {
      songs: chunk.map((s) => ({ trackNo: s.trackNo, titleLocalized: s.titleLocalized, title: s.title })),
      showOriginalTitle: cardSpecs.tracklist.showOriginalTitle,
    }, cardSpecs, fonts, isJapanese);
    writeCard(canvas, 'tracklist');
  }

  // --- cta ---
  const ctaSlots = {
    channelLabel: normalized.set.channelLabel,
    conceptLabel: normalized.set.conceptLabel || '',
    trackCount: String(normalized.set.trackCount ?? ''),
  };
  const ctaText = buildCtaText(setName, normalized.set.channelId, ctaSlots);
  const ctaCanvas = createCanvas(size.width, size.height);
  renderCtaCard(ctaCanvas.getContext('2d'), size.width, size.height, {
    ctaText,
    channelLabel: normalized.set.channelLabel,
  }, cardSpecs, fonts);
  writeCard(ctaCanvas, 'cta');

  const cardRelativePaths = cardFiles.map((c) => `cards/${c.fileName}`);
  const manifestPath = updateManifestCards(outDir, cardRelativePaths);

  return { cardFiles, cardRelativePaths, cardsDir, manifestPath, warnings, sizePreset: sizePreset, size };
}

export { MissingFontError };
