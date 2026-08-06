import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntryEndpoint, buildEntryXml, validateEntryXml, extractEntryUrl } from '../publish/hatenaAtom.js';

function futureIso(daysAhead = 5) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().replace('Z', '+09:00'); // approximate; exact offset math isn't the point here
}

function pastIso(daysAgo = 1) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().replace('Z', '+09:00');
}

// --- endpoint ---

test('buildEntryEndpoint matches the documented POST URL format', () => {
  assert.equal(
    buildEntryEndpoint('myhatenaid', 'example.hatenablog.jp'),
    'https://blog.hatena.ne.jp/myhatenaid/example.hatenablog.jp/atom/entry'
  );
});

// --- completion condition 3 ---

test('condition 3: buildEntryXml includes app:draft=yes, hatenablog:scheduled=yes, and a future updated', () => {
  const updated = futureIso();
  const xml = buildEntryXml({ title: '今日の曲', contentHtml: '<p>本文</p>', hatenaId: 'myid', updatedIso: updated, category: '音楽' });
  assert.match(xml, /<app:draft>yes<\/app:draft>/);
  assert.match(xml, /<hatenablog:scheduled>yes<\/hatenablog:scheduled>/);
  assert.ok(xml.includes(`<updated>${updated}</updated>`));
});

test('buildEntryXml declares the correct namespaces (verified against official docs)', () => {
  const xml = buildEntryXml({ title: 't', contentHtml: 'c', hatenaId: 'id', updatedIso: futureIso(), category: 'cat' });
  assert.match(xml, /xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.match(xml, /xmlns:app="http:\/\/www\.w3\.org\/2007\/app"/);
  assert.match(xml, /xmlns:hatenablog="http:\/\/www\.hatena\.ne\.jp\/info\/xmlns#hatenablog"/);
});

test('buildEntryXml throws if any required field is missing', () => {
  assert.throws(() => buildEntryXml({ title: '', contentHtml: 'c', hatenaId: 'id', updatedIso: futureIso(), category: 'cat' }));
  assert.throws(() => buildEntryXml({ title: 't', contentHtml: '', hatenaId: 'id', updatedIso: futureIso(), category: 'cat' }));
});

test('buildEntryXml escapes XML-special characters in title and category', () => {
  const xml = buildEntryXml({ title: 'A & B <Test>', contentHtml: '<p>ok</p>', hatenaId: 'id', updatedIso: futureIso(), category: 'cat "1"' });
  assert.ok(xml.includes('A &amp; B &lt;Test&gt;'));
  assert.ok(xml.includes('cat &quot;1&quot;'));
});

// --- validateEntryXml ---

test('validateEntryXml passes a well-formed entry with a future updated', () => {
  const xml = buildEntryXml({ title: 't', contentHtml: '<p>c</p>', hatenaId: 'id', updatedIso: futureIso(), category: 'cat' });
  const result = validateEntryXml(xml);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('condition 4 mechanism: validateEntryXml rejects a past updated time', () => {
  const xml = buildEntryXml({ title: 't', contentHtml: '<p>c</p>', hatenaId: 'id', updatedIso: pastIso(), category: 'cat' });
  const result = validateEntryXml(xml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('미래')));
});

test('validateEntryXml catches an unbalanced tag', () => {
  const brokenXml = '<?xml version="1.0"?><entry><title>t</entry>';
  const result = validateEntryXml(brokenXml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('validateEntryXml catches a missing required element', () => {
  const xml = buildEntryXml({ title: 't', contentHtml: '<p>c</p>', hatenaId: 'id', updatedIso: futureIso(), category: 'cat' })
    .replace('<app:draft>yes</app:draft>', '');
  const result = validateEntryXml(xml);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('app:draft')));
});

// --- extractEntryUrl ---

test('extractEntryUrl pulls the alternate link href from a sample Atom response', () => {
  const sample = `<?xml version="1.0"?><entry xmlns="http://www.w3.org/2005/Atom">
    <link rel="edit" href="https://blog.hatena.ne.jp/id/blog/atom/entry/123"/>
    <link rel="alternate" type="text/html" href="https://example.hatenablog.jp/entry/2026/08/10/090000"/>
  </entry>`;
  assert.equal(extractEntryUrl(sample), 'https://example.hatenablog.jp/entry/2026/08/10/090000');
});

test('extractEntryUrl returns null when no alternate link is present', () => {
  assert.equal(extractEntryUrl('<entry></entry>'), null);
});
