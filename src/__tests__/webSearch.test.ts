import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildWebSearchTool, collectCitations, formatSources, normalizeEngine, UrlCitation } from '../utils/webSearch';

describe('buildWebSearchTool', () => {
  it('runs Parallel in fast mode', () => {
    assert.deepEqual(buildWebSearchTool({ engine: 'parallel', maxResults: 3 }), {
      type: 'openrouter:web_search',
      parameters: { engine: 'parallel', max_results: 3, mode: 'fast' },
    });
  });

  it('keeps Exa excerpts short', () => {
    assert.deepEqual(buildWebSearchTool({ engine: 'exa', maxResults: 5 }).parameters, {
      engine: 'exa', max_results: 5, mode: 'fast', search_context_size: 'low',
    });
  });

  it('passes native and auto through without a mode and clamps the result count', () => {
    assert.deepEqual(buildWebSearchTool({ engine: 'native', maxResults: 50 }).parameters, { engine: 'native', max_results: 10 });
    assert.deepEqual(buildWebSearchTool({ engine: 'auto', maxResults: 0 }).parameters, { engine: 'auto', max_results: 3 });
  });

  it('falls back to Exa, the default, for an unknown engine', () => {
    assert.equal(normalizeEngine('bing'), 'exa');
    assert.equal(normalizeEngine(undefined), 'exa');
  });
});

describe('collectCitations', () => {
  it('keeps url_citation annotations once per URL, as streamed by OpenRouter', () => {
    const into = new Map<string, UrlCitation>();
    collectCitations(into, [{ type: 'url_citation', url_citation: { url: 'https://code.visualstudio.com/updates', title: 'Visual  Studio Code\n1.141', start_index: 0, end_index: 0, content: '…' } }]);
    collectCitations(into, [{ type: 'url_citation', url_citation: { url: 'https://code.visualstudio.com/updates', title: 'Duplicate' } }]);
    collectCitations(into, [{ type: 'file_citation' }, { type: 'url_citation', url_citation: { url: 'javascript:alert(1)' } }]);
    collectCitations(into, 'not an array');
    assert.deepEqual([...into.values()], [{ url: 'https://code.visualstudio.com/updates', title: 'Visual Studio Code 1.141' }]);
  });
});

describe('formatSources', () => {
  it('lists sources as Markdown links that cannot break out of the link syntax', () => {
    const text = formatSources([
      { url: 'https://en.wikipedia.org/wiki/Foo_(bar)', title: 'Foo [bar]' },
      { url: 'https://example.com/page' },
    ]);
    assert.equal(text, '\n\n**Sources**\n- [Foo bar](https://en.wikipedia.org/wiki/Foo_%28bar%29)\n- [example.com](https://example.com/page)\n');
  });

  it('returns nothing without sources', () => {
    assert.equal(formatSources([]), '');
  });
});
