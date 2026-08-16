import { AgentTarget, IntegrationStatus } from '../types/models';

/**
 * Model metadata forwarded to integrations so agent configs can be tuned to
 * the model's real limits (agents otherwise assume Anthropic/OpenAI defaults).
 */
export interface AgentApplyOptions {
  /** The model's context window in tokens (OpenRouter context_length). */
  contextLength?: number;
  /** The model's max completion tokens, if the provider reports one. */
  maxOutputTokens?: number;
  /** Whether the model emits reasoning/thinking output. */
  supportsReasoning?: boolean;
}

/**
 * Common contract for external agent integrations (Claude Code, Codex).
 * Implementations edit the agent's own config files (with backups) so the
 * agent uses an OpenRouter model instead of its built-in provider.
 */
export interface AgentIntegration {
  readonly target: AgentTarget;

  /** Detect installation + whether Maestro config is currently applied. */
  getStatus(): Promise<IntegrationStatus>;

  /**
   * Wire the given OpenRouter model into the agent.
   * @param modelId OpenRouter model ID (e.g. "anthropic/claude-sonnet-4.5")
   * @param apiKey  OpenRouter API key to authenticate with
   * @param options Model metadata used to tune the agent's config
   */
  apply(modelId: string, apiKey: string, options?: AgentApplyOptions): Promise<IntegrationStatus>;

  /** Remove Maestro-managed config so the agent falls back to its defaults. */
  restore(): Promise<IntegrationStatus>;
}
