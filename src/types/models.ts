/**
 * OpenRouter Model type definitions
 * Maps to the OpenRouter /api/v1/models response
 */

/** Raw model object from OpenRouter API */
export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  created?: number;
  context_length: number;
  pricing: {
    prompt: string;   // Cost per token as string (e.g. "0.000003")
    completion: string;
    image?: string;
    request?: string;
  };
  architecture: {
    input_modalities: string[];   // ["text", "image"]
    output_modalities: string[];  // ["text"]
    tokenizer?: string;
    instruct_type?: string | null;
  };
  top_provider: {
    max_completion_tokens: number | null;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  per_request_limits?: {
    prompt_tokens?: string;
    completion_tokens?: string;
  } | null;
}

/** OpenRouter API response for /api/v1/models (paginated since 2026) */
export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
  total_count?: number;
  links?: {
    next?: string | null;
    prev?: string | null;
  };
}

/** Processed model with computed properties for UI */
export interface ProcessedModel {
  id: string;
  name: string;
  description: string;
  provider: string;       // Extracted from id (e.g. "anthropic" from "anthropic/claude-3")
  modelSlug: string;      // Extracted from id (e.g. "claude-3")
  contextLength: number;
  maxOutputTokens: number;
  pricing: {
    promptPerMillion: number;     // Cost per million tokens
    completionPerMillion: number;
    imagePerUnit?: number;
  };
  capabilities: {
    text: boolean;
    vision: boolean;
    toolCalling: boolean;
    imageOutput: boolean;
    reasoning: boolean;
  };
  supportedParameters: string[];
  isFree: boolean;
  createdAt?: number;
}

/** User's selected model configuration (Draft) */
export interface SelectedModel {
  id: string;
  name: string;
  addedAt: number;       // Timestamp when added
  enabled: boolean;      // Whether visible in Copilot
}

/** Active model entry managed by this extension */
export interface ActiveCopilotModel {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens?: number;
}


/** Agent targets OpenRouter Maestro can wire a model into */
export type AgentTarget = 'copilot' | 'claude-code' | 'codex';

/** External agents that keep a saved model list (Copilot has its own list). */
export type ExternalAgentTarget = 'claude-code' | 'codex';

/**
 * One model saved in an external agent's list. Being in the list costs
 * nothing — no config file is touched until the model is activated.
 */
export interface AgentModelEntry {
  id: string;
  name: string;
  addedAt: number;
}

/** A single agent's saved model list, sent to the webview. */
export interface AgentRoster {
  target: ExternalAgentTarget;
  models: AgentModelEntry[];
}

/** Status of an external agent integration (Claude Code / Codex) */
export interface IntegrationStatus {
  target: AgentTarget;
  /** Whether the agent's CLI/config directory was detected on this machine */
  installed: boolean;
  /** Whether Maestro-managed config is currently applied */
  active: boolean;
  /** The OpenRouter model currently wired in, if active */
  modelId?: string;
  /** Path of the config file being managed */
  configPath?: string;
  /** Human-readable extra info (errors, hints) */
  detail?: string;
}

/** Cache metadata */
export interface CacheMetadata {
  lastUpdated: number;
  modelCount: number;
  version: string;
}

/** Messages between Webview and Extension Host */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'requestModels'; filters?: ModelFilters }
  | { type: 'addModel'; modelId: string }
  | { type: 'removeModel'; modelId: string }
  | { type: 'removeActiveModel'; modelId: string }
  | { type: 'clearDraftModels' }
  | { type: 'toggleModel'; modelId: string; enabled: boolean }
  | { type: 'applyToCopilot' }
  | { type: 'toggleCopilot'; modelId: string }
  | { type: 'addToAgent'; target: ExternalAgentTarget; modelId: string }
  | { type: 'removeFromAgent'; target: ExternalAgentTarget; modelId: string }
  | { type: 'activateAgentModel'; target: ExternalAgentTarget; modelId: string }
  | { type: 'deactivateAgent'; target: ExternalAgentTarget }
  | { type: 'getAgentRosters' }
  | { type: 'reloadWindow' }
  | { type: 'restoreIntegration'; target: ExternalAgentTarget }
  | { type: 'getIntegrationStatus' }
  | { type: 'setApiKey' }
  | { type: 'syncModels' }
  | { type: 'getSelectedModels' }
  | { type: 'getApiKeyStatus' };

export type ExtensionMessage =
  | { type: 'modelsLoaded'; models: ProcessedModel[]; total: number }
  | { type: 'selectedModelsUpdated'; models: SelectedModel[] }
  | { type: 'activeModelsUpdated'; models: ActiveCopilotModel[] }
  | { type: 'modelAdded'; modelId: string }
  | { type: 'modelRemoved'; modelId: string }
  | { type: 'appliedToCopilot'; success: boolean; message: string }
  | { type: 'copilotToggled'; modelId: string; enabled: boolean; message: string }
  | { type: 'integrationApplied'; target: AgentTarget; success: boolean; message: string }
  | { type: 'integrationStatus'; statuses: IntegrationStatus[] }
  | { type: 'agentRostersUpdated'; rosters: AgentRoster[] }
  | { type: 'error'; message: string }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'apiKeyStatus'; hasKey: boolean }
  | { type: 'syncComplete'; newModelsCount: number };

/** Filter options for model browsing */
export interface ModelFilters {
  search?: string;
  capabilities?: {
    vision?: boolean;
    toolCalling?: boolean;
    imageOutput?: boolean;
  };
  priceRange?: {
    min?: number;
    max?: number;
  };
  providers?: string[];
  contextLengthMin?: number;
  freeOnly?: boolean;
  sortBy?: 'price-asc' | 'price-desc' | 'context-desc' | 'name-asc' | 'newest';
}

/** Extension state persisted in globalState */
export interface ExtensionState {
  selectedModels: SelectedModel[];
  lastSyncTimestamp?: number;
  dismissedNotifications?: string[];
}
