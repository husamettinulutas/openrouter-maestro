import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normalizeApiKey, isLikelyOpenRouterKey } from '../utils/apiKeyUtils';

describe('normalizeApiKey', () => {
  it('should return trimmed key for a clean key', () => {
    assert.equal(normalizeApiKey('sk-or-v1-abc123'), 'sk-or-v1-abc123');
  });

  it('should strip leading/trailing whitespace', () => {
    assert.equal(normalizeApiKey('  sk-or-v1-abc123  '), 'sk-or-v1-abc123');
  });

  it('should strip "Bearer " prefix (case-insensitive)', () => {
    assert.equal(normalizeApiKey('Bearer sk-or-v1-abc123'), 'sk-or-v1-abc123');
    assert.equal(normalizeApiKey('bearer sk-or-v1-abc123'), 'sk-or-v1-abc123');
    assert.equal(normalizeApiKey('BEARER sk-or-v1-abc123'), 'sk-or-v1-abc123');
  });

  it('should strip "Bearer " prefix with extra whitespace', () => {
    assert.equal(normalizeApiKey('  Bearer  sk-or-v1-abc123  '), 'sk-or-v1-abc123');
  });

  it('should not modify keys that do not start with Bearer', () => {
    assert.equal(normalizeApiKey('sk-or-v1-xyz789'), 'sk-or-v1-xyz789');
  });
});

describe('isLikelyOpenRouterKey', () => {
  it('should accept valid OpenRouter key format', () => {
    assert.equal(isLikelyOpenRouterKey('sk-or-v1-abc123def456'), true);
  });

  it('should accept keys with dashes and underscores', () => {
    assert.equal(isLikelyOpenRouterKey('sk-or-v1-a1b2_c3-d4'), true);
  });

  it('should reject empty string', () => {
    assert.equal(isLikelyOpenRouterKey(''), false);
  });

  it('should reject keys without proper prefix', () => {
    assert.equal(isLikelyOpenRouterKey('sk-abc123'), false);
    assert.equal(isLikelyOpenRouterKey('openai-key-123'), false);
  });

  it('should reject keys with spaces', () => {
    assert.equal(isLikelyOpenRouterKey('sk-or-v1-abc 123'), false);
  });

  it('should reject keys with special characters', () => {
    assert.equal(isLikelyOpenRouterKey('sk-or-v1-abc!@#'), false);
  });
});
