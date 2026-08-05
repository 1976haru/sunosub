/**
 * TASK-S4 — closing CTA card. The phrase itself is never written here — it
 * comes from S1's own template pool (templates/{channelId}/youtube-pinned.json,
 * the "구독·알림 유도" phrases already built for the pinned comment) via
 * S1's slotFiller.js, reused exactly as-is (same rotation mechanism, same
 * "skip a template with an unfilled slot, throw if none work" contract) —
 * spec: "문구는 S1의 템플릿 시스템에서 읽는다. 카드 코드에 문장을 쓰지 않는다".
 */

import { loadTemplateFile, selectTemplateWithinLimit } from '../slotFiller.js';
import { fitText, createMeasurer } from '../textFit.js';

/** @returns {string} a CTA phrase picked (deterministically, by setName) from S1's youtube-pinned template pool. */
export function buildCtaText(setName, channelId, slots) {
  const templates = loadTemplateFile(channelId, 'youtube-pinned');
  const pick = selectTemplateWithinLimit(templates, slots, setName, 'card-cta', null, { maxRetries: 5 });
  if (!pick.withinLimit) {
    throw new Error('카드용 CTA 문구를 템플릿에서 만들지 못했습니다 (모든 템플릿의 슬롯이 비어 있거나 너무 깁니다).');
  }
  return pick.text;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} data - { ctaText, channelLabel }
 * @param {object} specs
 * @param {{serifKr:string, sansKr:string}} fonts
 */
export function renderCtaCard(ctx, width, height, data, specs, fonts) {
  const { ctaText, channelLabel } = data;
  const margin = specs.margins.outer;
  const cta = specs.cta;

  ctx.fillStyle = '#2f6f4f';
  ctx.fillRect(0, 0, width, height);

  const maxTextWidth = width - margin * 2;
  const measurer = createMeasurer(ctx, fonts.serifKr);
  const fitted = fitText(ctaText, measurer, {
    maxWidth: maxTextWidth,
    maxLines: 5,
    initialFontSize: cta.fontSize,
    minFontSize: Math.round(cta.fontSize * specs.textFit.minFontSizeRatio),
    fontStepRatio: specs.textFit.fontSizeStepRatio,
    maxAttempts: specs.textFit.maxShrinkAttempts,
  });

  const lineHeight = fitted.fontSize * 1.35;
  const totalHeight = lineHeight * fitted.lines.length;
  let cursorY = (height - totalHeight) / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#f7f5ef';
  for (const line of fitted.lines) {
    ctx.font = `${fitted.fontSize}px "${fonts.serifKr}"`;
    ctx.fillText(line, width / 2, cursorY);
    cursorY += lineHeight;
  }

  ctx.font = `${Math.round(cta.fontSize * 0.5)}px "${fonts.sansKr}"`;
  ctx.fillStyle = 'rgba(247,245,239,0.75)';
  ctx.fillText(channelLabel, width / 2, height - margin - Math.round(cta.fontSize * 0.5) * 1.4);
}
