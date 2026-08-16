import * as vscode from 'vscode';

/** Publisher-qualified extension id — must match package.json publisher + name. */
const EXTENSION_ID = 'husamettinulutas.openrouter-maestro';

/** Used only if the extension host cannot report its own version. */
const FALLBACK_VERSION = '1.0.0';

/**
 * How this extension identifies itself to OpenRouter.
 *
 * OpenRouter groups usage into "apps" keyed by the referer, and labels each one
 * with the title — that is what shows up under Activity → Apps, with the URL as
 * the app's Origin link. Both values must stay in sync with package.json's
 * repository URL: a mismatch silently registers a second, separate app.
 *
 * All three agents report under this one app: the extension sends the headers
 * on its own Copilot requests, and the Claude Code / Codex integrations inject
 * the same pair into the config they manage (`ANTHROPIC_CUSTOM_HEADERS` and
 * `[model_providers.openrouter.http_headers]`), so everything Maestro wires up
 * lands in a single entry instead of three unlabelled ones.
 */
export const OPENROUTER_APP_TITLE = 'OpenRouter Maestro';
export const OPENROUTER_APP_URL = 'https://github.com/husamettinulutas/openrouter-maestro';

/** The running extension's version, read from the manifest rather than hardcoded. */
export function getExtensionVersion(): string {
  try {
    const version = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version;
    return typeof version === 'string' && version ? version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export function getUserAgent(): string {
  return `VSCode-OpenRouter-Maestro/${getExtensionVersion()}`;
}

/**
 * Attribution headers for every OpenRouter request this extension makes.
 * `X-Title` was deprecated in favour of `X-OpenRouter-Title` in 2026.
 */
export function getAttributionHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
    'User-Agent': getUserAgent(),
  };
}
