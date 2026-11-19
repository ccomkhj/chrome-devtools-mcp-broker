import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultStore, renderResult } from '../src/results.js';

const raw = text => ({ content: [{ type: 'text', text }] });
const envelope = result => JSON.parse(result.content[0].text);
const hasCode = code => error => error.code === code;

test('raw results are immutable snapshots and foreign sessions cannot read them', () => {
  const store = new ResultStore();
  const upstream = raw('before');
  const saved = store.put('agent-a', upstream);
  assert.equal(saved.stored, true);
  assert.match(saved.resultId, /^r_[A-Za-z0-9_-]{22}$/u);
  upstream.content[0].text = 'after';
  assert.equal(store.get('agent-a', saved.resultId).content[0].text, 'before');
  assert.throws(() => store.get('agent-b', saved.resultId), hasCode('RESULT_NOT_FOUND'));
  const copy = store.get('agent-a', saved.resultId);
  copy.content[0].text = 'changed copy';
  assert.equal(store.get('agent-a', saved.resultId).content[0].text, 'before');
});

test('TTL is absolute and pruning maintains byte accounting', () => {
  let now = 0;
  const store = new ResultStore({ ttlMs: 100, now: () => now });
  const saved = store.put('a', raw('cached'));
  now = 99;
  store.get('a', saved.resultId);
  now = 100;
  assert.throws(() => store.get('a', saved.resultId), hasCode('RESULT_NOT_FOUND'));
  assert.equal(store.stats().bytes, 0);
  assert.equal(store.stats().entries, 0);
});

test('byte capacity uses LRU while a foreign read cannot change eviction order', () => {
  const value = raw('same sized payload');
  const bytes = Buffer.byteLength(JSON.stringify(value));
  const store = new ResultStore({ maxBytes: bytes * 2, maxEntryBytes: bytes });
  const first = store.put('a', value);
  const second = store.put('b', value);
  store.get('a', first.resultId);
  assert.throws(() => store.get('a', second.resultId), hasCode('RESULT_NOT_FOUND'));
  const third = store.put('c', value);
  assert.deepEqual(store.get('a', first.resultId), value);
  assert.throws(() => store.get('b', second.resultId), hasCode('RESULT_NOT_FOUND'));
  assert.deepEqual(store.get('c', third.resultId), value);
  assert.equal(store.stats().bytes, bytes * 2);
});

test('oversized results are explicit and never evict existing results', () => {
  const store = new ResultStore({ maxBytes: 1000, maxEntryBytes: 100 });
  const saved = store.put('a', raw('small'));
  assert.deepEqual(store.put('a', raw('x'.repeat(100))), { stored: false, reason: 'result_too_large' });
  assert.equal(store.get('a', saved.resultId).content[0].text, 'small');
  const rendered = envelope(renderResult(raw('large'), { stored: false, reason: 'result_too_large' }));
  assert.equal(rendered.stored, false);
  assert.equal(rendered.reason, 'result_too_large');
});

test('entry count independently bounds small results with LRU eviction', () => {
  const store = new ResultStore({ maxEntries: 2 });
  const first = store.put('a', raw('first'));
  const second = store.put('a', raw('second'));
  store.get('a', first.resultId);
  const third = store.put('b', raw('third'));
  assert.equal(store.stats().entries, 2);
  assert.equal(store.stats().maxEntries, 2);
  assert.ok(store.stats().bytes < store.stats().maxBytes);
  assert.equal(store.get('a', first.resultId).content[0].text, 'first');
  assert.throws(() => store.get('a', second.resultId), hasCode('RESULT_NOT_FOUND'));
  assert.equal(store.get('b', third.resultId).content[0].text, 'third');
  assert.equal(new ResultStore().stats().maxEntries, 1024);
  assert.throws(() => new ResultStore({ maxEntries: 0 }), hasCode('INVALID_RESULT_CONFIG'));
});

