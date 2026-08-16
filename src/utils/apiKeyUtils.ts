/**
 * Shared API key utility functions.
 * Centralizes key normalization and validation to avoid duplication
 * across openRouterProvider, openRouterClient, and secretsManager.
 */

/**
 * Strip leading "Bearer " prefix and whitespace from an API key string.
 * Handles cases where users accidentally paste the full Authorization header value.
 */
export function normalizeApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

/**
 * Check if a string looks like a valid OpenRouter API key.
 * Expected format: sk-or-v1-<alphanumeric/dash/underscore>
 */
export function isLikelyOpenRouterKey(value: string): boolean {
  return /^sk-or-v1-[A-Za-z0-9_-]+$/.test(value);
}
