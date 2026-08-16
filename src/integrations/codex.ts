import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { AgentApplyOptions, AgentIntegration } from './agentIntegration';
import { IntegrationStatus } from '../types/models';
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  backupOnce,
  expandHome,
  readJsonFile,
  readTextFile,
  sanitizeModelId,
  tomlEscape,
  writeTextFileAtomic,
} from './shared';
import { Logger } from '../utils/logger';
import { OPENROUTER_APP_TITLE, OPENROUTER_APP_URL } from '../utils/branding';

/** Env var Codex reads the OpenRouter key from (via env_key in config.toml). */
export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';

/** Provider id Maestro manages inside [model_providers.*]. */
const PROVIDER_ID = 'openrouter';

/** globalState key holding the pre-apply snapshot used by restore(). */
const SNAPSHOT_KEY = 'maestro-codex-snapshot';

interface CodexSnapshot {
  configPath: string;
  /** Previous top-level `model = ...` line (undefined = absent). */
  previousModelLine?: string;
  /** Previous top-level `model_provider = ...` line (undefined = absent). */
  previousProviderLine?: string;
  /** A pre-existing user-owned [model_providers.openrouter] section, if any. */
  previousProviderSection?: string;
  /** Previous top-level `show_raw_agent_reasoning = ...` line (undefined = absent). */
  previousShowRawReasoningLine?: string;
  /** Previous top-level `model_reasoning_effort = ...` line (undefined = absent). */
  previousReasoningEffortLine?: string;
  /** Previous top-level `model_reasoning_summary = ...` line (undefined = absent). */
  previousReasoningSummaryLine?: string;
  /** Previous top-level `model_supports_reasoning_summaries = ...` line (undefined = absent). */
  previousSupportsReasoningSummariesLine?: string;
  /**
   * Value the OPENROUTER_API_KEY user environment variable had before Maestro
   * first set it (null = it did not exist). Only recorded on Windows, where
   * apply() persists the variable.
   */
  previousUserEnvKey?: string | null;
}

/**
 * Top-level keys Maestro owns while active.
 *
 * `model_supports_reasoning_summaries` is still stripped/restored because
 * Maestro ≤0.3.0 wrote it, but it is no longer written: the key does not exist
 * in Codex 26.x (verified against the shipped binary — zero occurrences), which
 * moved model capabilities into `model_catalog_json`. See CODEX_REASONING_NOTE.
 */
const MANAGED_TOP_LEVEL_KEYS = [
  'model',
  'model_provider',
  'show_raw_agent_reasoning',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_supports_reasoning_summaries',
] as const;

/**
 * Why thinking steps stay hidden in Codex for most OpenRouter models.
 *
 * Measured on Codex 0.148 / IDE 26.810 against OpenRouter's Responses endpoint:
 * OpenRouter streams raw chain-of-thought as `response.reasoning_text.delta` /
 * `.done`, while Codex's stream handler only recognises the summary events
 * (`response.reasoning_summary_text.delta`, `response.reasoning_summary_part.added`).
 * The deltas are therefore dropped: `turn.completed` still reports
 * `reasoning_output_tokens > 0`, so the model does think and you are billed for
 * it — there is simply no event Codex will render. No config key changes this;
 * `model_catalog_json` was tested too and made no difference. Models whose
 * upstream provider emits real summaries (OpenAI's own) do display.
 */
export const CODEX_REASONING_NOTE =
  'Codex hides thinking for most OpenRouter models: OpenRouter streams raw reasoning ' +
  '(response.reasoning_text.*) but Codex only renders reasoning *summaries*. The model ' +
  'still reasons (and bills for it) — the steps just are not displayed. Nothing in the ' +
  'config can change this; it needs a fix in Codex.';

