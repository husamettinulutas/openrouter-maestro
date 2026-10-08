import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isOursOrEmpty, modelIdFromUtilitySetting, utilitySettingValue } from '../utils/utilityModel';

describe('utility model settings', () => {
  it('writes vendor/id, which VS Code splits at the first slash', () => {
    const value = utilitySettingValue('google/gemini-3.1-flash-lite');
    assert.equal(value, 'openrouter-maestro/google/gemini-3.1-flash-lite');
    const slash = value.indexOf('/');
    assert.equal(value.slice(0, slash), 'openrouter-maestro');
    assert.equal(value.slice(slash + 1), 'google/gemini-3.1-flash-lite');
  });

  it('reads back only values this extension wrote', () => {
    assert.equal(modelIdFromUtilitySetting('openrouter-maestro/openai/gpt-5.4-nano'), 'openai/gpt-5.4-nano');
    assert.equal(modelIdFromUtilitySetting('anthropic/claude-haiku-4.5'), undefined);
    assert.equal(modelIdFromUtilitySetting('openrouter-maestro/'), undefined);
    assert.equal(modelIdFromUtilitySetting(undefined), undefined);
  });

  it('overwrites empty or own values without asking, never another vendor', () => {
    assert.equal(isOursOrEmpty(undefined), true);
    assert.equal(isOursOrEmpty(''), true);
    assert.equal(isOursOrEmpty('openrouter-maestro/openai/gpt-5.4-nano'), true);
    assert.equal(isOursOrEmpty('anthropic/claude-haiku-4.5'), false);
  });
});
