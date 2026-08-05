/**
 * TASK-S4 — line wrapping, auto-shrink, and ellipsis truncation.
 *
 * Song titles vary wildly in length (spec's own examples: "느린 아침" at 4
 * characters up to "Music Down the Boardwalk"), so this can't assume a
 * fixed line count fits at a fixed font size. The order is always: wrap ->
 * if still too many lines, shrink font and re-wrap -> once the minimum
 * font size is hit, ellipsis-truncate the last visible line. Every step is
 * explicitly bounded, and wrapToWidth is built so that even a single
 * pathologically long unbreakable run (a long English word with no spaces)
 * gets split character-by-character rather than ever producing a line
 * wider than maxWidth — "글자가 카드 밖으로 넘치면 안 된다" has to hold
 * unconditionally, not just for well-behaved input.
 */

const MAX_UNITS = 5000; // explicit bound on tokenized units per string
const MAX_ELLIPSIS_ITERATIONS = 500; // explicit bound on the truncate-and-remeasure loop

const CJK_PATTERN = /[　-ヿ㐀-鿿가-힣豈-﫿＀-￯]/;
const SPACE_PATTERN = /\s/;

/**
 * Splits text into wrap units: each CJK character is its own unit (can
 * break anywhere), each run of whitespace is its own unit, and each run of
 * everything else (Latin words, punctuation, digits) is kept whole so an
 * English word never gets split mid-word by ordinary wrapping.
 */
function tokenizeUnits(text) {
  const units = [];
  let i = 0;
  while (i < text.length && units.length < MAX_UNITS) {
    const ch = text[i];
    if (SPACE_PATTERN.test(ch)) {
      let j = i;
      while (j < text.length && SPACE_PATTERN.test(text[j])) j += 1;
      units.push(text.slice(i, j));
      i = j;
    } else if (CJK_PATTERN.test(ch)) {
      units.push(ch);
      i += 1;
    } else {
      let j = i;
      while (j < text.length && !SPACE_PATTERN.test(text[j]) && !CJK_PATTERN.test(text[j])) j += 1;
      units.push(text.slice(i, j));
      i = j;
    }
  }
  return units;
}

/**
 * Binds a measureFn to a specific canvas context + font family, so callers
 * don't have to juggle `ctx.font` themselves. Works with any ctx-like object
 * exposing `.font` (settable) and `.measureText(text).width` — real
 * @napi-rs/canvas context in production, a small fake in unit tests.
 */
export function createMeasurer(ctx, fontFamily) {
  return (text, fontSize) => {
    ctx.font = `${fontSize}px "${fontFamily}"`;
    return ctx.measureText(text).width;
  };
}

/**
 * @param {string} text
 * @param {(text: string, fontSize: number) => number} measureFn - width in px for `text` set at `fontSize`
 * @param {number} maxWidth
 * @param {number} fontSize
 * @returns {string[]}
 */
export function wrapToWidth(text, measureFn, maxWidth, fontSize) {
  const rawUnits = tokenizeUnits(String(text ?? ''));

  // A unit wider than maxWidth all by itself (a long unbroken English word)
  // gets force-split into characters so it can never define an overflowing
  // line on its own.
  const units = [];
  for (const unit of rawUnits) {
    if (unit.length > 1 && !SPACE_PATTERN.test(unit) && measureFn(unit, fontSize) > maxWidth) {
      units.push(...unit.split(''));
    } else {
      units.push(unit);
    }
  }

  const lines = [];
  let current = '';
  for (const unit of units) {
    const candidate = current + unit;
    if (current !== '' && measureFn(candidate, fontSize) > maxWidth) {
      lines.push(current.replace(/\s+$/, ''));
      current = unit.replace(/^\s+/, '');
    } else {
      current = candidate;
    }
  }
  if (current.trim() !== '' || lines.length === 0) {
    lines.push(current.replace(/\s+$/, ''));
  }
  return lines;
}

function truncateWithEllipsis(line, measureFn, maxWidth, fontSize) {
  let text = line;
  let iterations = 0;
  while (text.length > 0 && measureFn(`${text}…`, fontSize) > maxWidth && iterations < MAX_ELLIPSIS_ITERATIONS) {
    text = text.slice(0, -1);
    iterations += 1;
  }
  return `${text}…`;
}

/**
 * Wraps `text`, shrinking the font up to `maxAttempts` times if it still
 * doesn't fit in `maxLines`, and ellipsis-truncating the last line if even
 * the minimum font size doesn't bring it down to `maxLines`.
 *
 * @param {object} options
 * @param {number} options.maxWidth
 * @param {number} options.maxLines
 * @param {number} options.initialFontSize
 * @param {number} options.minFontSize
 * @param {number} [options.fontStepRatio] - default 0.9
 * @param {number} [options.maxAttempts] - default 8 (spec 4-2: "재시도 상한은 8회로 명시한다")
 * @param {(text: string, fontSize: number) => number} measureFn
 */
export function fitText(text, measureFn, options) {
  const { maxWidth, maxLines, initialFontSize, minFontSize, fontStepRatio = 0.9, maxAttempts = 8 } = options;

  let fontSize = initialFontSize;
  let lines = wrapToWidth(text, measureFn, maxWidth, fontSize);
  let attempts = 0;

  while (lines.length > maxLines && fontSize > minFontSize && attempts < maxAttempts) {
    attempts += 1;
    fontSize = Math.max(minFontSize, Math.round(fontSize * fontStepRatio));
    lines = wrapToWidth(text, measureFn, maxWidth, fontSize);
  }

  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = truncateWithEllipsis(lines[maxLines - 1], measureFn, maxWidth, fontSize);
    truncated = true;
  }

  return { lines, fontSize, truncated, attempts };
}
