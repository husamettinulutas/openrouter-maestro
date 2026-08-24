import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  parseModelReasoning,
  resolveReasoningEffort,
  buildThinkingEffortSchema,
} from '../utils/reasoningEffort';

describe('parseModelReasoning', () => {
  it('uses catalog supported_efforts and drops none when mandatory', () => {
    const parsed = parseModelReasoning({
      id: 'z-ai/glm-5.3',
      supported_parameters: ['reasoning', 'reasoning_effort', 'tools'],
      reasoning: {
        mandatory: true,
        default_enabled: true,
        supported_efforts: ['max', 'high', 'low', 'none'],
        default_effort: 'max',
      },
    });
    assert.ok(parsed);
    assert.equal(parsed!.mandatory, true);
    assert.deepEqual(parsed!.supportedEfforts, ['max', 'high', 'low']);
    assert.equal(parsed!.defaultEffort, 'max');
  });

  it('falls back when only supported_parameters lists reasoning', () => {
    const parsed = parseModelReasoning({
      id: 'openrouter/auto',
      supported_parameters: ['reasoning_effort', 'tools'],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed!.supportedEfforts, ['high', 'medium', 'low', 'none']);
  });

  it('treats a null supported_efforts list as the full gateway range', () => {
    const parsed = parseModelReasoning({
      id: 'some/gateway-model',
      reasoning: { supported_efforts: null },
    });
    assert.ok(parsed);
    assert.deepEqual(parsed!.supportedEfforts, [
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('returns undefined for non-reasoning models', () => {
    const parsed = parseModelReasoning({
      id: 'openai/gpt-4o',
      supported_parameters: ['temperature', 'tools'],
    });
    assert.equal(parsed, undefined);
  });

  it('never infers effort support from the model id alone', () => {
    // Upstream's fork guessed from "thinking"/"reasoner" substrings, which can
    // send a reasoning payload to a model that never declared the parameter.
    assert.equal(
      parseModelReasoning({ id: 'vendor/some-thinking-model', supported_parameters: ['tools'] }),
      undefined,
    );
    assert.equal(
      parseModelReasoning({ id: 'vendor/deepseek-reasoner-clone', supported_parameters: [] }),
      undefined,
    );
  });
});

describe('resolveReasoningEffort', () => {
  const reasoning = parseModelReasoning({
    id: 'google/gemini-3.5-flash',
    reasoning: {
      supported_efforts: ['high', 'medium', 'low', 'minimal'],
      default_effort: 'medium',
      default_enabled: true,
    },
  })!;

  it('prefers Copilot model picker value', () => {
    assert.equal(
      resolveReasoningEffort(reasoning, { modelConfiguration: { reasoningEffort: 'high' } }, 'low'),
      'high',
    );
  });

  it('falls back to per-model override then catalog default', () => {
    assert.equal(resolveReasoningEffort(reasoning, {}, 'low'), 'low');
    assert.equal(resolveReasoningEffort(reasoning, {}), 'medium');
  });

  it('ignores unsupported picker values', () => {
    assert.equal(
      resolveReasoningEffort(reasoning, { modelConfiguration: { reasoningEffort: 'max' } }),
      'medium',
    );
  });

  it('returns undefined for models without effort control', () => {
    assert.equal(resolveReasoningEffort(undefined, { modelConfiguration: { reasoningEffort: 'high' } }), undefined);
  });
});

describe('buildThinkingEffortSchema', () => {
  it('marks the property as a model-picker navigation action', () => {
    const reasoning = parseModelReasoning({
      id: 'anthropic/claude-sonnet-4.6',
      reasoning: { supported_efforts: ['high', 'medium', 'low'], default_effort: 'high' },
    })!;
    const schema = buildThinkingEffortSchema(reasoning);
    assert.equal(schema.properties.reasoningEffort.group, 'navigation');
    assert.equal(schema.properties.reasoningEffort.title, 'Thinking Effort');
    assert.equal(schema.properties.reasoningEffort.default, 'high');
    assert.deepEqual(schema.properties.reasoningEffort.enumItemLabels, ['High', 'Medium', 'Low']);
  });
});
