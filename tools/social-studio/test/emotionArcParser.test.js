import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmotionArc } from '../parse/emotionArcParser.js';
import { loadLexicon } from '../parse/lexicon.js';

const transitions = loadLexicon('ko', 'transitions');
const emotions = loadLexicon('ko', 'emotions');

test('parses the spec example exactly (section 4 of the S0 brief)', () => {
  const result = parseEmotionArc('sleepy heaviness opening into steady comfort', transitions, emotions);
  assert.equal(result.parsed, true);
  assert.equal(result.from.en, 'sleepy heaviness');
  assert.equal(result.from.ko, '나른한 무거움');
  assert.equal(result.transition.en, 'opening');
  assert.equal(result.transition.ko, '풀리며');
  assert.equal(result.to.en, 'steady comfort');
  assert.equal(result.to.ko, '차분한 편안함');
  assert.equal(result.joiner, 'into');
});

test('parses the "toward" joiner variant', () => {
  const result = parseEmotionArc('homesick uncertainty easing toward curious wonder', transitions, emotions);
  assert.equal(result.parsed, true);
  assert.equal(result.joiner, 'toward');
  assert.equal(result.to.en, 'curious wonder');
});

test('a multi-word transition ("lighting up") is matched as one unit, not split', () => {
  const result = parseEmotionArc('quiet awe lighting up into calm belonging', transitions, emotions);
  assert.equal(result.parsed, true);
  assert.equal(result.transition.en, 'lighting up');
  assert.equal(result.from.en, 'quiet awe');
});

test('a string with no into/toward joiner is parsed:false with everything else null', () => {
  const result = parseEmotionArc('just happy', transitions, emotions);
  assert.equal(result.parsed, false);
  assert.equal(result.from, null);
  assert.equal(result.transition, null);
  assert.equal(result.to, null);
  assert.equal(result.joiner, null);
  assert.equal(result.raw, 'just happy');
});

test('a joiner present but no known transition verb before it is parsed:false, not guessed', () => {
  const result = parseEmotionArc('some feeling nonexistentverb into another feeling', transitions, emotions);
  assert.equal(result.parsed, false);
});

test('an emotion phrase absent from the dictionary yields ko:null but still parses grammatically', () => {
  const result = parseEmotionArc('totally unlisted feeling opening into another unlisted feeling', transitions, emotions);
  assert.equal(result.parsed, true);
  assert.equal(result.from.ko, null);
  assert.equal(result.to.ko, null);
  assert.equal(result.from.en, 'totally unlisted feeling');
});
