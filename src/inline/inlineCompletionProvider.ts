import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { getAttributionHeaders } from '../utils/branding';
import { ModelCache } from '../cache/modelCache';
import { buildCompletionMessages, cleanCompletion, DEFAULT_INLINE_MODEL } from './completionPrompt';

/**
 * Inline (ghost text) code completions from an OpenRouter model.
 *
 * Copilot's inline suggestions and next edit suggestions need a Copilot
 * subscription; BYOK only covers chat. Off by default: every pause while
 * typing is a paid request, and with an active Copilot plan both providers
 * would offer suggestions.
 */

const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 1500;
const TIMEOUT_MS = 8000;
const CACHE_SIZE = 30;

function settings() {
  const c = vscode.workspace.getConfiguration('openrouterMaestro');
  return {
    enabled: c.get<boolean>('inlineCompletions.enabled', false),
    model: c.get<string>('inlineCompletions.model', DEFAULT_INLINE_MODEL) || DEFAULT_INLINE_MODEL,
    debounceMs: c.get<number>('inlineCompletions.debounceMs', 350),
    endpoint: c.get<string>('apiEndpoint', 'https://openrouter.ai/api/v1'),
  };
}

export class OpenRouterInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    private readonly models: ModelCache,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const { enabled, model, debounceMs, endpoint } = settings();
    if (!enabled || document.uri.scheme === 'output' || document.uri.scheme === 'vscode-scm') {
      return undefined;
    }

    const offset = document.offsetAt(position);
    const text = document.getText();
    const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = text.slice(offset, offset + SUFFIX_CHARS);
    if (!prefix.trim()) {
      return undefined;
    }
    // Mid-word: wait until the word is finished.
    const nextChar = text.charAt(offset);
    if (/\w/.test(nextChar)) {
      return undefined;
    }

    const cacheKey = `${model}\u0001${prefix.slice(-500)}\u0001${suffix.slice(0, 200)}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached ? [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))] : undefined;
    }

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      await new Promise(resolve => setTimeout(resolve, debounceMs));
      if (token.isCancellationRequested) {
        return undefined;
      }
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onCancel = token.onCancellationRequested(() => controller.abort());
    const started = Date.now();
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...getAttributionHeaders(),
        },
        body: JSON.stringify({
          model,
          messages: buildCompletionMessages({
            path: vscode.workspace.asRelativePath(document.uri),
            languageId: document.languageId,
            prefix,
            suffix,
          }),
          max_tokens: 200,
          temperature: 0,
          stream: false,
          provider: { sort: 'latency' },
          ...this.reasoningOff(model),
        }),
      });
      const body = await response.text();
      if (!response.ok) {
        Logger.warn(`Inline completion (${model}) failed: HTTP ${response.status} ${body.slice(0, 300)}`);
        return undefined;
      }
      const json = JSON.parse(body);
      const completion = cleanCompletion(String(json?.choices?.[0]?.message?.content ?? ''), prefix, suffix);
      Logger.debug(`Inline completion (${model}) in ${Date.now() - started} ms, ${completion.length} chars, $${json?.usage?.cost ?? '?'}`);
      this.remember(cacheKey, completion);
      if (!completion || token.isCancellationRequested) {
        return undefined;
      }
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (error) {
      if (!controller.signal.aborted) {
        Logger.warn(`Inline completion (${model}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      onCancel.dispose();
    }
  }

  /** Thinking only slows completions down; turn it off where the model allows. */
  private reasoningOff(model: string): Record<string, unknown> {
    const reasoning = this.models.getModel(model)?.reasoning;
    if (!reasoning || reasoning.mandatory) {
      return {};
    }
    for (const effort of ['none', 'minimal', 'low']) {
      if (reasoning.supportedEfforts.includes(effort)) {
        return { reasoning: { effort } };
      }
    }
    return { reasoning: { enabled: false } };
  }

  private remember(key: string, value: string): void {
    this.cache.set(key, value);
    if (this.cache.size > CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }
}
