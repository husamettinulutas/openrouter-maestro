/**
 * Unit tests for OpenRouterChatProvider's pure helper methods.
 *
 * NOTE: These tests exercise the token estimation logic extracted from the provider.
 * The estimateTokens method is private, so we test it indirectly through a small
 * wrapper or by duplicating the logic here for verification.
 *
 * Full integration tests (provideLanguageModelChatResponse, streaming, etc.)
 * require the VS Code extension host and are not included here.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * Mirrors the estimateTokens logic from openRouterProvider.ts.
 * Kept in sync for unit testing without requiring VS Code API imports.
 */
function estimateTokens(text: string): number {
  if (!text) { return 0; }

  let latinChars = 0;
  let nonLatinChars = 0;
  let whitespace = 0;

  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code <= 0x7F) {
      if (/\s/.test(char)) { whitespace++; }
      else { latinChars++; }
    } else if (code <= 0x024F) {
      latinChars++;
    } else {
      nonLatinChars++;
    }
  }

  const latinTokens = Math.ceil(latinChars / 4);
  const nonLatinTokens = Math.ceil(nonLatinChars / 2);
  const wsTokens = Math.ceil(whitespace / 5);

  return Math.max(1, latinTokens + nonLatinTokens + wsTokens);
}

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('should estimate ~1 token per 4 ASCII chars', () => {
    // "hello" = 5 latin chars → ceil(5/4) = 2
    assert.equal(estimateTokens('hello'), 2);
  });

  it('should count whitespace separately', () => {
    // "hello world" = 10 latin + 1 ws → ceil(10/4) + ceil(1/5) = 3 + 1 = 4
    assert.equal(estimateTokens('hello world'), 4);
  });

  it('should estimate more tokens for CJK characters', () => {
    // "你好世界" = 4 non-latin → ceil(4/2) = 2
    const cjk = estimateTokens('你好世界');
    assert.equal(cjk, 2);
  });

  it('should handle Turkish characters as extended Latin', () => {
    // "çğışöü" = 6 extended latin (code points 0x00E7, 0x011F, etc.)
    // All should be counted as latinChars → ceil(6/4) = 2
    const turkish = estimateTokens('çğışöü');
    assert.equal(turkish, 2);
  });

  it('should handle mixed Latin and CJK content', () => {
    // "Hello 你好" = 5 latin + 1 ws + 2 CJK
    // ceil(5/4) + ceil(1/5) + ceil(2/2) = 2 + 1 + 1 = 4
    const mixed = estimateTokens('Hello 你好');
    assert.equal(mixed, 4);
  });

  it('should return at least 1 for non-empty input', () => {
    assert.ok(estimateTokens('a') >= 1);
    assert.ok(estimateTokens('你') >= 1);
  });

  it('should handle long text proportionally', () => {
    const short = estimateTokens('hello');
    const long = estimateTokens('hello'.repeat(100));
    // 100x longer text should produce roughly 100x more tokens
    assert.ok(long > short * 50, `Expected ${long} > ${short * 50}`);
  });
});
