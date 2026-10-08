import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { chunkLines, looksIndexable } from '../codebase/chunker';
import { decodeVector, dot, encodeVector, normalize, topK } from '../codebase/vectors';

describe('chunkLines', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('keeps a short file in one chunk', () => {
    assert.deepEqual(chunkLines('a\nb\nc'), [{ startLine: 1, endLine: 3, text: 'a\nb\nc' }]);
  });

  it('makes overlapping windows that cover every line', () => {
    const chunks = chunkLines(lines(130), { maxLines: 60, overlapLines: 10, maxChars: 100_000 });
    assert.deepEqual(chunks.map(c => [c.startLine, c.endLine]), [[1, 60], [51, 110], [101, 130]]);
    assert.equal(chunks[1].text.split('\n')[0], 'line 51');
  });

  it('cuts a window early at the character budget', () => {
    const text = Array.from({ length: 10 }, () => 'x'.repeat(40)).join('\n');
    const chunks = chunkLines(text, { maxLines: 60, overlapLines: 1, maxChars: 100 });
    assert.ok(chunks.every(c => c.text.length <= 100));
    assert.equal(chunks[0].endLine, 2);
    assert.equal(chunks[chunks.length - 1].endLine, 10);
  });

  it('skips blank windows and handles CRLF', () => {
    assert.deepEqual(chunkLines('\r\n\r\n'), []);
    assert.deepEqual(chunkLines('a\r\nb'), [{ startLine: 1, endLine: 2, text: 'a\nb' }]);
  });
});

describe('looksIndexable', () => {
  it('rejects binary and minified files', () => {
    assert.equal(looksIndexable('const a = 1;\nconst b = 2;\n'), true);
    assert.equal(looksIndexable(`PK${String.fromCharCode(0)}${String.fromCharCode(3)}`), false);
    assert.equal(looksIndexable('var a=1;'.repeat(1000)), false);
  });
});

describe('vectors', () => {
  it('round-trips through base64', () => {
    const v = normalize([3, 4, 0]);
    assert.deepEqual([...decodeVector(encodeVector(v))], [...v]);
  });

  it('scores normalized vectors by cosine similarity', () => {
    const a = normalize([1, 0]);
    assert.ok(Math.abs(dot(a, normalize([2, 0])) - 1) < 1e-6);
    assert.ok(Math.abs(dot(a, normalize([0, 5]))) < 1e-6);
  });

  it('returns the k best items, best first', () => {
    const best = topK([5, 1, 9, 3, 7], x => x, 3);
    assert.deepEqual(best.map(b => b.item), [9, 7, 5]);
  });
});
