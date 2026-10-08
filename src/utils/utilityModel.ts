/**
 * Copilot's utility models: the small model behind chat titles, commit
 * messages, rename suggestions, intent detection and the repair of failed
 * edits. By default Copilot uses its own, which needs a Copilot subscription.
 *
 * VS Code reads `chat.utilityModel` and `chat.utilitySmallModel` as
 * "vendor/id", split at the first slash, and resolves them with
 * `lm.selectChatModels({ vendor, id })`. OpenRouter ids contain slashes
 * themselves, which is fine: "openrouter-maestro/google/gemini-…".
 */

export const PROVIDER_VENDOR_ID = 'openrouter-maestro';

/** Settings under `chat.` that name a utility model. */
export const UTILITY_SETTINGS = ['utilityModel', 'utilitySmallModel'] as const;

/** Fast, cheap models that handle titles and commit messages well, best first. */
export const RECOMMENDED_UTILITY_MODELS = [
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5.4-nano',
  'deepseek/deepseek-v4-flash',
  'anthropic/claude-haiku-4.5',
];

export function utilitySettingValue(modelId: string): string {
  return `${PROVIDER_VENDOR_ID}/${modelId}`;
}

/** The OpenRouter model id in a setting value written by this extension, if it is one. */
export function modelIdFromUtilitySetting(value: unknown): string | undefined {
  const prefix = `${PROVIDER_VENDOR_ID}/`;
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
    ? value.slice(prefix.length)
    : undefined;
}

/** Empty, or pointing at one of our models: safe to overwrite without asking. */
export function isOursOrEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || modelIdFromUtilitySetting(value) !== undefined;
}
