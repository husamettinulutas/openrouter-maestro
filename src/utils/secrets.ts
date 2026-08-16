import * as vscode from 'vscode';
import { normalizeApiKey, isLikelyOpenRouterKey } from './apiKeyUtils';

const SECRET_KEY = 'openrouter-api-key';
const CHAT_SECRET_KEY = 'chat.lm.secret.openrouter-api-key';

/**
 * Manages the OpenRouter API key using VS Code's SecretStorage.
 * Keys are stored securely and registered under both extension storage
 * and Copilot Chat's secret key space.
 */
export class SecretsManager {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  /**
   * Get the stored API key.
   */
  async getApiKey(): Promise<string | undefined> {
    const key = await this.secretStorage.get(SECRET_KEY);
    if (key) {
      const normalized = normalizeApiKey(key);
      if (normalized) {
        return normalized;
      }
    }

    // Backward compatibility with previously stored chat namespace keys.
    const legacy = await this.secretStorage.get(CHAT_SECRET_KEY);
    if (!legacy) {
      return undefined;
    }

    const normalizedLegacy = normalizeApiKey(legacy);
    if (!normalizedLegacy || !isLikelyOpenRouterKey(normalizedLegacy)) {
      return undefined;
    }

    await this.secretStorage.store(SECRET_KEY, normalizedLegacy);
    return normalizedLegacy;
  }

  /**
   * Check if an API key is stored.
   */
  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key && key.length > 0;
  }

  /**
   * Store a new API key under both extension and Copilot secret namespaces.
   */
  async setApiKey(key: string): Promise<void> {
    const normalized = normalizeApiKey(key);
    await this.secretStorage.store(SECRET_KEY, normalized);
  }

  /**
   * Delete the stored API key.
   */
  async deleteApiKey(): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY);
    // Cleanup old key namespace if it exists from previous versions.
    await this.secretStorage.delete(CHAT_SECRET_KEY);
  }

  /**
   * Prompt the user to enter their API key via an input box.
   * Returns true if a key was successfully set.
   */
  async promptForApiKey(): Promise<boolean> {
    const existingKey = await this.getApiKey();
    const key = await vscode.window.showInputBox({
      title: 'OpenRouter API Key',
      prompt: 'Enter your OpenRouter API key (from openrouter.ai/settings/keys)',
      password: true,
      placeHolder: 'sk-or-v1-...',
      value: existingKey ? '••••••••' : undefined,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'API key cannot be empty';
        }

        if (value !== '••••••••') {
          const normalized = normalizeApiKey(value);
          if (!isLikelyOpenRouterKey(normalized)) {
            return 'Invalid OpenRouter key format (expected: sk-or-v1-...)';
          }
        }

        return undefined;
      },
    });

    if (key && key !== '••••••••') {
      await this.setApiKey(key);
      vscode.window.showInformationMessage('✅ OpenRouter API key saved successfully!');
      return true;
    }

    return false;
  }
}