/**
 * OpenAI Codex integration.
 *
 * Manages the user-level ~/.codex/config.toml (shared by the Codex CLI and the
 * "Codex — OpenAI's coding agent" IDE extension):
 *  - a [model_providers.openrouter] section (base_url https://openrouter.ai/api/v1,
 *    wire_api "responses" — the only wire format Codex supports since Feb 2026)
 *  - top-level `model` / `model_provider` keys, which must live BEFORE any
 *    [section] header, and are only honored in the user-level config
 *  - the OPENROUTER_API_KEY user environment variable (persisted on Windows),
 *    because the GUI-launched extension does not inherit shell exports
 *
 * IMPORTANT: Codex itself rewrites config.toml with its own TOML serializer
 * (e.g. when trusting a project), which relocates comments. Management is
 * therefore SEMANTIC — sections and keys are located by name, never by
 * comment markers.
 */
export class CodexIntegration implements AgentIntegration {
  readonly target = 'codex' as const;

  constructor(private readonly globalState: vscode.Memento) {}

  // ── Paths ──────────────────────────────────────────────────────────────────

  private get codexDir(): string {
    return path.join(os.homedir(), '.codex');
  }

  private getConfigPath(): string {
    const custom = vscode.workspace
      .getConfiguration('openrouterMaestro')
      .get<string>('codex.configPath', '')
      .trim();
    if (custom) { return expandHome(custom); }
    return path.join(this.codexDir, 'config.toml');
  }

  // ── TOML top-level key helpers ─────────────────────────────────────────────

