import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { describeServedModel, isVariablePrice, shortModelName } from '../utils/servedModel';

describe('describeServedModel', () => {
  it('reports the model a router picked and shows it inline', () => {
    const r = describeServedModel('openrouter/auto', 'anthropic/claude-4-sonnet-20250522', 'Anthropic', true);
    assert.deepEqual(r, { served: 'anthropic/claude-4-sonnet-20250522', provider: 'Anthropic', showInline: true });
  });

  it('keeps a dated alias of the same vendor out of the inline text', () => {
    const r = describeServedModel('anthropic/claude-sonnet-4', 'anthropic/claude-4-sonnet-20250522', 'Google', false);
    assert.equal(r.served, 'anthropic/claude-4-sonnet-20250522');
    assert.equal(r.showInline, false);
  });

  it('shows a fallback to another vendor inline', () => {
    const r = describeServedModel('openai/gpt-5', 'google/gemini-3-pro', 'Google', false);
    assert.equal(r.showInline, true);
  });

  it('reports only the provider when the served model matches the request', () => {
    const r = describeServedModel('z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash', ' Z.AI ', false);
    assert.deepEqual(r, { provider: 'Z.AI', showInline: false });
  });

  it('handles a stream without model or provider', () => {
    assert.deepEqual(describeServedModel('openrouter/auto', undefined, '', true), { provider: undefined, showInline: false });
  });
});

describe('isVariablePrice', () => {
  it('treats OpenRouter\'s "-1" router price as variable', () => {
    assert.equal(isVariablePrice(-1), true);
    assert.equal(isVariablePrice(0), false);
    assert.equal(isVariablePrice(0.000003), false);
  });
});

describe('shortModelName', () => {
  it('drops the vendor prefix', () => {
    assert.equal(shortModelName('anthropic/claude-4-sonnet'), 'claude-4-sonnet');
    assert.equal(shortModelName('local-model'), 'local-model');
  });
});