test('session disposal and clear remove only their intended results', () => {
  const store = new ResultStore();
  const a = store.put('a', raw('a'));
  const b = store.put('b', raw('b'));
  assert.equal(store.deleteSession('a'), 1);
  assert.throws(() => store.get('a', a.resultId), hasCode('RESULT_NOT_FOUND'));
  assert.equal(store.get('b', b.resultId).content[0].text, 'b');
  store.clear();
  assert.equal(store.stats().bytes, 0);
  assert.throws(() => store.get('b', b.resultId), hasCode('RESULT_NOT_FOUND'));
});

test('invalid cache configuration and non-JSON results fail with bounded errors', () => {
  assert.throws(() => new ResultStore({ maxBytes: 0 }), hasCode('INVALID_RESULT_CONFIG'));
  const store = new ResultStore();
  assert.throws(() => store.put('', raw('x')), hasCode('INVALID_SESSION'));
  assert.throws(() => store.put('a', undefined), hasCode('INVALID_RESULT'));
  const circular = {}; circular.self = circular;
  assert.throws(() => store.put('a', circular), hasCode('INVALID_RESULT'));
});

test('hard text budget includes JSON escaping and metadata', () => {
  const result = renderResult(raw('"\\\n\t'.repeat(1000)), { maxChars: 512, resultId: 'r_example', stored: true });
  assert.ok(result.content[0].text.length <= 512);
  const parsed = envelope(result);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.nextOffset, parsed.data.length);
  assert.equal(parsed.totalChars, 4000);
  assert.equal(parsed.resultId, 'r_example');
  assert.equal(result.structuredContent, undefined);
});

test('pagination exactly reconstructs escaped Unicode without splitting surrogate pairs', () => {
  const original = ('😀"\\\n漢字🎉\t\u0000').repeat(500);
  let offset = 0;
  const parts = [];
  let pages = 0;
  while (true) {
    const result = renderResult(raw(original), { maxChars: 512, offset });
    assert.ok(result.content[0].text.length <= 512);
    const parsed = envelope(result);
    assert.ok(parsed.data.isWellFormed());
    parts.push(parsed.data);
    pages += 1;
    if (!parsed.truncated) break;
    assert.ok(parsed.nextOffset > offset);
    offset = parsed.nextOffset;
    assert.ok(pages < 100);
  }
  assert.equal(parts.join(''), original);
  assert.ok(pages > 1);
});

test('manual offsets cannot cut Unicode or run beyond the selected body', () => {
  assert.throws(() => renderResult(raw('a😀b'), { offset: 2 }), hasCode('BAD_OUTPUT_OPTION'));
  assert.throws(() => renderResult(raw('x'), { offset: 2 }), hasCode('BAD_OUTPUT_OPTION'));
  assert.equal(envelope(renderResult(raw('x'), { offset: 1 })).data, '');
});

test('JSON pointer projection handles escaped object keys, arrays, and an empty root pointer', () => {
  const value = { ...raw('original'), structuredContent: { 'a/b': { '~key': ['chosen', false, null] }, '': 'empty key' } };
  assert.equal(envelope(renderResult(value, { select: '/structuredContent/a~1b/~0key/0' })).data, 'chosen');
  assert.equal(envelope(renderResult(value, { select: '/structuredContent/a~1b/~0key/1' })).data, 'false');
  assert.equal(envelope(renderResult(value, { select: '/structuredContent/a~1b/~0key/2' })).data, 'null');
  assert.equal(envelope(renderResult(value, { select: '/structuredContent/' })).data, 'empty key');
  assert.deepEqual(JSON.parse(envelope(renderResult(value, { select: '' })).data), value);
});

test('invalid, missing, inherited and prototype paths are rejected', () => {
  for (const select of ['content', '/missing', '/content/01', '/content/length', '/content/-', '/a~2b', '/a~', '/constructor', '/__proto__', '/prototype']) {
    assert.throws(() => renderResult(raw('x'), { select }), hasCode('INVALID_SELECTION'), select);
  }
  const inherited = Object.create({ hidden: 'secret' });
  inherited.content = [];
  assert.throws(() => renderResult(inherited, { select: '/hidden' }), hasCode('INVALID_SELECTION'));
});

