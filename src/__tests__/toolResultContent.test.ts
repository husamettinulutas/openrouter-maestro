import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { flattenToolResultContent, promptTsxToText } from '../utils/toolResultContent';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('flattenToolResultContent', () => {
  it('passes a plain string through', () => {
    assert.deepEqual(flattenToolResultContent('done'), { text: 'done', images: [] });
  });

  it('joins text parts', () => {
    const r = flattenToolResultContent([{ value: 'Hello, ' }, { value: 'world' }]);
    assert.equal(r.text, 'Hello, world');
    assert.equal(r.images.length, 0);
  });

  it('renders prompt-tsx parts as their text, not [object Object]', () => {
    const tsx = {
      node: {
        type: 1,
        children: [
          { type: 2, text: 'Fetched https://example.com\n', priority: 1 },
          { type: 1, children: [{ type: 2, text: '<h1>Example Domain</h1>' }] },
        ],
      },
    };
    const r = flattenToolResultContent([{ value: tsx }]);
    assert.equal(r.text, 'Fetched https://example.com\n<h1>Example Domain</h1>');
    assert.ok(!r.text.includes('[object Object]'));
  });

  it('falls back to JSON for an object value without text nodes', () => {
    const r = flattenToolResultContent([{ value: { status: 'ok', count: 2 } }]);
    assert.equal(r.text, '{"status":"ok","count":2}');
  });

  it('decodes text and JSON data parts', () => {
    const r = flattenToolResultContent([
      { mimeType: 'text/plain', data: bytes('line 1\n') },
      { mimeType: 'application/json', data: bytes('{"a":1}') },
    ]);
    assert.equal(r.text, 'line 1\n{"a":1}');
  });

  it('collects images separately', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const r = flattenToolResultContent([{ value: 'Screenshot:' }, { mimeType: 'image/png', data: png }]);
    assert.equal(r.text, 'Screenshot:');
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, 'image/png');
    assert.equal(r.images[0].data, png);
  });

  it('ignores cache_control markers and unknown parts', () => {
    const r = flattenToolResultContent([
      { value: 'kept' },
      { mimeType: 'cache_control', data: bytes('ephemeral') },
      { mimeType: 'application/octet-stream', data: new Uint8Array([0, 1]) },
      null,
      42,
    ]);
    assert.deepEqual(r, { text: 'kept', images: [] });
  });

  it('returns empty output for missing content', () => {
    assert.deepEqual(flattenToolResultContent(undefined), { text: '', images: [] });
  });
});

describe('promptTsxToText', () => {
  it('keeps document order across nesting', () => {
    assert.equal(promptTsxToText([{ text: 'a' }, { children: [{ text: 'b' }, { text: 'c' }] }]), 'abc');
  });
});