  /**
   * Scan the top-level region of a TOML file (everything before the first
   * [section] header). Tracks triple-quoted multi-line strings so a line that
   * merely *looks* like a section header or key assignment inside a string is
   * not misinterpreted. Top-level keys are only valid in this region.
   */
  private scanTopLevel(content: string): {
    lines: { text: string; inString: boolean }[];
    /** Offset where the first real [section] header starts (content.length if none). */
    restStart: number;
  } {
    const rawLines = content.split('\n');
    const lines: { text: string; inString: boolean }[] = [];
    let inTriple: '"""' | "'''" | null = null;
    let offset = 0;

    for (const line of rawLines) {
      const startedInString = inTriple !== null;
      if (inTriple) {
        if (line.includes(inTriple)) { inTriple = null; }
      } else {
        // A section header only counts outside multi-line strings and must be
        // a full `[table.name]` line (a bracket-opening array line won't match).
        if (/^\s*\[[^\[\]]*\]\s*(#.*)?$/.test(line)) {
          return { lines, restStart: offset };
        }
        for (const q of ['"""', "'''"] as const) {
          const first = line.indexOf(q);
          if (first !== -1 && line.indexOf(q, first + q.length) === -1) {
            inTriple = q;
            break;
          }
        }
      }
      lines.push({ text: line, inString: startedInString || inTriple !== null });
      offset += line.length + 1;
    }
    return { lines, restStart: content.length };
  }

  /** Find a top-level `key = ...` assignment line (ignoring string content). */
  private findTopLevelLine(content: string, key: string): string | undefined {
    const { lines } = this.scanTopLevel(content);
    const re = new RegExp(`^\\s*${key}\\s*=`);
    return lines.find((l) => !l.inString && re.test(l.text))?.text;
  }

  /** Remove all Maestro-managed top-level assignments (ignoring string content). */
  private stripTopLevelSelection(content: string): string {
    const { lines, restStart } = this.scanTopLevel(content);
    const re = new RegExp(`^\\s*(${MANAGED_TOP_LEVEL_KEYS.join('|')})\\s*=`);
    const kept = lines
      .filter((l) => l.inString || !re.test(l.text))
      .map((l) => l.text);
    const rest = content.slice(restStart);
    const top = kept.join('\n');
    if (rest === '') { return top; }
    return top === '' ? rest : `${top}\n${rest}`;
  }

  // ── Provider section helpers ───────────────────────────────────────────────

  /**
   * Remove leftover Maestro marker comment lines written by older versions.
   * Codex's own config rewriter relocates comments, so markers can no longer
   * be trusted to delimit anything — they are stripped wherever they appear.
   */
  private stripMarkerLines(content: string): string {
    return content
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return t !== MANAGED_BLOCK_BEGIN && t !== MANAGED_BLOCK_END;
      })
      .join('\n');
  }

  /**
   * Locate the [model_providers.openrouter] section: from its header line to
   * the next header that is not a subtable of it (or EOF).
   */
  private findProviderSection(content: string): { start: number; end: number } | undefined {
    const lines = content.split('\n');
    let offset = 0;
    let start = -1;
    let end = content.length;

    for (const line of lines) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/)?.[1]?.trim();
      if (start === -1) {
        if (
          header === `model_providers.${PROVIDER_ID}` ||
          header === `model_providers."${PROVIDER_ID}"`
        ) {
          start = offset;
        }
      } else if (header !== undefined && !header.startsWith(`model_providers.${PROVIDER_ID}.`)) {
        end = offset;
        break;
      }
      offset += line.length + 1;
    }

    if (start === -1) { return undefined; }
    return { start, end: Math.min(end, content.length) };
  }

  /** Remove the [model_providers.openrouter] section, splicing cleanly. */
  private removeProviderSection(content: string): string {
    const range = this.findProviderSection(content);
    if (!range) { return content; }
    let before = content.slice(0, range.start).replace(/\n+$/, '\n');
    if (before === '\n') { before = ''; }
    let after = content.slice(range.end).replace(/^\n+/, '');
    if (after !== '') { after = (before === '' ? '' : '\n') + after; }
    return before + after;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(): Promise<IntegrationStatus> {
    const configPath = this.getConfigPath();
    const installed = fs.existsSync(this.codexDir);
    const content = readTextFile(configPath);

    let active = false;
    let modelId: string | undefined;
    let detail: string | undefined;

    if (content !== undefined) {
      const providerLine = this.findTopLevelLine(content, 'model_provider');
      active =
        this.findProviderSection(content) !== undefined &&
        !!providerLine?.includes(`"${PROVIDER_ID}"`);
      if (active) {
        const modelLine = this.findTopLevelLine(content, 'model');
        modelId = modelLine?.match(/=\s*"([^"]+)"/)?.[1];
        detail = 'Note: Codex\'s own model picker labels custom models as "Custom" — requests still use the model shown here.';
        if (process.platform === 'win32' && !process.env[OPENROUTER_ENV_KEY]) {
          detail += ` If Codex reports a missing ${OPENROUTER_ENV_KEY}, restart VS Code/terminal.`;
        }
      }
    }

    // Common trap: pasting an OpenRouter key into Codex's own "Use API Key"
    // dialog stores it as an OpenAI key — Codex then sends it to
    // api.openai.com and gets 401 invalid_api_key.
    if (!active && installed) {
      try {
        const auth = readJsonFile<{ OPENAI_API_KEY?: string }>(path.join(this.codexDir, 'auth.json'));
        if (auth?.OPENAI_API_KEY?.startsWith('sk-or-')) {
          detail = '⚠️ An OpenRouter key is saved as Codex\'s OpenAI API key, so Codex sends it to api.openai.com and gets 401. Apply a model here instead, then restart VS Code.';
        }
      } catch {
        // Unreadable auth.json is irrelevant to status reporting.
      }
    }

    return { target: this.target, installed, active, modelId, configPath, detail };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  async apply(modelId: string, apiKey: string, options?: AgentApplyOptions): Promise<IntegrationStatus> {
    modelId = sanitizeModelId(modelId);
    const configPath = this.getConfigPath();

    // If a previous apply targeted a different config file (the configPath
    // setting changed), un-wire that file first.
    const existingSnapshot = this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY);
    if (existingSnapshot && existingSnapshot.configPath !== configPath) {
      await this.restore();
    }

    backupOnce(configPath);

    const existing = readTextFile(configPath);

    // Snapshot the pre-Maestro state once (first apply wins). If the user had
    // their own [model_providers.openrouter] section, keep its text so
    // restore() can put it back verbatim.
    if (!this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY)) {
      const priorSection = existing ? this.findProviderSection(existing) : undefined;
      const snapshot: CodexSnapshot = {
        configPath,
        previousModelLine: existing ? this.findTopLevelLine(existing, 'model') : undefined,
        previousProviderLine: existing ? this.findTopLevelLine(existing, 'model_provider') : undefined,
        previousProviderSection:
          existing && priorSection ? existing.slice(priorSection.start, priorSection.end) : undefined,
        previousShowRawReasoningLine: existing
          ? this.findTopLevelLine(existing, 'show_raw_agent_reasoning')
          : undefined,
        previousReasoningEffortLine: existing
          ? this.findTopLevelLine(existing, 'model_reasoning_effort')
          : undefined,
        previousReasoningSummaryLine: existing
          ? this.findTopLevelLine(existing, 'model_reasoning_summary')
          : undefined,
        previousSupportsReasoningSummariesLine: existing
          ? this.findTopLevelLine(existing, 'model_supports_reasoning_summaries')
          : undefined,
        previousUserEnvKey:
          process.platform === 'win32' ? await this.readUserEnv(OPENROUTER_ENV_KEY) : undefined,
      };
      await this.globalState.update(SNAPSHOT_KEY, snapshot);
    }

    // 1) Clean up: legacy marker comments, any existing openrouter provider
    //    section, and the current top-level model selection.
    let content = this.stripMarkerLines(existing ?? '');
    content = this.removeProviderSection(content);
    content = this.stripTopLevelSelection(content);

    // 2) Append a fresh provider section at the end of the file. The
    //    http_headers subtable makes Codex's traffic show up under Maestro's
    //    app on the OpenRouter dashboard instead of as unattributed usage;
    //    it belongs to the provider section, so restore() removes it with the
    //    rest (findProviderSection covers `model_providers.openrouter.*`).
    const section = [
      `[model_providers.${PROVIDER_ID}]`,
      `name = "OpenRouter"`,
      `base_url = "https://openrouter.ai/api/v1"`,
      `env_key = "${OPENROUTER_ENV_KEY}"`,
      `wire_api = "responses"`,
      ``,
      `[model_providers.${PROVIDER_ID}.http_headers]`,
      `"HTTP-Referer" = "${tomlEscape(OPENROUTER_APP_URL)}"`,
      `"X-OpenRouter-Title" = "${tomlEscape(OPENROUTER_APP_TITLE)}"`,
    ].join('\n');
    content = content.trim() === '' ? `${section}\n` : `${content.replace(/\n*$/, '\n')}\n${section}\n`;

    // 3) Top-level model selection must come BEFORE any [section] header.
    //    show_raw_agent_reasoning makes raw chain-of-thought visible where
    //    Codex has something to show; model_reasoning_effort asks the model to
    //    think — valid values are minimal|low|medium|high|xhigh (never "max");
    //    model_reasoning_summary must not be "none" or summaries are dropped.
    //    These are written for reasoning models even though Codex currently
    //    cannot render OpenRouter's raw reasoning stream (CODEX_REASONING_NOTE):
    //    they cost nothing, and they are what displays thinking as soon as the
    //    provider emits summary events (OpenAI models already do).
    const reasoningLines = options?.supportsReasoning === false
      ? ''
      : 'show_raw_agent_reasoning = true\n' +
        'model_reasoning_effort = "high"\n' +
        'model_reasoning_summary = "auto"\n';
    content =
      `model = "${tomlEscape(modelId)}"\n` +
      `model_provider = "${PROVIDER_ID}"\n` +
      reasoningLines +
      (content.startsWith('\n') ? '' : '\n') +
      content;

    writeTextFileAtomic(configPath, content);
    Logger.info(`Codex wired to OpenRouter (${modelId}) via ${configPath}`);

    // 4) Make the API key available as a persistent user env var so both the
    //    CLI and the GUI-launched IDE extension can resolve env_key.
    let detail: string;
    if (process.platform === 'win32') {
      await this.persistUserEnv(OPENROUTER_ENV_KEY, apiKey);
      detail = `Restart VS Code once so Codex sees ${OPENROUTER_ENV_KEY}. Codex's own picker will label this model "Custom" — that's a Codex UI limitation.`;
    } else {
      detail = `Add to your shell profile: export ${OPENROUTER_ENV_KEY}="<your-key>" (Codex resolves the key from that variable).`;
    }

    return { target: this.target, installed: true, active: true, modelId, configPath, detail };
  }

  /**
   * Persist a user-level environment variable on Windows.
   * Uses PowerShell's SetEnvironmentVariable instead of setx (which silently
   * fails in some shells and truncates values over 1024 chars).
   */
  private persistUserEnv(name: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const psValue = value.replace(/'/g, "''");
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Environment]::SetEnvironmentVariable('${name}', '${psValue}', 'User')`,
        ],
        { windowsHide: true },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to persist ${name}: ${stderr || err.message}`));
          } else {
            // Also expose it to processes spawned from this extension host session.
            process.env[name] = value;
            resolve();
          }
        }
      );
    });
  }

  /** Read a user-scope environment variable (null when it does not exist). */
  private readUserEnv(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
        ],
        { windowsHide: true },
        (err, stdout) => {
          if (err) {
            Logger.warn(`Could not read user env ${name}; assuming it was unset`);
            resolve(null);
            return;
          }
          const value = stdout.trim();
          resolve(value === '' ? null : value);
        }
      );
    });
  }

  /**
   * Put the OPENROUTER_API_KEY user variable back the way it was before the
   * first apply — deleted if Maestro created it. Leaving a live API key in the
   * user environment after a restore would be a credential leak.
   */
  private async restoreUserEnv(previous: string | null | undefined): Promise<void> {
    if (process.platform !== 'win32' || previous === undefined) { return; }

    try {
      if (previous === null) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `[Environment]::SetEnvironmentVariable('${OPENROUTER_ENV_KEY}', $null, 'User')`,
            ],
            { windowsHide: true },
            (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
          );
        });
        delete process.env[OPENROUTER_ENV_KEY];
        Logger.info(`Removed the ${OPENROUTER_ENV_KEY} user environment variable`);
      } else {
        await this.persistUserEnv(OPENROUTER_ENV_KEY, previous);
      }
    } catch (error) {
      // A leftover variable is not worth failing the restore over — the config
      // file is what actually routes Codex, and it has already been cleaned.
      Logger.warn(`Failed to restore the ${OPENROUTER_ENV_KEY} user variable`, error);
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async restore(): Promise<IntegrationStatus> {
    const snapshot = this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY);
    const configPath = snapshot?.configPath ?? this.getConfigPath();
    const existing = readTextFile(configPath);

    // Without a snapshot AND without our provider section, any top-level
    // model/model_provider lines belong to the user — leave the file alone.
    if (!snapshot && (existing === undefined || this.findProviderSection(existing) === undefined)) {
      return this.getStatus();
    }

    if (existing !== undefined) {
      let content = this.stripMarkerLines(existing);
      content = this.removeProviderSection(content);
      content = this.stripTopLevelSelection(content);

      // Put back the user's own pre-Maestro openrouter provider section, if any.
      if (snapshot?.previousProviderSection) {
        content = `${content.replace(/\n*$/, '\n')}\n${snapshot.previousProviderSection.replace(/\n*$/, '\n')}`;
      }

      // Put back whatever top-level selection existed before Maestro.
      const restoredLines = [
        snapshot?.previousModelLine,
        snapshot?.previousProviderLine,
        snapshot?.previousShowRawReasoningLine,
        snapshot?.previousReasoningEffortLine,
        snapshot?.previousReasoningSummaryLine,
        snapshot?.previousSupportsReasoningSummariesLine,
      ].filter((l): l is string => l !== undefined);
      if (restoredLines.length > 0) {
        content = restoredLines.join('\n') + '\n' + (content.startsWith('\n') ? content.slice(1) : content);
      }

      writeTextFileAtomic(configPath, content);
      Logger.info(`Codex config restored in ${configPath}`);
    }

    await this.restoreUserEnv(snapshot?.previousUserEnvKey);
    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }
}
