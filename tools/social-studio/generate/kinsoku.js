/**
 * TASK-S4 — Japanese line-break prohibitions (禁則処理), applied only to
 * Japanese-channel cards (spec: "한국어 카드에는 적용하지 않는다").
 *
 * Fix strategy matters here: this runs AFTER textFit.js has already wrapped
 * lines to fit the card's width, so the fix can only ever move characters
 * DOWN to the next line (shortening the line above), never grow a line —
 * growing it could push it past the card edge, which is exactly what
 * textFit.js was used to prevent. Concretely: a forbidden leading character
 * is pulled back onto the previous line together with that line's own last
 * character, both moving down together — the previous line gets shorter,
 * never longer.
 */

const LEADING_FORBIDDEN = new Set([...'、。，．・：；？！ヽヾゝゞ々ー）］｝〕〉》」』】ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ']);
const TRAILING_FORBIDDEN = new Set([...'（［｛〔〈《「『【']);

const MAX_PASSES = 50; // explicit bound (completion condition #12) — cascades settle in at most (line count) passes in practice

/**
 * @param {string[]} lines - already width-wrapped lines (e.g. from textFit.js's wrapToWidth)
 * @returns {string[]} lines with no forbidden leading/trailing character
 */
export function applyKinsoku(lines) {
  const result = [...lines];
  let changed = true;
  let passes = 0;

  while (changed && passes < MAX_PASSES) {
    changed = false;
    passes += 1;

    for (let i = 1; i < result.length; i += 1) {
      // A forbidden character must not START line i — pull it (and the
      // character before it) back onto line i-1.
      let guard = 0;
      while (
        result[i].length > 0 &&
        LEADING_FORBIDDEN.has(result[i][0]) &&
        result[i - 1].length > 0 &&
        guard < MAX_PASSES
      ) {
        guard += 1;
        const movedChar = result[i - 1][result[i - 1].length - 1];
        result[i - 1] = result[i - 1].slice(0, -1);
        result[i] = movedChar + result[i];
        changed = true;
      }
    }

    for (let i = 0; i < result.length - 1; i += 1) {
      // A forbidden character must not END line i — push it forward onto
      // the front of line i+1 (an opening bracket is always fine as a line
      // START, so it doesn't need a companion character).
      let guard = 0;
      while (
        result[i].length > 0 &&
        TRAILING_FORBIDDEN.has(result[i][result[i].length - 1]) &&
        guard < MAX_PASSES
      ) {
        guard += 1;
        const movedChar = result[i][result[i].length - 1];
        result[i] = result[i].slice(0, -1);
        result[i + 1] = movedChar + result[i + 1];
        changed = true;
      }
    }
  }

  return result.filter((line, idx) => line.length > 0 || idx === result.length - 1);
}

export function violatesLeadingRule(char) {
  return LEADING_FORBIDDEN.has(char);
}

export function violatesTrailingRule(char) {
  return TRAILING_FORBIDDEN.has(char);
}
