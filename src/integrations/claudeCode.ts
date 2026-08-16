import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentApplyOptions, AgentIntegration } from './agentIntegration';
import { IntegrationStatus } from '../types/models';
import { backupOnce, readJsonFile, sanitizeModelId, writeJsonFileAtomic } from './shared';
import { Logger } from '../utils/logger';
import { OPENROUTER_APP_TITLE, OPENROUTER_APP_URL } from '../utils/branding';

/**
 * OpenRouter's Anthropic-compatible endpoint ("Anthropic skin").
 * Claude Code appends /v1/messages itself, so no /v1 suffix here.
 * Ref: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
 */
const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';

/** globalState key holding the pre-apply snapshot used by restore(). */
const SNAPSHOT_KEY = 'maestro-claude-code-snapshot';

/** The env vars Maestro manages inside Claude Code's settings "env" block. */
const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;

interface ClaudeSnapshot {
  /** Settings file the env block was written to. */
  settingsPath: string;
  /** Previous values of managed keys (undefined = key was absent). */
  previousEnv: Record<string, string | undefined>;
  /** Previous global value of VS Code claudeCode.environmentVariables. */
  previousVsCodeEnvVars: unknown;
  /** Previous global value of VS Code claudeCode.disableLoginPrompt. */
  previousDisableLoginPrompt?: unknown;
  /**
   * Previous top-level "model" key in the settings file — it can shadow the
   * ANTHROPIC_MODEL env var, so apply() removes it and restore() puts it back.
   */
  previousTopLevelModel?: unknown;
}

interface ClaudeSettingsFile {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Claude Code integration.
 *
 * Writes the ANTHROPIC_* env vars into Claude Code's settings file so both the
 * CLI and the VS Code extension talk to OpenRouter's native Anthropic-compatible
 * endpoint. Also mirrors the gateway credential into VS Code's
 * `claudeCode.environmentVariables` setting, which the Claude Code extension
 * checks before launching.
 */
export class ClaudeCodeIntegration implements AgentIntegration {
  readonly target = 'claude-code' as const;

  constructor(private readonly globalState: vscode.Memento) {}

  // ── Paths ──────────────────────────────────────────────────────────────────

  private get claudeDir(): string {
    return path.join(os.homedir(), '.claude');
  }

