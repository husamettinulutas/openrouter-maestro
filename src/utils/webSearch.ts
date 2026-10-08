/**
 * Web search through OpenRouter's `openrouter:web_search` server tool.
 *
 * Copilot has no web search for BYOK models. OpenRouter runs this tool on its
 * side: the model decides when to search, OpenRouter fetches the results and
 * feeds them back, and the stream carries the sources as `url_citation`
 * annotations. It coexists with the function tools of agent mode.
 */

export type WebSearchEngine = 'parallel' | 'exa' | 'native' | 'auto';

export interface WebSearchSettings {
  engine: WebSearchEngine;
  maxResults: number;
}

const ENGINES: readonly WebSearchEngine[] = ['exa', 'parallel', 'native', 'auto'];

export function normalizeEngine(value: unknown): WebSearchEngine {
  return ENGINES.includes(value as WebSearchEngine) ? (value as WebSearchEngine) : 'exa';
}

/**
 * The server tool entry for the request's `tools` array.
 * Exa and Parallel run in their `fast` mode ($0.007 and $0.001 per search).
 * Exa is the default: in tests on time-sensitive questions ("latest VS Code
 * version") it was current where Parallel returned versions months old.
 * Exa excerpts are kept short so results do not flood the context.
 */
export function buildWebSearchTool(settings: WebSearchSettings): Record<string, unknown> {
  const engine = normalizeEngine(settings.engine);
  const maxResults = Math.min(10, Math.max(1, Math.round(settings.maxResults) || 3));
  const parameters: Record<string, unknown> = { engine, max_results: maxResults };
  if (engine === 'parallel' || engine === 'exa') {
    parameters.mode = 'fast';
  }
  if (engine === 'exa') {
    parameters.search_context_size = 'low';
  }
  return { type: 'openrouter:web_search', parameters };
}

export interface UrlCitation {
  url: string;
  title?: string;
}

/** Add the `url_citation` annotations of one stream delta, keeping the first title seen per URL. */
export function collectCitations(into: Map<string, UrlCitation>, annotations: unknown): void {
  if (!Array.isArray(annotations)) {
    return;
  }
  for (const annotation of annotations) {
    const citation = annotation?.type === 'url_citation' ? annotation.url_citation : undefined;
    const url = typeof citation?.url === 'string' ? citation.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || into.has(url)) {
      continue;
    }
    const title = typeof citation.title === 'string' ? citation.title.replace(/\s+/g, ' ').trim() : '';
    into.set(url, { url, title: title || undefined });
  }
}

/** A Markdown list of the sources, appended after the answer. */
export function formatSources(citations: Iterable<UrlCitation>): string {
  const lines: string[] = [];
  for (const { url, title } of citations) {
    const label = (title || new URL(url).hostname).replace(/[[\]]/g, '');
    // Parentheses and spaces would end the Markdown link early.
    const href = url.replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    lines.push(`- [${label}](${href})`);
  }
  return lines.length ? `\n\n**Sources**\n${lines.join('\n')}\n` : '';
}
