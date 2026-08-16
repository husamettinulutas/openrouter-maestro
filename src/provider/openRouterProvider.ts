import * as vscode from 'vscode';
import * as https from 'https';
import { ModelCache } from '../cache/modelCache';
import { SecretsManager } from '../utils/secrets';
import { Logger } from '../utils/logger';
import { SelectedModel } from '../types/models';
import { normalizeApiKey } from '../utils/apiKeyUtils';
import { getAttributionHeaders } from '../utils/branding';

// ─── Configuration helper ────────────────────────────────────────────────────

/** Read a configuration value under the `openrouterMaestro` namespace. */
function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('openrouterMaestro').get<T>(key, defaultValue);
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Node.js network error codes that are safe to retry. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH',
]);

// ─── Error class ─────────────────────────────────────────────────────────────

/**
 * Custom error that carries HTTP metadata for retry decisions.
 */
class OpenRouterRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
    public readonly errorCode?: string,
    /** True when the request was blocked by OpenRouter's prompt-injection guardrails. */
    public readonly isGuardrailBlock?: boolean,
  ) {
    super(message);
    this.name = 'OpenRouterRequestError';
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Native VS Code LanguageModelChatProvider for OpenRouter.
 * Contributes OpenRouter models directly to VS Code Copilot Chat picker without manual setup.
 * Supports agentic mode with full tool calling (terminal, file access, web search, etc.),
 * vision/image input, and thinking/reasoning content display.
 */
export class OpenRouterChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  /** Status bar item for displaying token usage statistics. */
  private _usageStatusBar?: vscode.StatusBarItem;

  /** Whether the proposed `LanguageModelThinkingPart` API is available at runtime. */
  private readonly _thinkingPartAvailable =
    typeof (vscode as any).LanguageModelThinkingPart === 'function';

  constructor(
    private readonly cache: ModelCache,
    private readonly secrets: SecretsManager,
    private readonly globalState: vscode.Memento,
  ) {}

  /** Notify VS Code that available language models have changed. */
  refresh(): void {
    this._onDidChange.fire();
  }

  /** Attach a status bar item for displaying per-request usage stats. */
  setUsageStatusBar(item: vscode.StatusBarItem): void {
    this._usageStatusBar = item;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Model enumeration
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Return available OpenRouter models to VS Code Copilot Chat model picker.
   */
  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const selected = this.globalState.get<SelectedModel[]>('openrouter-selected-models') || [];
    const allModels = this.cache.getModels();

    // Filter to only models that have been explicitly selected and enabled by the user
    const activeModels = allModels.filter((m) =>
      selected.some((s) => s.id === m.id && s.enabled),
    );

    return activeModels.map((m) => ({
      id: m.id,
      name: m.name,
      family: 'OpenRouter Maestro',
      version: '1.0.0',
      maxInputTokens: this.calculateMaxInputTokens(m.contextLength, m.maxOutputTokens),
      maxOutputTokens: m.maxOutputTokens || 4096,
      capabilities: {
        imageInput: m.capabilities.vision,
        toolCalling: m.capabilities.toolCalling,
      },
    }));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Chat response (main entry point)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Handle streaming chat request from VS Code Copilot to OpenRouter API.
   * Supports agentic mode: tool definitions are forwarded, tool_calls are parsed
   * from the stream, and tool results are properly formatted.
   * Also supports thinking/reasoning content display and system messages.
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const rawKey = await this.secrets.getApiKey();
    const apiKey = rawKey ? normalizeApiKey(rawKey) : undefined;
    if (!apiKey) {
      progress.report(
        new vscode.LanguageModelTextPart(
          '❌ OpenRouter API key not set. Please click the 🔑 icon in the OpenRouter panel to set your API key.',
        ),
      );
      return;
    }

    // Format messages (with system role support)
    let formattedMessages = this.formatMessages(messages);

    // Proactively strip long base64 blobs so organization guardrails don't
    // block the request as base64_encoded_injection (and to save tokens).
    if (getConfig<boolean>('sanitizeBase64Content', true)) {
      const { messages: sanitized, removedChars } = this.sanitizeMessagesBase64(formattedMessages);
      if (removedChars > 0) {
        Logger.info(`Sanitized ${removedChars} chars of base64-like content from outgoing prompt`);
        formattedMessages = sanitized;
      }
    }

    // Build tool definitions
    const { tools, toolChoice } = this.buildToolDefinitions(_options);

    // Build request body (with model parameters from settings)
    const requestBody = this.buildRequestBody(model.id, formattedMessages, tools, toolChoice);

    // Warn about very large request bodies that may cause invalid_json errors
    const bodySize = JSON.stringify(requestBody).length;
    if (bodySize > 1_000_000) {
      Logger.warn(`Request body is very large: ${(bodySize / 1_000_000).toFixed(1)}MB — consider starting a new chat`);
    }

    // Read retry & timeout settings
    const maxRetries = getConfig<number>('maxRetries', 3);
    const timeoutSeconds = getConfig<number>('requestTimeoutSeconds', 60);

    Logger.info(
      `Sending request to OpenRouter: model=${model.id}, messages=${formattedMessages.length}, tools=${tools?.length || 0}, bodySize=${(bodySize / 1024).toFixed(0)}KB`,
    );

    try {
      await this.makeRequestWithRetry(requestBody, apiKey, progress, token, maxRetries, timeoutSeconds);
    } catch (err: any) {
      // Cancellation is not an error
      if (token.isCancellationRequested) { return; }

      // Guardrail 403 (prompt injection detection): retry once with base64
      // blobs stripped — but only if stripping actually changes the payload
      // (it won't if the proactive sanitizer already ran), so this can't loop.
      if (err instanceof OpenRouterRequestError && err.isGuardrailBlock) {
        const { messages: cleaned, removedChars } = this.sanitizeMessagesBase64(formattedMessages);
        if (removedChars > 0) {
          Logger.warn(
            `Guardrail blocked request; retrying once with ${removedChars} chars of base64 content removed`,
          );
          progress.report(
            new vscode.LanguageModelTextPart(
              '\n🛡️ Request blocked by OpenRouter guardrails — retrying once with base64 content removed...\n',
            ),
          );
          const retryBody = this.buildRequestBody(model.id, cleaned, tools, toolChoice);
          try {
            await this.makeRequestWithRetry(retryBody, apiKey, progress, token, 0, timeoutSeconds);
            return;
          } catch (retryErr: any) {
            if (token.isCancellationRequested) { return; }
            err = retryErr;
          }
        }
      }

      // OpenRouterRequestError messages were already reported to progress in makeStreamingRequest.
      // For unexpected errors, report them now.
      if (!(err instanceof OpenRouterRequestError)) {
        const msg = `❌ Unexpected error: ${err.message || err}`;
        progress.report(new vscode.LanguageModelTextPart(msg));
        Logger.error(msg, err);
      }

      // Re-throw so VS Code knows the request failed and can take appropriate action
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Content part type guards
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Safely check if a content part is an image/data part.
   * Uses duck-typing because vscode.LanguageModelDataPart may not exist
   * in older VS Code versions (pre-1.100) and instanceof would throw TypeError.
   * IMPORTANT: VS Code also sends cache_control parts with data+mimeType props,
   * so we must verify mimeType starts with 'image/' to avoid false matches.
   */
  private isImageDataPart(part: any): part is { data: Uint8Array; mimeType: string } {
    if (part && typeof part === 'object' && 'data' in part && 'mimeType' in part) {
      const mime = typeof part.mimeType === 'string' ? part.mimeType : '';
      return mime.startsWith('image/');
    }
    return false;
  }

  /** Check if a content part is a LanguageModelToolCallPart. */
  private isToolCallPart(part: any): part is vscode.LanguageModelToolCallPart {
    return part && typeof part === 'object' && 'callId' in part && 'name' in part && 'input' in part;
  }

  /** Check if a content part is a LanguageModelToolResultPart. */
  private isToolResultPart(part: any): part is vscode.LanguageModelToolResultPart {
    return part && typeof part === 'object' && 'callId' in part && 'content' in part && !('name' in part);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Base64 sanitization
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Long runs of base64-alphabet characters (incl. base64url) in prompt text.
   * OpenRouter organization guardrails flag these as "base64_encoded_injection"
   * and block the whole request with a 403; they also burn tokens for content
   * models rarely need verbatim. 200+ chars won't match normal prose or code —
   * identifiers and minified JS are broken up by punctuation outside this set.
   */
  private static readonly BASE64_RUN_REGEX = /[A-Za-z0-9+\/=_-]{200,}/g;

  /** Replace long base64-like runs in text with a short placeholder. */
  private sanitizeBase64Text(text: string): { text: string; removed: number } {
    let removed = 0;
    const sanitized = text.replace(OpenRouterChatProvider.BASE64_RUN_REGEX, (match) => {
      removed += match.length;
      return `[base64 content removed: ${match.length} chars]`;
    });
    return { text: sanitized, removed };
  }

  /**
   * Strip long base64-like blobs from formatted message text.
   * image_url parts (vision attachments) are never touched — they must stay
   * base64 data URLs for the API. Returns new message objects; originals are
   * not mutated.
   */
  private sanitizeMessagesBase64(messages: any[]): { messages: any[]; removedChars: number } {
    let removedChars = 0;

    const result = messages.map((msg) => {
      if (typeof msg.content === 'string') {
        const { text, removed } = this.sanitizeBase64Text(msg.content);
        if (removed === 0) { return msg; }
        removedChars += removed;
        return { ...msg, content: text };
      }

      if (Array.isArray(msg.content)) {
        let changed = false;
        const parts = msg.content.map((part: any) => {
          if (part?.type === 'text' && typeof part.text === 'string') {
            const { text, removed } = this.sanitizeBase64Text(part.text);
            if (removed > 0) {
              changed = true;
              removedChars += removed;
              return { ...part, text };
            }
          }
          return part;
        });
        return changed ? { ...msg, content: parts } : msg;
      }

      return msg;
    });

    return { messages: result, removedChars };
  }

  /** True when a non-200 response is an OpenRouter guardrail block rather than an auth failure. */
  private isGuardrailBlockError(statusCode: number | undefined, body: string): boolean {
    if (statusCode !== 403) { return false; }
    let message = body;
    try {
      message = JSON.parse(body)?.error?.message || body;
    } catch {
      // keep raw body
    }
    const lower = message.toLowerCase();
    return lower.includes('prompt injection') || lower.includes('request blocked');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Message formatting
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Format VS Code messages for OpenRouter API.
   * Supports: system role, multimodal/vision, tool calls, tool results.
   */
  private formatMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): any[] {
    const formattedMessages: any[] = [];

    for (const msg of messages) {
      // ── Determine role (user / assistant / system) ──
      let role = 'user';

      if (
        msg.role === vscode.LanguageModelChatMessageRole.Assistant ||
        (msg.role as any) === 'assistant' ||
        (msg.role as any) === 2
      ) {
        role = 'assistant';
      }

      // System role support — VS Code may send system-level prompts
      // (e.g. @workspace instructions, .github/copilot-instructions.md).
      // Check enum value, string, and numeric representations.
      const systemEnum = (vscode.LanguageModelChatMessageRole as any).System;
      if (
        (systemEnum !== undefined && msg.role === systemEnum) ||
        (msg.role as any) === 'system' ||
        (msg.role as any) === 0
      ) {
        role = 'system';
      }

      // ── Inspect content parts ──
      let hasImageParts = false;
      let hasToolCallParts = false;
      let hasToolResultParts = false;

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (this.isImageDataPart(part)) { hasImageParts = true; }
          if (this.isToolCallPart(part)) { hasToolCallParts = true; }
          if (this.isToolResultPart(part)) { hasToolResultParts = true; }
        }
      }

      // ── Handle tool result messages ──
      // VS Code sends tool results as User messages with LanguageModelToolResultPart.
      // OpenRouter/OpenAI API expects these as separate { role: 'tool', ... } messages.
      if (hasToolResultParts && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (this.isToolResultPart(part)) {
            const resultContent = this.extractTextFromParts(part.content);
            formattedMessages.push({
              role: 'tool',
              tool_call_id: part.callId,
              content: resultContent || '(no output)',
            });
          }
        }
        continue;
      }

      // ── Handle assistant messages with tool calls ──
      // VS Code sends previous tool calls as Assistant messages with LanguageModelToolCallPart.
      // OpenRouter/OpenAI API expects { role: 'assistant', tool_calls: [...] }.
      if (hasToolCallParts && role === 'assistant' && Array.isArray(msg.content)) {
        let textContent = '';
        const toolCalls: any[] = [];

        for (const part of msg.content) {
          if (this.isToolCallPart(part)) {
            toolCalls.push({
              id: part.callId,
              type: 'function',
              function: {
                name: part.name,
                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
              },
            });
          } else {
            textContent += this.extractTextFromPart(part);
          }
        }

        formattedMessages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls,
        });
        continue;
      }

      // ── Handle multimodal (image) messages ──
      if (hasImageParts && Array.isArray(msg.content)) {
        const contentParts: Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } }
        > = [];

        for (const part of msg.content) {
          if (this.isImageDataPart(part)) {
            // Convert binary data to base64 data URL for OpenRouter API
            const base64Data = Buffer.from(part.data).toString('base64');
            const mimeType = part.mimeType || 'image/png';
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Data}` },
            });
          } else {
            const text = this.extractTextFromPart(part);
            if (text) { contentParts.push({ type: 'text', text }); }
          }
        }

        formattedMessages.push({ role, content: contentParts });
        continue;
      }

      // ── Handle plain text messages ──
      let textContent = '';
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          textContent += this.extractTextFromPart(part);
        }
      } else if (typeof msg.content === 'string') {
        textContent = msg.content;
      }

      formattedMessages.push({ role, content: textContent });
    }

    return formattedMessages;
  }

  /** Extract text string from a single content part (duck-typed). */
  private extractTextFromPart(part: any): string {
    if (part instanceof vscode.LanguageModelTextPart) { return part.value; }
    if (typeof part === 'string') { return part; }
    if (part && typeof part === 'object' && 'value' in part) { return (part as any).value || ''; }
    return '';
  }

  /** Extract text from an array of content parts or a plain string. */
  private extractTextFromParts(content: any): string {
    if (typeof content === 'string') { return content; }
    if (Array.isArray(content)) {
      return content.map((p) => this.extractTextFromPart(p)).join('');
    }
    return '';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Tool definitions
  // ────────────────────────────────────────────────────────────────────────────

  /** Convert VS Code tool definitions to OpenRouter/OpenAI format. */
  private buildToolDefinitions(options: vscode.ProvideLanguageModelChatResponseOptions): {
    tools: any[] | undefined;
    toolChoice: string | undefined;
  } {
    let tools: any[] | undefined;
    if (options.tools && options.tools.length > 0) {
      tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      }));
    }

    let toolChoice: string | undefined;
    if (tools && tools.length > 0) {
      toolChoice =
        options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
    }

    return { tools, toolChoice };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Request body
  // ────────────────────────────────────────────────────────────────────────────

  /** Build the OpenRouter chat completion request body, including model parameters. */
  private buildRequestBody(
    modelId: string,
    messages: any[],
    tools: any[] | undefined,
    toolChoice: string | undefined,
  ): any {
    const body: any = {
      model: modelId,
      messages,
      stream: true,
      // Request usage statistics in the streaming response
      stream_options: { include_usage: true },
    };

    // Enable OpenRouter automatic prompt caching. Anthropic models only cache
    // when cache_control is present (otherwise every agent-mode turn re-bills
    // the full conversation at full input price); OpenAI/Gemini cache
    // automatically and ignore this field. OpenRouter advances the breakpoint
    // as the conversation grows, which fits Copilot agent mode.
    if (getConfig<boolean>('enablePromptCaching', true)) {
      body.cache_control = { type: 'ephemeral' };
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    // Model parameters from VS Code settings
    const temperature = getConfig<number | null>('defaultTemperature', null);
    const maxTokens = getConfig<number | null>('defaultMaxTokens', null);

    if (temperature !== null && temperature !== undefined) {
      body.temperature = temperature;
    }
    if (maxTokens !== null && maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    return body;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Retry logic
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Execute streaming request with automatic retry and exponential backoff.
   * Retries on: 429 (rate limit), 502/503/504 (server errors),
   * and transient network errors (ECONNRESET, ETIMEDOUT, etc.).
   */
  private async makeRequestWithRetry(
    requestBody: any,
    apiKey: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    maxRetries: number,
    timeoutSeconds: number,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (token.isCancellationRequested) { return; }

      try {
        return await this.makeStreamingRequest(requestBody, apiKey, progress, token, timeoutSeconds);
      } catch (err: any) {
        lastError = err;

        // Check if this error type is retryable
        const isRetryable =
          (err instanceof OpenRouterRequestError &&
            err.statusCode !== undefined &&
            RETRYABLE_STATUS_CODES.has(err.statusCode)) ||
          (err.errorCode && RETRYABLE_ERROR_CODES.has(err.errorCode)) ||
          (err.code && RETRYABLE_ERROR_CODES.has(err.code));

        if (!isRetryable || attempt >= maxRetries || token.isCancellationRequested) {
          throw lastError;
        }

        const delay = this.getRetryDelay(err, attempt);
        Logger.warn(
          `Request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${err.message}`,
        );
        progress.report(
          new vscode.LanguageModelTextPart(`\n⏳ Retrying (${attempt + 1}/${maxRetries})...\n`),
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError!;
  }

  /** Calculate retry delay, respecting Retry-After header for 429 responses. */
  private getRetryDelay(err: any, attempt: number): number {
    if (err instanceof OpenRouterRequestError && err.retryAfter) {
      return Math.min(err.retryAfter * 1000, 30_000);
    }
    // Exponential backoff: 1s, 2s, 4s
    return Math.pow(2, attempt) * 1000;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Streaming HTTP request
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a single streaming HTTP request to OpenRouter.
   * Handles: SSE parsing, thinking/reasoning content, tool call deltas, usage stats.
   * Rejects on HTTP errors and network failures for proper retry/error handling.
   */
  private makeStreamingRequest(
    requestBody: any,
    apiKey: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    timeoutSeconds: number,
  ): Promise<void> {
    const bodyData = JSON.stringify(requestBody);
    const apiEndpoint = getConfig<string>('apiEndpoint', 'https://openrouter.ai/api/v1');

    let url: URL;
    try {
      url = new URL(`${apiEndpoint}/chat/completions`);
    } catch {
      url = new URL('https://openrouter.ai/api/v1/chat/completions');
    }

    return new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : undefined,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...getAttributionHeaders(),
          },
        },
        (res) => {
          // ── Non-200 error handling ──
          if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', (chunk) => (errBody += chunk));
            res.on('end', () => {
              Logger.error(`OpenRouter API error ${res.statusCode}: ${errBody}`);

              let fullError = errBody;
              try {
                const parsed = JSON.parse(errBody);
                fullError = JSON.stringify(parsed, null, 2);
              } catch { /* keep raw */ }
              Logger.error(`Full error body: ${fullError}`);

              const friendly = this.buildFriendlyError(res.statusCode, errBody);
              progress.report(new vscode.LanguageModelTextPart(friendly + '\n\nDetails: ' + fullError));

              // Parse Retry-After header for 429 responses
              let retryAfter: number | undefined;
              if (res.statusCode === 429) {
                const header = res.headers['retry-after'];
                if (header) { retryAfter = parseInt(header as string, 10) || 5; }
              }

              reject(
                new OpenRouterRequestError(
                  friendly,
                  res.statusCode,
                  retryAfter,
                  undefined,
                  this.isGuardrailBlockError(res.statusCode, errBody),
                ),
              );
            });
            return;
          }

          // ── Streaming success path ──
          let buffer = '';
          const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
          let usageData: any = null;

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) { continue; }

              const dataStr = trimmed.slice(6).trim();
              if (dataStr === '[DONE]') {
                // Emit any remaining tool calls (some models send finish_reason before [DONE])
                this.emitPendingToolCalls(pendingToolCalls, progress);
                continue;
              }

              try {
                const json = JSON.parse(dataStr);
                const delta = json.choices?.[0]?.delta;
                const finishReason = json.choices?.[0]?.finish_reason;

                // Capture usage stats (some providers send usage in stream chunks)
                if (json.usage) { usageData = json.usage; }

                // ── Thinking / Reasoning content ──
                // Models like Claude 3.5/4, DeepSeek-R1, Qwen3 return reasoning
                // via delta.reasoning or delta.reasoning_content fields.
                const reasoning = delta?.reasoning || delta?.reasoning_content;
                if (reasoning) {
                  this.reportReasoning(reasoning, progress);
                }

                // ── Text content ──
                if (delta?.content) {
                  progress.report(new vscode.LanguageModelTextPart(delta.content));
                }

                // ── Tool call deltas (streamed incrementally) ──
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!pendingToolCalls.has(idx)) {
                      pendingToolCalls.set(idx, { id: '', name: '', arguments: '' });
                    }
                    const pending = pendingToolCalls.get(idx)!;
                    if (tc.id) { pending.id = tc.id; }
                    if (tc.function?.name) { pending.name += tc.function.name; }
                    if (tc.function?.arguments) { pending.arguments += tc.function.arguments; }
                  }
                }

                // When finish_reason indicates tool calls are complete, emit them
                if (finishReason === 'tool_calls') {
                  this.emitPendingToolCalls(pendingToolCalls, progress);
                }
              } catch (_e) {
                // Ignore JSON parse errors for partial SSE chunks
              }
            }
          });

          res.on('end', () => {
            // Emit any remaining tool calls that weren't emitted
            this.emitPendingToolCalls(pendingToolCalls, progress);

            // Update usage stats in status bar
            if (usageData) { this.updateUsageStats(usageData, requestBody.model); }

            resolve();
          });

          res.on('error', (err) => {
            reject(new OpenRouterRequestError(
              `Stream error: ${err.message}`,
              undefined,
              undefined,
              (err as any).code,
            ));
          });
        },
      );

      // ── Request timeout ──
      const timeoutMs = timeoutSeconds * 1000;
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new OpenRouterRequestError(
          `⏱️ Request timed out after ${timeoutSeconds}s. The model may be overloaded — try again or choose a different model.`,
          undefined,
          undefined,
          'ETIMEDOUT',
        ));
      });

      // ── Cancellation ──
      token.onCancellationRequested(() => {
        req.destroy();
        resolve(); // Cancellation is not an error
      });

      // ── Network errors ──
      req.on('error', (err) => {
        Logger.error('Request error', err);
        reject(new OpenRouterRequestError(
          `❌ Network error: ${err.message}`,
          undefined,
          undefined,
          (err as any).code,
        ));
      });

      req.write(bodyData);
      req.end();
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Tool call emission
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Report reasoning/thinking content. Uses the native `LanguageModelThinkingPart`
   * (proposed API) when available so VS Code renders a collapsible reasoning section,
   * and falls back to plain text where the proposed API is not enabled.
   */
  private reportReasoning(
    reasoning: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (this._thinkingPartAvailable) {
      progress.report(
        new vscode.LanguageModelThinkingPart(reasoning) as unknown as vscode.LanguageModelResponsePart,
      );
    } else {
      progress.report(new vscode.LanguageModelTextPart(reasoning));
    }
  }

  /**
   * Emit accumulated tool calls as LanguageModelToolCallPart to VS Code.
   * Clears the pending map after emitting.
   */
  private emitPendingToolCalls(
    pendingToolCalls: Map<number, { id: string; name: string; arguments: string }>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (pendingToolCalls.size === 0) { return; }

    for (const [, tc] of pendingToolCalls) {
      if (!tc.name) { continue; }
      try {
        const args = tc.arguments ? JSON.parse(tc.arguments) : {};
        Logger.info(`Emitting tool call: ${tc.name} (${tc.id})`);
        progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
      } catch (e) {
        Logger.error(`Failed to parse tool call arguments for ${tc.name}: ${tc.arguments}`, e);
        // Try to emit with raw arguments as a fallback
        try {
          progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, { _raw: tc.arguments }));
        } catch {
          // Give up on this tool call
        }
      }
    }
    pendingToolCalls.clear();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Usage statistics
  // ────────────────────────────────────────────────────────────────────────────

  /** Update the status bar with token usage and dollar cost from the latest request. */
  private updateUsageStats(usage: any, modelId: string): void {
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const total = usage.total_tokens || prompt + completion;
    // OpenRouter reports cache hits under prompt_tokens_details.cached_tokens
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;

    // Calculate dollar cost using model pricing from cache
    const model = this.cache.getModel(modelId);
    let costText = '';
    let costTooltip = '';
    if (model) {
      const inputCost = (prompt / 1_000_000) * model.pricing.promptPerMillion;
      const outputCost = (completion / 1_000_000) * model.pricing.completionPerMillion;
      const totalCost = inputCost + outputCost;

      if (totalCost > 0) {
        costText = ` · $${totalCost.toFixed(6)}`;
        costTooltip = `\nCost: $${inputCost.toFixed(6)} input + $${outputCost.toFixed(6)} output = $${totalCost.toFixed(6)}`;
        costTooltip += `\nPricing: $${model.pricing.promptPerMillion.toFixed(2)}/M input, $${model.pricing.completionPerMillion.toFixed(2)}/M output`;
      } else {
        costText = ' · Free';
        costTooltip = '\nCost: Free model';
      }
    }

    const cachedText = cached > 0 ? ` (${cached} cached)` : '';
    Logger.info(`Usage [${modelId}]: ${prompt} prompt${cachedText} + ${completion} completion = ${total} total tokens${costText}`);

    if (this._usageStatusBar) {
      this._usageStatusBar.text = `$(pulse) ${total} tokens (${prompt}↑ ${completion}↓)${costText}`;
      this._usageStatusBar.tooltip =
        `Last request: ${prompt} input${cachedText} + ${completion} output = ${total} total tokens${costTooltip}\nModel: ${modelId}`;
      this._usageStatusBar.show();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Error messages
  // ────────────────────────────────────────────────────────────────────────────

  /** Build a user-friendly error message from an OpenRouter API error response. */
  private buildFriendlyError(statusCode: number | undefined, body: string): string {
    let message = body;
    let guardrailPatterns: string[] = [];
    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message || body;
      if (Array.isArray(parsed?.error?.metadata?.patterns)) {
        guardrailPatterns = parsed.error.metadata.patterns;
      }
    } catch {
      // keep raw body
    }

    const lower = message.toLowerCase();

    if (
      statusCode === 404 &&
      (lower.includes('data policy') ||
        lower.includes('guardrail') ||
        lower.includes('no endpoints available'))
    ) {
      return (
        '❌ OpenRouter: No endpoints available for this model due to your account privacy/data policy settings.\n\n' +
        'This is an OpenRouter account setting, not an extension error. Many free models require enabling prompt logging/training.\n\n' +
        '➡️ Fix: open https://openrouter.ai/settings/privacy and enable the required data policy options, then try again.'
      );
    }

    if (this.isGuardrailBlockError(statusCode, body)) {
      const patternsText =
        guardrailPatterns.length > 0 ? ` Detected patterns: ${guardrailPatterns.join(', ')}.` : '';
      return (
        '❌ OpenRouter: Request blocked by security guardrails (not an API key problem).\n\n' +
        `Your organization's OpenRouter guardrails flagged the prompt content as a potential injection.${patternsText} ` +
        'This is usually a false positive triggered by long base64-like blobs in the context (images, data URIs, encoded strings in files).\n\n' +
        '➡️ Fix: remove base64-heavy files/images from the chat context, or ask your OpenRouter organization admin to relax the guardrail settings.'
      );
    }

    if (statusCode === 401 || statusCode === 403) {
      return (
        '❌ OpenRouter: Authorization failed (invalid or missing API key).\n\n' +
        '➡️ Fix: click the 🔑 icon in the OpenRouter panel and re-enter a valid key (format: sk-or-v1-...).'
      );
    }

    if (statusCode === 402) {
      return '❌ OpenRouter: Insufficient credits for this model. Add credits at https://openrouter.ai/settings/credits.';
    }

    if (statusCode === 429) {
      return '❌ OpenRouter: Rate limit exceeded. The extension will automatically retry with backoff.';
    }

    return `❌ OpenRouter Error (${statusCode}): ${message}`;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Max input tokens calculation
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate the maxInputTokens value to report to VS Code.
   * Instead of reporting the raw contextLength (which makes VS Code think
   * compaction is never needed), we subtract maxOutputTokens and apply a
   * 10% safety margin. This ensures VS Code triggers conversation compaction
   * before request bodies become too large and cause invalid_json errors.
   *
   * Users can override this via the `maxInputTokensOverride` setting.
   */
  private calculateMaxInputTokens(
    contextLength: number | undefined,
    maxOutputTokens: number | undefined,
  ): number {
    // Check for user override first
    const override = getConfig<number | null>('maxInputTokensOverride', null);
    if (override !== null && override !== undefined && override > 0) {
      return override;
    }

    const ctx = contextLength || 128000;
    const output = maxOutputTokens || 4096;
    const netInput = ctx - output;
    // Apply 10% safety margin
    const safetyMargin = Math.floor(netInput * 0.10);
    const result = netInput - safetyMargin;

    // Ensure we return at least a reasonable minimum
    return Math.max(result, 8192);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Token counting
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Estimate token count for input text.
   * Uses character-type analysis for better accuracy across languages
   * (Latin, CJK, Arabic, Cyrillic, Turkish, etc.).
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return this.estimateTokens(text);
    }

    // Handle structured message
    let totalTokens = 4; // Message overhead (role, delimiters)

    if (Array.isArray(text.content)) {
      for (const part of text.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          totalTokens += this.estimateTokens(part.value);
        } else if (this.isToolCallPart(part)) {
          // Tool calls: name + serialized arguments + structural overhead
          totalTokens += this.estimateTokens(part.name);
          totalTokens += this.estimateTokens(
            typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
          );
          totalTokens += 10; // Overhead for tool call JSON structure
        } else if (this.isToolResultPart(part)) {
          totalTokens += this.estimateTokens(this.extractTextFromParts(part.content));
          totalTokens += 5; // Overhead for tool result structure
        } else if (this.isImageDataPart(part)) {
          // Images: rough estimate — most vision models use ~85 (low-res) to ~765 (high-res) tokens
          totalTokens += 765;
        } else if (typeof part === 'string') {
          totalTokens += this.estimateTokens(part);
        } else if (part && typeof part === 'object' && 'value' in (part as any)) {
          totalTokens += this.estimateTokens((part as any).value || '');
        }
      }
    }

    // Safety multiplier: underestimation causes VS Code to skip compaction,
    // leading to enormous request bodies and invalid_json errors.
    // A 20% buffer ensures compaction triggers before requests become too large.
    const safetyFactor = 1.20;
    return Math.ceil(totalTokens * safetyFactor);
  }

  /**
   * Estimate tokens from a string using character-type analysis.
   * - Latin/ASCII characters: ~4 chars per token
   * - CJK, Arabic, Cyrillic, Turkish special chars: ~2 chars per token
   * - Whitespace: ~5 chars per token
   */
  private estimateTokens(text: string): number {
    if (!text) { return 0; }

    let latinChars = 0;
    let nonLatinChars = 0;
    let whitespace = 0;

    for (const char of text) {
      const code = char.codePointAt(0) || 0;
      if (code <= 0x7F) {
        // ASCII range
        if (/\s/.test(char)) { whitespace++; }
        else { latinChars++; }
      } else if (code <= 0x024F) {
        // Extended Latin (covers Turkish İ, ş, ç, ğ, ü, ö etc.)
        latinChars++;
      } else {
        // CJK, Arabic, Cyrillic, Devanagari, and other non-Latin scripts
        nonLatinChars++;
      }
    }

    const latinTokens = Math.ceil(latinChars / 4);
    const nonLatinTokens = Math.ceil(nonLatinChars / 2);
    const wsTokens = Math.ceil(whitespace / 5);

    return Math.max(1, latinTokens + nonLatinTokens + wsTokens);
  }
}
