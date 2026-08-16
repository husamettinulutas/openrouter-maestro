/**
 * Model Filtering & Search Engine
 * Client-side filtering for instant search results.
 */
const Filters = (function() {
  let currentFilters = {
    search: '',
    vision: false,
    toolCalling: false,
    free: false,
    sortBy: 'name-asc',
    provider: '',
  };

  /**
   * Apply all active filters to a model list.
   * Returns a new filtered + sorted array.
   */
  function apply(models) {
    let result = [...models];

    // Text search (fuzzy)
    if (currentFilters.search) {
      const q = currentFilters.search.toLowerCase().trim();
      const terms = q.split(/\s+/);
      result = result.filter(m => {
        const haystack = `${m.name} ${m.id} ${m.provider} ${m.description}`.toLowerCase();
        return terms.every(term => haystack.includes(term));
      });
    }

    // Capability filters
    if (currentFilters.vision) {
      result = result.filter(m => m.capabilities.vision);
    }
    if (currentFilters.toolCalling) {
      result = result.filter(m => m.capabilities.toolCalling);
    }
    if (currentFilters.free) {
      result = result.filter(m => m.isFree);
    }

    // Provider filter
    if (currentFilters.provider) {
      result = result.filter(m => m.provider === currentFilters.provider);
    }

    // Sorting
    switch (currentFilters.sortBy) {
      case 'price-asc':
        result.sort((a, b) => a.pricing.promptPerMillion - b.pricing.promptPerMillion);
        break;
      case 'price-desc':
        result.sort((a, b) => b.pricing.promptPerMillion - a.pricing.promptPerMillion);
        break;
      case 'context-desc':
        result.sort((a, b) => b.contextLength - a.contextLength);
        break;
      case 'name-asc':
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'newest':
        result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        break;
    }

    return result;
  }

  /** Update a single filter value and return all filters */
  function set(key, value) {
    currentFilters[key] = value;
    return { ...currentFilters };
  }

  /** Toggle a boolean filter */
  function toggle(key) {
    currentFilters[key] = !currentFilters[key];
    return { ...currentFilters };
  }

  /** Get current filter state */
  function get() {
    return { ...currentFilters };
  }

  /** Reset all filters */
  function reset() {
    currentFilters = {
      search: '',
      vision: false,
      toolCalling: false,
      free: false,
      sortBy: 'name-asc',
      provider: '',
    };
    return { ...currentFilters };
  }

  /** Get count of active filters */
  function activeCount() {
    let count = 0;
    if (currentFilters.search) count++;
    if (currentFilters.vision) count++;
    if (currentFilters.toolCalling) count++;
    if (currentFilters.free) count++;
    if (currentFilters.provider) count++;
    return count;
  }

  return { apply, set, toggle, get, reset, activeCount };
})();
