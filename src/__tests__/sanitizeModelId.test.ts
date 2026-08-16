import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { sanitizeModelId } from '../integrations/shared';

describe('sanitizeModelId', () => {
  it('passes plain provider/model ids through verbatim', () => {
    assert.equal(sanitizeModelId('deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
    assert.equal(sanitizeModelId('deepseek/deepseek-v4-flash-0731'), 'deepseek/deepseek-v4-flash-0731');
    assert.equal(sanitizeModelId('anthropic/claude-sonnet-4.5'), 'anthropic/claude-sonnet-4.5');
  });

  it('keeps :variant suffixes', () => {
    assert.equal(sanitizeModelId('deepseek/deepseek-chat:free'), 'deepseek/deepseek-chat:free');
    assert.equal(sanitizeModelId('meta-llama/llama-3.1-70b:nitro'), 'meta-llama/llama-3.1-70b:nitro');
  });

  // Regression: OpenRouter rolling aliases exist ONLY in tilde form
  // ("~deepseek/deepseek-v4-flash-latest"); stripping the tilde produces a
  // slug the API rejects with 400 "not a valid model ID".
  it('keeps the leading tilde of rolling-alias ids', () => {
    assert.equal(
      sanitizeModelId('~deepseek/deepseek-v4-flash-latest'),
      '~deepseek/deepseek-v4-flash-latest'
    );
    assert.equal(sanitizeModelId('~openai/gpt-latest'), '~openai/gpt-latest');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(sanitizeModelId('  deepseek/deepseek-chat  '), 'deepseek/deepseek-chat');
    assert.equal(sanitizeModelId(' ~x-ai/grok-latest '), '~x-ai/grok-latest');
  });

  it('rejects ids without a provider segment', () => {
    assert.throws(() => sanitizeModelId('deepseek-chat'));
    assert.throws(() => sanitizeModelId(''));
  });

  it('rejects malformed ids', () => {
    assert.throws(() => sanitizeModelId('~~deepseek/deepseek-chat'));
    assert.throws(() => sanitizeModelId('deepseek//chat'));
    assert.throws(() => sanitizeModelId('deepseek/chat extra'));
    assert.throws(() => sanitizeModelId('/model'));
  });
});