  /** Resolve the settings file to manage based on the configured scope. */
  private getSettingsPath(): string {
    const scope = vscode.workspace
      .getConfiguration('openrouterMaestro')
      .get<string>('claudeCode.settingsScope', 'user');

    if (scope === 'project') {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        // settings.local.json is gitignored by Claude Code — safe for credentials.
        return path.join(ws.uri.fsPath, '.claude', 'settings.local.json');
      }
      Logger.warn('claudeCode.settingsScope is "project" but no workspace is open; falling back to user scope');
    }
    return path.join(this.claudeDir, 'settings.json');
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(): Promise<IntegrationStatus> {
    const settingsPath = this.getSettingsPath();
    const installed =
      fs.existsSync(this.claudeDir) || fs.existsSync(path.join(os.homedir(), '.claude.json'));

    let active = false;
    let modelId: string | undefined;
    let detail: string | undefined;

    try {
      const settings = readJsonFile<ClaudeSettingsFile>(settingsPath);
      const env = settings?.env;
      if (env?.ANTHROPIC_BASE_URL?.includes('openrouter.ai')) {
        active = true;
        modelId = env.ANTHROPIC_MODEL;
      }
      // A top-level "model" shadows ANTHROPIC_MODEL. Claude Code's /model
      // picker writes it, and a pick can go stale (point at a model that no
      // longer resolves at the gateway). Surface it so the user knows what's live.
      if (typeof settings?.model === 'string' && settings.model.trim() !== '') {
        if (active) {
          detail = `⚠️ Claude Code's own "model" setting ("${settings.model}") overrides the model shown here. Re-apply a model in Maestro to clear it.`;
          modelId = settings.model;
        }
      }
    } catch (err) {
      detail = `Could not parse ${settingsPath}: ${err instanceof Error ? err.message : err}`;
    }

    return { target: this.target, installed, active, modelId, configPath: settingsPath, detail };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  async apply(modelId: string, apiKey: string, options?: AgentApplyOptions): Promise<IntegrationStatus> {
    modelId = sanitizeModelId(modelId);
    const settingsPath = this.getSettingsPath();

    // If a previous apply targeted a different settings file (the scope setting
    // changed), un-wire that file first so two files never stay wired at once.
    const existingSnapshot = this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY);
    if (existingSnapshot && existingSnapshot.settingsPath !== settingsPath) {
      await this.restore();
    }

    backupOnce(settingsPath);

    let settings: ClaudeSettingsFile;
    try {
      settings = readJsonFile<ClaudeSettingsFile>(settingsPath) ?? {};
    } catch (err) {
      throw new Error(
        `${settingsPath} contains invalid JSON — fix or delete it first (${err instanceof Error ? err.message : err})`
      );
    }

    const env: Record<string, string> = { ...(settings.env ?? {}) };

    // Snapshot previous values once (first apply wins) so restore() returns
    // to the true pre-Maestro state even after switching models repeatedly.
    if (!this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY)) {
      const previousEnv: Record<string, string | undefined> = {};
      for (const key of MANAGED_ENV_KEYS) {
        previousEnv[key] = env[key];
      }
      const snapshot: ClaudeSnapshot = {
        settingsPath,
        previousEnv,
        previousVsCodeEnvVars: vscode.workspace
          .getConfiguration()
          .inspect('claudeCode.environmentVariables')?.globalValue,
        previousDisableLoginPrompt: vscode.workspace
          .getConfiguration()
          .inspect('claudeCode.disableLoginPrompt')?.globalValue,
        previousTopLevelModel: settings.model,
      };
      await this.globalState.update(SNAPSHOT_KEY, snapshot);
    }

    const smallFast = vscode.workspace
      .getConfiguration('openrouterMaestro')
      .get<string>('claudeCode.smallFastModel', '')
      .trim();

