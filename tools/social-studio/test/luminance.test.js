import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleLuminance, trimmedMeanLuminance, analyzeRegion } from '../generate/luminance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIGHT_FIXTURE = path.join(__dirname, 'fixtures', 'cover-bright.jpg');
const DARK_FIXTURE = path.join(__dirname, 'fixtures', 'cover-dark.jpg');

const CONFIG = { lowerPercentile: 25, upperPercentile: 75, brightThreshold: 140, ambiguousBand: 25, maxSampledPixels: 200000 };

function fakeImageData(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

// --- trimmedMeanLuminance ---

test('trimmedMeanLuminance on a uniform value returns that value', () => {
  assert.equal(trimmedMeanLuminance([100, 100, 100, 100], 25, 75), 100);
});

test('trimmedMeanLuminance is not skewed by a single bright outlier in an otherwise dark region', () => {
  const values = [...Array(99).fill(10), 255]; // one bright pixel among 99 dark ones
  const trimmed = trimmedMeanLuminance(values, 25, 75);
  const plainMean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(trimmed < plainMean, 'trimmed mean should be pulled less toward the outlier than a plain mean');
  assert.ok(trimmed < 20, `expected the trimmed mean to stay close to 10, got ${trimmed}`);
});

test('trimmedMeanLuminance on an empty array returns a neutral default rather than throwing', () => {
  assert.equal(trimmedMeanLuminance([], 25, 75), 128);
});

// --- sampleLuminance ---

test('sampleLuminance on a solid white region returns ~255', () => {
  const imageData = fakeImageData(10, 10, [255, 255, 255]);
  const samples = sampleLuminance(imageData, 200000);
  assert.ok(samples.every((v) => v > 250));
});

test('sampleLuminance on a solid black region returns ~0', () => {
  const imageData = fakeImageData(10, 10, [0, 0, 0]);
  const samples = sampleLuminance(imageData, 200000);
  assert.ok(samples.every((v) => v < 5));
});

test('sampleLuminance respects maxSampledPixels (explicit bound, completion condition #12)', () => {
  const imageData = fakeImageData(1000, 1000, [128, 128, 128]); // 1,000,000 pixels
  const samples = sampleLuminance(imageData, 1000);
  assert.ok(samples.length <= 1000);
});

// --- completion condition 4: real fixtures must diverge ---

test('condition 4: cover-bright.jpg and cover-dark.jpg produce different textColor decisions', async () => {
  const brightImg = await loadImage(BRIGHT_FIXTURE);
  const darkImg = await loadImage(DARK_FIXTURE);

  const brightCanvas = createCanvas(1080, 1350);
  const brightCtx = brightCanvas.getContext('2d');
  brightCtx.drawImage(brightImg, 0, 0, 1080, 1350);

  const darkCanvas = createCanvas(1080, 1350);
  const darkCtx = darkCanvas.getContext('2d');
  darkCtx.drawImage(darkImg, 0, 0, 1080, 1350);

  const region = { x: 0, y: 900, width: 1080, height: 450 }; // bottom third
  const brightResult = analyzeRegion(brightCtx, region, CONFIG);
  const darkResult = analyzeRegion(darkCtx, region, CONFIG);

  console.log('[condition 4] bright:', JSON.stringify(brightResult), '| dark:', JSON.stringify(darkResult));

  assert.notEqual(brightResult.textColor, darkResult.textColor);
  assert.equal(brightResult.textColor, 'dark'); // bright background -> dark text
  assert.equal(darkResult.textColor, 'light'); // dark background -> light text
  assert.ok(brightResult.luminance > darkResult.luminance);
});

test('analyzeRegion only samples the given region, not the whole canvas', () => {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 50, 100, 50); // bottom half is black

  const topResult = analyzeRegion(ctx, { x: 0, y: 0, width: 100, height: 50 }, CONFIG);
  const bottomResult = analyzeRegion(ctx, { x: 0, y: 50, width: 100, height: 50 }, CONFIG);

  assert.equal(topResult.textColor, 'dark'); // white region -> dark text
  assert.equal(bottomResult.textColor, 'light'); // black region -> light text
});
