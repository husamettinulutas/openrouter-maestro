/**
 * Which model actually answered a request.
 *
 * OpenRouter names the model that served each completion in the stream's
 * `model` field, and the upstream provider in `provider`. They differ from the
 * requested id when a router such as `openrouter/auto` picks the model, and
 * also when an alias resolves to a dated version
 * (`anthropic/claude-sonnet-4` → `anthropic/claude-4-sonnet-20250522`).
 */

export interface ServedModelInfo {
  /** The model that answered, when OpenRouter reported one that differs from the request. */
  served?: string;
  /** Upstream provider name as OpenRouter reports it, e.g. "Anthropic". */
  provider?: string;
  /**
   * Show the served model next to the usage figures: only when the answer came
   * from a router's pick or another vendor, not for a dated alias of the same model.
   */
  showInline: boolean;
}

/** Router models are priced "-1" (varies) in the catalog; see isVariablePrice. */
export function describeServedModel(
  requested: string,
  served: string | undefined,
  provider: string | undefined,
  requestedIsRouter: boolean,
): ServedModelInfo {
  const cleanProvider = provider && provider.trim() ? provider.trim() : undefined;
  if (!served || served === requested) {
    return { provider: cleanProvider, showInline: false };
  }
  const vendor = (id: string) => id.split('/')[0];
  return {
    served,
    provider: cleanProvider,
    showInline: requestedIsRouter || vendor(served) !== vendor(requested),
  };
}

/** OpenRouter prices routers as "-1": the cost depends on the model they pick. */
export function isVariablePrice(perToken: number): boolean {
  return perToken < 0;
}

/** "anthropic/claude-4-sonnet-20250522" → "claude-4-sonnet-20250522" */
export function shortModelName(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}
