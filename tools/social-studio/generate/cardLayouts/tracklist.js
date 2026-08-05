/**
 * TASK-S4 — tracklist card(s): `트랙번호. titleLocalized`, N cards at
 * `tracklist.tracksPerCard` songs each. cards.js is responsible for
 * splitting the 18-song list into chunks and making sure every song lands
 * on exactly one card — this module only ever draws whatever chunk it's
 * given.
 */

import { fitText, createMeasurer } from '../textFit.js';
import { applyKinsoku } from '../kinsoku.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} data - { songs: [{trackNo, titleLocalized, title}], showOriginalTitle }
 * @param {object} specs - full cardSpecs.json
 * @param {{sansKr:string}} fonts
 * @param {boolean} isJapanese - applies kinsoku only for the Japanese channel (spec: 한국어 카드엔 적용 안 함)
 */
export function renderTracklistCard(ctx, width, height, data, specs, fonts, isJapanese) {
  const { songs, showOriginalTitle } = data;
  const margin = specs.margins.outer;
  const tl = specs.tracklist;

  ctx.fillStyle = '#faf8f2';
  ctx.fillRect(0, 0, width, height);

  const maxTextWidth = width - margin * 2;
  const measurer = createMeasurer(ctx, fonts.sansKr);
  const availableHeight = height - margin * 2;
  const perRowBudget = availableHeight / Math.max(1, tl.tracksPerCard);
  // A per-row font size that still leaves room for a 2-line wrap + gap within its budget.
  const rowInitialFontSize = Math.min(tl.rowFontSize, Math.floor((perRowBudget - tl.rowGap) / 2.6));

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  const originalTitleIndent = 24;
  const originalTitleMaxWidth = maxTextWidth - originalTitleIndent;

  // Pass 1: fit every row (and its optional original-title line) first so
  // the whole block's height is known, then vertically center it — a
  // 6-song card at 18 songs/set rarely fills a 1080x1350 canvas otherwise,
  // since typical Korean titles are short. The original-title line goes
  // through fitText too — drawing it with a raw fillText (no width
  // constraint) let a long English title run off the right edge of the
  // card, caught by looking at an actual rendered sample, not a test.
  const rows = songs.map((song) => {
    const label = `${song.trackNo}. ${song.titleLocalized}`;
    const fitted = fitText(label, measurer, {
      maxWidth: maxTextWidth,
      maxLines: 2,
      initialFontSize: rowInitialFontSize,
      minFontSize: Math.max(18, Math.round(rowInitialFontSize * specs.textFit.minFontSizeRatio)),
      fontStepRatio: specs.textFit.fontSizeStepRatio,
      maxAttempts: specs.textFit.maxShrinkAttempts,
    });
    const lines = isJapanese ? applyKinsoku(fitted.lines) : fitted.lines;

    let originalLines = [];
    if (showOriginalTitle && song.title) {
      const originalFitted = fitText(`(${song.title})`, measurer, {
        maxWidth: originalTitleMaxWidth,
        maxLines: 2,
        initialFontSize: tl.originalTitleFontSize,
        minFontSize: Math.max(14, Math.round(tl.originalTitleFontSize * specs.textFit.minFontSizeRatio)),
        fontStepRatio: specs.textFit.fontSizeStepRatio,
        maxAttempts: specs.textFit.maxShrinkAttempts,
      });
      originalLines = originalFitted.lines;
    }

    const rowHeight = lines.length * fitted.fontSize * 1.25 + originalLines.length * tl.originalTitleFontSize * 1.3;
    return { song, lines, fontSize: fitted.fontSize, originalLines, rowHeight };
  });

  const totalHeight = rows.reduce((sum, r) => sum + r.rowHeight, 0) + tl.rowGap * Math.max(0, rows.length - 1);
  let cursorY = Math.max(margin, (height - totalHeight) / 2);

  for (const row of rows) {
    ctx.font = `${row.fontSize}px "${fonts.sansKr}"`;
    ctx.fillStyle = '#1e1e1e';
    for (const line of row.lines) {
      ctx.fillText(line, margin, cursorY);
      cursorY += row.fontSize * 1.25;
    }

    if (row.originalLines.length) {
      ctx.font = `${tl.originalTitleFontSize}px "${fonts.sansKr}"`;
      ctx.fillStyle = '#767676';
      for (const line of row.originalLines) {
        ctx.fillText(line, margin + originalTitleIndent, cursorY);
        cursorY += tl.originalTitleFontSize * 1.3;
      }
    }

    cursorY += tl.rowGap;
  }
}