test('literal filters keep adjacent context and report zero matches explicitly', () => {
  const value = raw('first\ncontext\nMATCH .* here\nafter\nlast\nfar\nend');
  const filtered = envelope(renderResult(value, { filter: 'match .*' }));
  assert.equal(filtered.data, 'context\nMATCH .* here\nafter');
  assert.equal(filtered.filtered, true);
  assert.equal(filtered.matchedLines, 1);
  const missing = envelope(renderResult(value, { filter: 'unavailable' }));
  assert.equal(missing.matchedLines, 0);
  assert.equal(missing.data, '');
  assert.equal(missing.truncated, false);
});

test('images are opt-in, only one is returned, and binary data is absent from default text', () => {
  const first = { type: 'image', mimeType: 'image/png', data: 'c2VjcmV0LWltYWdl' };
  const value = { content: [first, { ...first, data: 'bW9yZS1zZWNyZXQ=' }] };
  const hidden = renderResult(value);
  assert.equal(hidden.content.length, 1);
  assert.equal(envelope(hidden).imagesOmitted, 2);
  assert.ok(!hidden.content[0].text.includes(first.data));
  const shown = renderResult(value, { includeImages: true });
  assert.equal(shown.content.length, 2);
  assert.deepEqual(shown.content[1], first);
  assert.equal(envelope(shown).imagesOmitted, 1);
});

test('omitted images come with a hint to read them, inside the text budget', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'c2VjcmV0LWltYWdl' };
  const hidden = renderResult({ content: [{ type: 'text', text: 'x'.repeat(2000) }, image] }, { resultId: 'r_1', stored: true, maxChars: 512 });
  assert.ok(hidden.content[0].text.length <= 512);
  assert.equal(envelope(hidden).hint, 'Use chrome_read with includeImages:true to get the image.');
  assert.equal(envelope(renderResult({ content: [image] }, { includeImages: true })).hint, undefined);
  assert.equal(envelope(renderResult({ content: [image] }, { stored: false, reason: 'result_too_large' })).hint, undefined, 'an unstored result cannot be read again');
  assert.equal(envelope(renderResult(raw('text only'))).hint, undefined);
});

test('audio and embedded blob metadata remain usable without dumping base64', () => {
  const value = { content: [
    { type: 'audio', mimeType: 'audio/wav', data: 'c2VjcmV0LWF1ZGlv' },
    { type: 'resource', resource: { uri: 'file:///trace.bin', mimeType: 'application/octet-stream', blob: 'c2VjcmV0LWJsb2I=' } },
    { type: 'resource_link', name: 'trace', uri: 'file:///trace.txt', mimeType: 'text/plain' },
  ] };
  const parsed = envelope(renderResult(value));
  assert.ok(parsed.data.includes('trace.bin'));
  assert.ok(parsed.data.includes('trace.txt'));
  assert.ok(!parsed.data.includes('c2VjcmV0'));
  assert.equal(JSON.parse(parsed.data)[0].dataOmitted, true);
});

test('upstream errors stay errors and structured-only results remain available', () => {
  const failed = renderResult({ ...raw('operation failed'), isError: true });
  assert.equal(failed.isError, true);
  assert.equal(envelope(failed).ok, false);
  assert.equal(envelope(failed).data, 'operation failed');
  const structured = envelope(renderResult({ content: [], structuredContent: { answer: 42 } }));
  assert.deepEqual(JSON.parse(structured.data), { answer: 42 });
});

test('invalid output budgets and options reject explicitly', () => {
  for (const maxChars of [511, 32001, 1000.1, NaN]) {
    assert.throws(() => renderResult(raw('x'), { maxChars }), hasCode('BAD_OUTPUT_OPTION'));
  }
  for (const filter of ['', 42, 'x'.repeat(257)]) {
    assert.throws(() => renderResult(raw('x'), { filter }), hasCode('BAD_OUTPUT_OPTION'));
  }
  assert.throws(() => renderResult(raw('x'), { includeImages: 'yes' }), hasCode('BAD_OUTPUT_OPTION'));
  assert.throws(() => renderResult(null), hasCode('INVALID_RESULT'));
});
