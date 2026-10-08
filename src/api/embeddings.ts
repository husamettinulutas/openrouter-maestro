/**
 * OpenRouter embeddings: POST {endpoint}/embeddings with { model, input: string[] }.
 * Used by the codebase search tool, since Copilot's own embeddings need a
 * Copilot subscription.
 */

export interface EmbeddingsResult {
  vectors: number[][];
  /** USD, when OpenRouter reports it. */
  cost?: number;
}

/**
 * OpenAI's text-embedding-3 models can return shorter vectors that keep most
 * of their quality; 512 dimensions keep the local index a third of the size.
 */
export function preferredDimensions(model: string): number | undefined {
  return /^openai\/text-embedding-3-/.test(model) ? 512 : undefined;
}

export class EmbeddingsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'EmbeddingsError';
  }
}

export async function createEmbeddings(
  apiKey: string,
  endpoint: string,
  model: string,
  inputs: string[],
  options: { dimensions?: number; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<EmbeddingsResult> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...options.headers,
      },
      body: JSON.stringify({ model, input: inputs, ...(options.dimensions ? { dimensions: options.dimensions } : {}) }),
    });
    const body = await response.text();
    if (response.ok) {
      const json = JSON.parse(body);
      const data: { embedding: number[]; index: number }[] = Array.isArray(json?.data) ? json.data : [];
      if (data.length !== inputs.length) {
        throw new EmbeddingsError(`Expected ${inputs.length} embeddings from ${model}, got ${data.length}.`);
      }
      const vectors = new Array<number[]>(inputs.length);
      for (const item of data) {
        vectors[item.index] = item.embedding;
      }
      return { vectors, cost: typeof json?.usage?.cost === 'number' ? json.usage.cost : undefined };
    }
    // Rate limits and overloaded upstreams: back off and try twice more.
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    let message = body;
    try {
      message = JSON.parse(body)?.error?.message ?? body;
    } catch {
      // keep the raw body
    }
    throw new EmbeddingsError(`OpenRouter embeddings (${model}) failed with HTTP ${response.status}: ${message.slice(0, 300)}`, response.status);
  }
}
