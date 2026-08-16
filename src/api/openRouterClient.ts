import * as https from 'https';
import * as vscode from 'vscode';
import { OpenRouterModel, OpenRouterModelsResponse, ProcessedModel } from '../types/models';
import { Logger } from '../utils/logger';
import { normalizeApiKey } from '../utils/apiKeyUtils';
import { getAttributionHeaders } from '../utils/branding';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Resolve the API base URL from settings (proxy support), without a trailing slash. */
function getBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('openrouterMaestro')
    .get<string>('apiEndpoint', DEFAULT_BASE_URL);
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Client for the OpenRouter REST API.
 * Handles model listing, filtering, and rate limiting.
 */
export class OpenRouterClient {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 1000; // 1 second between requests

  constructor(private apiKey?: string) {}

  setApiKey(key: string): void {
    this.apiKey = normalizeApiKey(key);
  }

  /**
   * Fetch the full list of models from OpenRouter.
   * Works with or without API key (endpoint is public).
   */
  async fetchModels(): Promise<ProcessedModel[]> {
    await this.rateLimit();

    Logger.info('Fetching models from OpenRouter API...');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getAttributionHeaders(),
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${normalizeApiKey(this.apiKey)}`;
      }

      // The /models endpoint is paginated since 2026 (data + total_count + links).
      // Follow links.next so no models are silently dropped.
      const modelsEndpoint = `${getBaseUrl()}/models`;
      const allModels: OpenRouterModel[] = [];
      let nextUrl: string | undefined = modelsEndpoint;
      const maxPages = 20;

      for (let page = 0; nextUrl && page < maxPages; page++) {
        const data: OpenRouterModelsResponse = await this.getJson<OpenRouterModelsResponse>(
          nextUrl,
          headers
        );

        if (!data.data || !Array.isArray(data.data)) {
          throw new Error('Invalid response format from OpenRouter API');
        }

        allModels.push(...data.data);

        const next = data.links?.next || undefined;
        // links.next may be absolute or relative to the API origin.
        nextUrl = next ? new URL(next, modelsEndpoint).toString() : undefined;
      }

      Logger.info(`Fetched ${allModels.length} models from OpenRouter`);

      return allModels
        .map((model) => this.processModel(model))
        .filter((m): m is ProcessedModel => m !== null);
    } catch (error) {
      Logger.error('Failed to fetch models from OpenRouter', error);
      throw error;
    }
  }

  /** GET JSON via global fetch when available, falling back to the https module. */
  private async getJson<T>(urlStr: string, headers: Record<string, string>): Promise<T> {
    if (typeof fetch === 'function') {
      const response = await fetch(urlStr, { headers });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
      }
      return (await response.json()) as T;
    }
    return this.httpGetJson<T>(urlStr, headers);
  }

  /**
   * HTTPS GET JSON fallback using Node's built-in https module.
   */
  private httpGetJson<T>(urlStr: string, headers: Record<string, string>): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = https.get(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error('Failed to parse OpenRouter JSON response'));
              }
            } else {
              reject(new Error(`OpenRouter API HTTP ${res.statusCode}: ${body}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.end();
    });
  }

  /**
   * Transform a raw OpenRouter model into our ProcessedModel format.
   */
  private processModel(raw: OpenRouterModel): ProcessedModel | null {
    try {
      const [provider, ...slugParts] = raw.id.split('/');
      const modelSlug = slugParts.join('/');

      if (!provider || !modelSlug) {
        return null;
      }

      const promptCost = parseFloat(raw.pricing?.prompt || '0');
      const completionCost = parseFloat(raw.pricing?.completion || '0');

      const inputModalities = raw.architecture?.input_modalities || ['text'];
      const outputModalities = raw.architecture?.output_modalities || ['text'];
      const supportedParams = raw.supported_parameters || [];

      return {
        id: raw.id,
        name: raw.name || modelSlug,
        description: raw.description || '',
        provider,
        modelSlug,
        contextLength: raw.context_length || 0,
        maxOutputTokens: raw.top_provider?.max_completion_tokens || 4096,
        pricing: {
          promptPerMillion: promptCost * 1_000_000,
          completionPerMillion: completionCost * 1_000_000,
          imagePerUnit: raw.pricing?.image ? parseFloat(raw.pricing.image) : undefined,
        },
        capabilities: {
          text: inputModalities.includes('text'),
          vision: inputModalities.includes('image'),
          toolCalling: supportedParams.includes('tools') || supportedParams.includes('tool_choice'),
          imageOutput: outputModalities.includes('image'),
          reasoning: supportedParams.includes('reasoning') ||
                     raw.id.includes('thinking') ||
                     raw.id.includes('reasoner'),
        },
        supportedParameters: supportedParams,
        isFree: promptCost === 0 && completionCost === 0,
        createdAt: raw.created,
      };
    } catch (error) {
      Logger.warn(`Failed to process model ${raw.id}`, error);
      return null;
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}
