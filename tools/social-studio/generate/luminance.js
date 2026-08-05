/**
 * TASK-S4 — background luminance sampling for text-color/overlay decisions.
 *
 * Only the region where text will actually sit gets sampled (spec: "텍스트가
 * 놓일 영역만 잘라 휘도를 계산한다"), and the summary statistic is a
 * trimmed-percentile mean, not a plain average — a single bright or dark
 * outlier patch in an otherwise uniform region shouldn't be able to flip the
 * text-color decision. Percentiles and thresholds all come from
 * data/cardSpecs.json's `luminance` block, never hardcoded here.
 */

// Explicit bound on how many pixels get sampled per region (completion
// condition #12) — a stride subsample keeps this correct even for a
// full-height region on a large canvas, not just fast.
function stridedSampleIndices(totalPixels, maxSamples) {
  if (totalPixels <= maxSamples) {
    const all = new Array(totalPixels);
    for (let i = 0; i < totalPixels; i += 1) all[i] = i;
    return all;
  }
  const stride = Math.ceil(totalPixels / maxSamples);
  const indices = [];
  for (let i = 0; i < totalPixels; i += stride) indices.push(i);
  return indices;
}

/** Perceptual luminance (ITU-R BT.601) for one pixel's RGB. */
function pixelLuminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData - from ctx.getImageData(x, y, w, h)
 * @param {number} maxSamples - cardSpecs.json luminance.maxSampledPixels
 * @returns {number[]} sampled per-pixel luminance values (0-255), unsorted
 */
export function sampleLuminance(imageData, maxSamples) {
  const totalPixels = imageData.width * imageData.height;
  const indices = stridedSampleIndices(totalPixels, maxSamples);
  const values = new Array(indices.length);
  for (let i = 0; i < indices.length; i += 1) {
    const pixelIndex = indices[i] * 4;
    values[i] = pixelLuminance(
      imageData.data[pixelIndex],
      imageData.data[pixelIndex + 1],
      imageData.data[pixelIndex + 2]
    );
  }
  return values;
}

/** Trimmed mean between the lower/upper percentile (spec: "하위 25%·상위 75%" 예시), robust to a small bright/dark outlier patch. */
export function trimmedMeanLuminance(values, lowerPercentile, upperPercentile) {
  if (values.length === 0) return 128;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const lowIndex = Math.floor((n - 1) * (lowerPercentile / 100));
  const highIndex = Math.min(n - 1, Math.ceil((n - 1) * (upperPercentile / 100)));
  const slice = sorted.slice(lowIndex, highIndex + 1);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return slice.length ? sum / slice.length : 128;
}

/**
 * Full decision for one text region: which ctx.getImageData to sample, what
 * color the text should be, and whether a translucent panel is needed
 * because the background sits too close to the bright/dark threshold to be
 * a safe bet either way.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number, y:number, width:number, height:number}} region
 * @param {object} luminanceConfig - cardSpecs.json's `luminance` block
 */
export function analyzeRegion(ctx, region, luminanceConfig) {
  const x = Math.max(0, Math.round(region.x));
  const y = Math.max(0, Math.round(region.y));
  const width = Math.max(1, Math.round(region.width));
  const height = Math.max(1, Math.round(region.height));
  const imageData = ctx.getImageData(x, y, width, height);

  const samples = sampleLuminance(imageData, luminanceConfig.maxSampledPixels);
  const luminance = trimmedMeanLuminance(samples, luminanceConfig.lowerPercentile, luminanceConfig.upperPercentile);
  const textColor = luminance >= luminanceConfig.brightThreshold ? 'dark' : 'light';
  const needsOverlay = Math.abs(luminance - luminanceConfig.brightThreshold) <= luminanceConfig.ambiguousBand;

  return { luminance, textColor, needsOverlay };
}
