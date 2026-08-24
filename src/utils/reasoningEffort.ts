/**
 * OpenRouter / Copilot thinking-effort helpers.
 *
 * Copilot shows the model-picker "Thinking Effort" submenu only when a
 * LanguageModelChatInformation includes configurationSchema.reasoningEffort
 * with group: 'navigation'. The chosen value comes back on
 * ProvideLanguageModelChatResponseOptions.modelConfiguration.
 *
 * Both fields are passed through by VS Code without a proposed-API gate
 * (see extHostLanguageModels.ts), so this works from a stable extension —
 * only the TypeScript surface needs the local d.ts augmentation.
 *
 * Adapted from @Irvingouj's fork (commit c2dc1de), with the id-substring
 * heuristic removed: it never matches the live catalog and can invent effort
 * support for models that never declared it.
 */

export const GATEWAY_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof GATEWAY_EFFORTS)[number];

export interface ModelReasoning {
  /** Effort values this model accepts, highest-first as OpenRouter returns them. */
  supportedEfforts: string[];
  defaultEffort?: string;
  defaultEnabled: boolean;
  mandatory: boolean;
  supportsMaxTokens: boolean;
}

export interface OpenRouterReasoningMeta {
  supported_efforts?: string[] | null;
  default_effort?: string | null;
  default_enabled?: boolean;
  mandatory?: boolean;
  supports_max_tokens?: boolean;
}

const EFFORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: 'No extra reasoning — fastest, cheapest',
  minimal: 'Light reasoning for simple tasks',
  low: 'Faster responses with less reasoning',
  medium: 'Balanced reasoning and speed',
  high: 'Greater reasoning depth, slower and more tokens',
  xhigh: 'Very deep reasoning, slower and more tokens',
  max: 'Maximum reasoning depth',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function effortDescription(effort: string): string {
  return EFFORT_DESCRIPTIONS[effort] ?? effort;
}

function isEffort(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse OpenRouter /models reasoning metadata plus supported_parameters.
 * Returns undefined when the model does not expose effort selection.
 *
 * A model qualifies only when it declares reasoning itself — either via the
 * `reasoning` catalog object or by listing `reasoning`/`reasoning_effort` in
 * `supported_parameters`. We never guess from the model id.
 */
export function parseModelReasoning(
  raw: {
    reasoning?: OpenRouterReasoningMeta;
    supported_parameters?: string[];
    id?: string;
  },
): ModelReasoning | undefined {
  const meta = raw.reasoning;
  const params = raw.supported_parameters || [];
  const hasReasoningParam =
    params.includes('reasoning') || params.includes('reasoning_effort');

  let supportedEfforts: string[] | undefined;

  if (meta) {
    if (Array.isArray(meta.supported_efforts) && meta.supported_efforts.length > 0) {
      supportedEfforts = meta.supported_efforts.filter(isEffort);
    } else if (meta.supported_efforts === null) {
      supportedEfforts = [...GATEWAY_EFFORTS];
    }
  }

  // Model declares the parameter but ships no effort list (e.g. the
  // openrouter/auto router models). Offer the widely-supported subset.
  if (!supportedEfforts && hasReasoningParam) {
    supportedEfforts = ['high', 'medium', 'low', 'none'];
  }

  if (!supportedEfforts || supportedEfforts.length === 0) {
    return undefined;
  }

  const mandatory = meta?.mandatory === true;
  if (mandatory) {
    supportedEfforts = supportedEfforts.filter((e) => e !== 'none');
    if (supportedEfforts.length === 0) {
      return undefined;
    }
  }

  const defaultEffort =
    (isEffort(meta?.default_effort) && meta!.default_effort !== 'none'
      ? meta!.default_effort
      : undefined) ??
    supportedEfforts.find((e) => e === 'medium') ??
    supportedEfforts[0];

  return {
    supportedEfforts,
    defaultEffort,
    defaultEnabled: meta?.default_enabled !== false,
    mandatory,
    supportsMaxTokens: meta?.supports_max_tokens === true,
  };
}

export interface ReasoningRequestOptions {
  modelConfiguration?: { readonly [key: string]: unknown };
  modelOptions?: { readonly [key: string]: unknown };
}

/**
 * Resolve the effort to send on this request.
 * Priority: Copilot picker → per-model override → catalog default.
 * Returns undefined when the model has no effort control, or the user
 * picked "none" on a non-mandatory model (omit the reasoning payload).
 */
export function resolveReasoningEffort(
  reasoning: ModelReasoning | undefined,
  options: ReasoningRequestOptions,
  perModelOverride?: string,
): string | undefined {
  if (!reasoning) {
    return undefined;
  }

  const fromPicker = options.modelConfiguration?.reasoningEffort;
  const fromModelOptions = options.modelOptions?.reasoningEffort;
  const candidates = [fromPicker, fromModelOptions, perModelOverride, reasoning.defaultEffort];

  for (const candidate of candidates) {
    if (!isEffort(candidate)) {
      continue;
    }
    if (reasoning.supportedEfforts.includes(candidate)) {
      if (candidate === 'none' && !reasoning.mandatory) {
        return 'none';
      }
      return candidate;
    }
  }

  return reasoning.defaultEffort;
}

/** JSON schema that makes Copilot render the Thinking Effort submenu. */
export function buildThinkingEffortSchema(
  reasoning: ModelReasoning,
  selectedEffort?: string,
): {
  properties: {
    reasoningEffort: {
      type: 'string';
      title: string;
      enum: string[];
      enumItemLabels: string[];
      enumDescriptions: string[];
      default: string;
      group: 'navigation';
    };
  };
} {
  const defaultEffort =
    (selectedEffort && reasoning.supportedEfforts.includes(selectedEffort)
      ? selectedEffort
      : undefined) ??
    reasoning.defaultEffort ??
    reasoning.supportedEfforts[0];

  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        enum: reasoning.supportedEfforts,
        enumItemLabels: reasoning.supportedEfforts.map(effortLabel),
        enumDescriptions: reasoning.supportedEfforts.map(effortDescription),
        default: defaultEffort,
        group: 'navigation',
      },
    },
  };
}
