/**
 * TASK-S4 — cover card (01_cover.jpg): channel name, concept, track count
 * over the set's own cover image.
 *
 * The cover image may already have its own text baked in (spec warning),
 * and we have no way to actually detect that (no vision/OCR API allowed) —
 * so the safe default is to always lay a translucent panel under the fixed
 * bottom-third text zone, strengthened further when luminance.js finds the
 * background luminance too close to the bright/dark threshold to be a safe
 * bet either way.
 */

import { fitText, createMeasurer } from '../textFit.js';
import { analyzeRegion } from '../luminance.js';

function drawCoverImage(ctx, image, width, height, fallbackColor) {
  ctx.fillStyle = fallbackColor;
  ctx.fillRect(0, 0, width, height);
  if (!image) return;
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {object} data - { channelLabel, conceptLabel, trackCount, coverImage }
 * @param {object} specs - full cardSpecs.json
 * @param {{serifKr:string, sansKr:string}} fonts - registered font family names
 */
export function renderCoverCard(ctx, width, height, data, specs, fonts) {
  const { channelLabel, conceptLabel, trackCount, coverImage } = data;
  const margin = specs.margins.outer;
  const coverSpecs = specs.cover;

  drawCoverImage(ctx, coverImage, width, height, '#20242e');

  const textAreaHeight = Math.round(height * coverSpecs.textAreaHeightRatio);
  const region = { x: 0, y: height - textAreaHeight, width, height: textAreaHeight };
  const { textColor, needsOverlay } = analyzeRegion(ctx, region, specs.luminance);

  const overlayOpacity = needsOverlay
    ? Math.max(coverSpecs.overlayOpacity, specs.luminance.overlayOpacityWhenAmbiguous)
    : coverSpecs.overlayOpacity;
  ctx.fillStyle = `rgba(0,0,0,${overlayOpacity})`;
  ctx.fillRect(region.x, region.y, region.width, region.height);

  const fillColor = textColor === 'dark' ? '#1a1a1a' : '#f7f5ef';
  const maxTextWidth = width - margin * 2;

  const conceptTitleMeasurer = createMeasurer(ctx, fonts.serifKr);

  let cursorY = region.y + margin * 0.6;

  // channel label (small, sans)
  ctx.font = `${coverSpecs.trackCountFontSize}px "${fonts.sansKr}"`;
  ctx.fillStyle = fillColor;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(channelLabel, margin, cursorY);
  cursorY += coverSpecs.trackCountFontSize * 1.4;

  // concept label (large, serif) — auto-shrinks/wraps like any other card text
  const fitted = fitText(conceptLabel, conceptTitleMeasurer, {
    maxWidth: maxTextWidth,
    maxLines: 2,
    initialFontSize: coverSpecs.titleFontSize,
    minFontSize: coverSpecs.minTitleFontSize,
    fontStepRatio: specs.textFit.fontSizeStepRatio,
    maxAttempts: specs.textFit.maxShrinkAttempts,
  });
  ctx.font = `${fitted.fontSize}px "${fonts.serifKr}"`;
  ctx.fillStyle = fillColor;
  for (const line of fitted.lines) {
    ctx.fillText(line, margin, cursorY);
    cursorY += fitted.fontSize * 1.3;
  }

  // track count tag (small, sans)
  cursorY += margin * 0.2;
  ctx.font = `${coverSpecs.conceptFontSize * 0.8}px "${fonts.sansKr}"`;
  ctx.fillStyle = fillColor;
  ctx.fillText(`${trackCount}곡`, margin, cursorY);
}