    env.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    // Must be explicitly empty (not absent) so Claude Code doesn't fall back
    // to x-api-key auth against Anthropic.
    env.ANTHROPIC_API_KEY = '';
    env.ANTHROPIC_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    // Background/utility tasks (haiku-class): cheaper model if configured.
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallFast || modelId;
    env.CLAUDE_CODE_SUBAGENT_MODEL = modelId;
    // Gateway model discovery is deliberately NOT enabled: models picked from
    // its "/model" list persist as a top-level "model" key in settings.json
    // that shadows ANTHROPIC_MODEL and goes stale silently.
    // Model switching stays in Maestro, where ids are always written verbatim.
    delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
    // Claude Code's beta diagnostics send previous_message_id (an Anthropic
    // "msg_..." id) with each request; OpenRouter's ids differ, so the field
    // 400s. Disabling experimental betas keeps requests gateway-compatible.
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
    // Claude Code assumes a Claude-sized (200k) context; models with smaller
    // windows hit "prompt is too long" before auto-compaction fires. Declare
    // the model's real window so compaction triggers at the right threshold.
    if (options?.contextLength && options.contextLength > 0) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(options.contextLength);
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
        Math.min(Math.max(Math.floor(options.contextLength * 0.8), 100_000), 1_000_000)
      );
    } else {
      delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }
    // Claude Code reserves its default 64k max_tokens on EVERY request, and
    // OpenRouter's pre-flight check rejects with 402 when
    // max_tokens × completion price exceeds the remaining balance — long
    // before any tokens are spent. Cap the reservation to the model's real
    // output limit (max 32k) so low balances behave like Copilot/Codex.
    if (options?.maxOutputTokens && options.maxOutputTokens > 0) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(options.maxOutputTokens, 32_000));
    } else {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000';
    }
    // Attribute this traffic to Maestro's app on the OpenRouter dashboard.
    // Claude Code parses the variable as newline-separated "Name: Value" pairs
    // and merges them into its request headers.
    env.ANTHROPIC_CUSTOM_HEADERS =
      `HTTP-Referer: ${OPENROUTER_APP_URL}\nX-OpenRouter-Title: ${OPENROUTER_APP_TITLE}`;

    settings.env = env;
    // A top-level "model" setting would shadow ANTHROPIC_MODEL — remove it
    // (the snapshot keeps the original value for restore()).
    delete settings.model;
    writeJsonFileAtomic(settingsPath, settings);
    Logger.info(`Claude Code wired to OpenRouter (${modelId}) via ${settingsPath}`);

    // The Claude Code VS Code extension validates credentials from its own
    // setting before launching the CLI, so mirror the gateway credential there.
    let detail = 'Restart any running Claude Code sessions to pick up the change.';
    try {
      await vscode.workspace.getConfiguration().update(
        'claudeCode.environmentVariables',
        [
          { name: 'ANTHROPIC_BASE_URL', value: OPENROUTER_ANTHROPIC_BASE_URL },
          { name: 'ANTHROPIC_AUTH_TOKEN', value: apiKey },
          { name: 'ANTHROPIC_API_KEY', value: '' },
        ],
        vscode.ConfigurationTarget.Global
      );
      // Without this, the extension shows its Anthropic login screen instead
      // of using the custom gateway credentials.
      await vscode.workspace.getConfiguration().update(
        'claudeCode.disableLoginPrompt',
        true,
        vscode.ConfigurationTarget.Global
      );
    } catch (err) {
      // Settings are only registered when the Claude Code extension is installed.
      Logger.warn('Could not update claudeCode.* settings (extension not installed?)', err);
      detail = 'Claude Code VS Code extension not detected — CLI sessions will use OpenRouter; install the extension for IDE support.';
    }

    return { target: this.target, installed: true, active: true, modelId, configPath: settingsPath, detail };
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async restore(): Promise<IntegrationStatus> {
    const snapshot = this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY);
    if (!snapshot) {
      // Maestro never applied anything (or already restored) — touching the
      // settings file here could delete the user's own ANTHROPIC_* keys.
      return this.getStatus();
    }
    const settingsPath = snapshot.settingsPath;

    let settings: ClaudeSettingsFile | undefined;
    try {
      settings = readJsonFile<ClaudeSettingsFile>(settingsPath);
    } catch (err) {
      throw new Error(
        `${settingsPath} contains invalid JSON — restore it manually from ${settingsPath}.maestro-backup`
      );
    }

    if (settings) {
      if (settings.env) {
        for (const key of MANAGED_ENV_KEYS) {
          const previous = snapshot.previousEnv?.[key];
          if (previous !== undefined) {
            settings.env[key] = previous;
          } else {
            delete settings.env[key];
          }
        }
        if (Object.keys(settings.env).length === 0) {
          delete settings.env;
        }
      }
      // Put back the top-level "model" key that apply() removed.
      if (snapshot.previousTopLevelModel !== undefined) {
        settings.model = snapshot.previousTopLevelModel;
      } else {
        delete settings.model;
      }
      writeJsonFileAtomic(settingsPath, settings);
      Logger.info(`Claude Code settings restored in ${settingsPath}`);
    }

    try {
      await vscode.workspace.getConfiguration().update(
        'claudeCode.environmentVariables',
        snapshot.previousVsCodeEnvVars,
        vscode.ConfigurationTarget.Global
      );
      await vscode.workspace.getConfiguration().update(
        'claudeCode.disableLoginPrompt',
        snapshot.previousDisableLoginPrompt,
        vscode.ConfigurationTarget.Global
      );
    } catch (err) {
      Logger.warn('Could not restore claudeCode.* settings', err);
    }

    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }
}
