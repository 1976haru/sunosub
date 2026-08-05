import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhrase,
  loadLexicon,
  loadStopwords,
  lookupExact,
  scanTextMulti,
  computeSourceCoverage,
} from '../parse/lexicon.js';

test('normalizePhrase lowercases and treats hyphens as spaces', () => {
  assert.equal(normalizePhrase('Sticky-Hot Restlessness'), 'sticky hot restlessness');
  assert.equal(normalizePhrase('  First   Light  '), 'first light');
});

test('loadLexicon reads real ko dictionaries with entries keyed by normalized phrase', () => {
  const nouns = loadLexicon('ko', 'nouns');
  assert.equal(nouns.version, 1);
  assert.ok(nouns.entries['kettle'], 'kettle should be a nouns.json entry');
  assert.equal(nouns.entries['kettle'].ko, '주전자');
});

test('loadLexicon on ja returns the empty skeleton (no ja setpack received yet)', () => {
  const nouns = loadLexicon('ja', 'nouns');
  assert.deepEqual(nouns.entries, {});
});

test('lookupExact matches hyphenated emotion phrases via normalization', () => {
  const emotions = loadLexicon('ko', 'emotions');
  const hit = lookupExact('sticky-hot restlessness', emotions);
  assert.ok(hit);
  assert.equal(hit.ko, '후텁지근한 들썩임');
});

test('lookupExact returns null for a phrase not in the dictionary (never guesses)', () => {
  const emotions = loadLexicon('ko', 'emotions');
  assert.equal(lookupExact('total nonsense phrase', emotions), null);
});

test('scanTextMulti prefers the longest phrase match over splitting into single words', () => {
  const nouns = loadLexicon('ko', 'nouns');
  const timewords = loadLexicon('ko', 'timewords');
  const stopwords = loadStopwords();
  const { matchedTerms } = scanTextMulti(
    'watching the first light open across the kitchen table',
    [{ name: 'timewords', lexicon: timewords }, { name: 'nouns', lexicon: nouns }],
    stopwords
  );
  const terms = matchedTerms.map((m) => m.term);
  assert.ok(terms.includes('first light'), `expected "first light" as one phrase match, got: ${terms.join(', ')}`);
  assert.ok(!terms.includes('first'), 'should not also emit a standalone "first" match once the phrase consumed it');
});

test('scanTextMulti records a word absent from every source as unknown, not a guess', () => {
  const nouns = loadLexicon('ko', 'nouns');
  const timewords = loadLexicon('ko', 'timewords');
  const stopwords = loadStopwords();
  const { matchedTerms, unknownTerms } = scanTextMulti(
    'walking past the trellis at evening',
    [{ name: 'timewords', lexicon: timewords }, { name: 'nouns', lexicon: nouns }],
    stopwords
  );
  assert.ok(unknownTerms.includes('trellis'));
  assert.ok(!matchedTerms.some((m) => m.term === 'trellis'));
});

test('scanTextMulti source priority: timewords wins over nouns when both could match the same span', () => {
  // 'evening' only exists in timewords.json in this repo's dictionaries;
  // this asserts it is tagged with the timewords source, not silently
  // absorbed into a generic 'nouns' bucket.
  const nouns = loadLexicon('ko', 'nouns');
  const timewords = loadLexicon('ko', 'timewords');
  const stopwords = loadStopwords();
  const { matchedTerms } = scanTextMulti(
    'sitting in the evening',
    [{ name: 'timewords', lexicon: timewords }, { name: 'nouns', lexicon: nouns }],
    stopwords
  );
  const eveningMatch = matchedTerms.find((m) => m.term === 'evening');
  assert.ok(eveningMatch);
  assert.equal(eveningMatch.source, 'timewords');
});

test('computeSourceCoverage excludes other-source matches from the ratio, charges unknowns to every source', () => {
  const matchedTerms = [
    { term: 'kettle', ko: '주전자', source: 'nouns' },
    { term: 'evening', ko: '저녁', source: 'timewords' },
  ];
  const unknownTerms = ['trellis'];
  // nouns: 1 matched (kettle) / (1 matched + 1 unknown) = 0.5 — the timewords hit is excluded entirely.
  assert.equal(computeSourceCoverage(matchedTerms, unknownTerms, 'nouns'), 0.5);
});

test('computeSourceCoverage is 0 when nothing from that source matched (empty-dictionary case)', () => {
  const matchedTerms = [{ term: 'evening', ko: '저녁', source: 'timewords' }];
  const unknownTerms = ['kettle', 'table', 'trellis'];
  assert.equal(computeSourceCoverage(matchedTerms, unknownTerms, 'nouns'), 0);
});

test('scanTextMulti bounds its loop even on a long, unmatchable input (no infinite loop)', () => {
  const nouns = loadLexicon('ko', 'nouns');
  const timewords = loadLexicon('ko', 'timewords');
  const stopwords = loadStopwords();
  const longInput = Array.from({ length: 5000 }, (_, i) => `zzzword${i}`).join(' ');
  const start = Date.now();
  const { unknownTerms } = scanTextMulti(
    longInput,
    [{ name: 'timewords', lexicon: timewords }, { name: 'nouns', lexicon: nouns }],
    stopwords
  );
  assert.ok(Date.now() - start < 5000, 'scan should complete quickly, not hang');
  assert.ok(unknownTerms.length <= 2000, 'scan should be capped by MAX_TOKENS_PER_SCAN, not process all 5000 words');
});
