import * as vscode from 'vscode';
import { OpenRouterClient } from './api/openRouterClient';
import { ModelCache } from './cache/modelCache';
import { ModelBrowserProvider } from './views/webviewProvider';
import { OpenRouterChatProvider } from './provider/openRouterProvider';
import { SecretsManager } from './utils/secrets';
import { Logger } from './utils/logger';
import { AgentIntegration } from './integrations/agentIntegration';
import { ClaudeCodeIntegration } from './integrations/claudeCode';
import { CodexIntegration } from './integrations/codex';
import { AgentTarget } from './types/models';
import { FETCH_TOOL_NAME, FetchWebPageTool } from './tools/fetchWebPageTool';
import { CODEBASE_TOOL_NAME, CodebaseSearchTool } from './tools/codebaseSearchTool';
import { CodebaseIndex } from './codebase/codebaseIndex';
import { OpenRouterInlineCompletionProvider } from './inline/inlineCompletionProvider';
import { chooseUtilityModel, offerUtilityModel } from './features/utilityModels';
import { PROVIDER_VENDOR_ID } from './utils/utilityModel';

/** Flip a boolean setting globally and say what it does now. */
async function toggleSetting(key: string, on: string, off: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('openrouterMaestro');
  const next = !config.get<boolean>(key, false);
  await config.update(key, next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(next ? on : off);
}

/**
 * Ensure `chat.byokUtilityModelDefault` is configured so Copilot can perform
 * utility tasks with the selected OpenRouter (BYOK) model. Only sets the value
 * when the user has not explicitly configured it, to respect user choice.
 */
async function ensureByokUtilityDefault(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration();
    const inspected = config.inspect<string>('chat.byokUtilityModelDefault');
    const alreadySet =
      inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.workspaceFolderValue !== undefined;

    if (!alreadySet) {
      await config.update(
        'chat.byokUtilityModelDefault',
        'mainAgent',
        vscode.ConfigurationTarget.Global
      );
      Logger.info("Set 'chat.byokUtilityModelDefault' to 'mainAgent'");
    }
  } catch (error) {
    Logger.warn('Failed to set chat.byokUtilityModelDefault', error);
  }
}

/** Quick-pick an OpenRouter model from the cache (tool-calling models first). */
async function pickModel(cache: ModelCache, placeholder: string): Promise<string | undefined> {
  const models = cache.getModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      'No OpenRouter models cached yet. Run "OpenRouter Maestro: Sync Models from API" first.'
    );
    return undefined;
  }

  const sorted = [...models].sort((a, b) => {
    if (a.capabilities.toolCalling !== b.capabilities.toolCalling) {
      return a.capabilities.toolCalling ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const picked = await vscode.window.showQuickPick(
    sorted.map((m) => ({
      label: m.name,
      description: m.id,
      detail: `${m.isFree ? 'Free' : `$${m.pricing.promptPerMillion.toFixed(2)}/M in · $${m.pricing.completionPerMillion.toFixed(2)}/M out`} · ${Math.round(m.contextLength / 1000)}K context${m.capabilities.toolCalling ? ' · 🔧 tools' : ''}`,
    })),
    { placeHolder: placeholder, matchOnDescription: true }
  );
  return picked?.description;
}

/** Apply a model to an external agent via command palette (prompts for key if needed). */
async function applyToAgentCommand(
  integration: AgentIntegration,
  cache: ModelCache,
  secrets: SecretsManager,
  agentLabel: string,
): Promise<void> {
  const modelId = await pickModel(cache, `Select the OpenRouter model to use in ${agentLabel}`);
  if (!modelId) { return; }

  let apiKey = await secrets.getApiKey();
  if (!apiKey) {
    const didSet = await secrets.promptForApiKey();
    if (didSet) { apiKey = await secrets.getApiKey(); }
  }
  if (!apiKey) { return; }

  try {
    const status = await integration.apply(modelId, apiKey);
    vscode.window.showInformationMessage(
      `✅ ${agentLabel} now uses ${modelId} via OpenRouter. ${status.detail || ''}`.trim()
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to configure ${agentLabel}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/** Restore an external agent's default provider via command palette. */
async function restoreAgentCommand(integration: AgentIntegration, agentLabel: string): Promise<void> {
  try {
    await integration.restore();
    vscode.window.showInformationMessage(`✅ ${agentLabel} restored to its default provider.`);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to restore ${agentLabel}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Extension activation point.
 * Registers the native Copilot Chat provider, the Claude Code / Codex
 * integrations, and the Model Browser webview.
 */
export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('OpenRouter Maestro activating...');

  // Ensure Copilot can use the BYOK (OpenRouter) model itself for utility tasks,
  // otherwise Copilot throws "No utility model is configured for 'copilot-utility-small'".
  ensureByokUtilityDefault();

  // Initialize services
  const secrets = new SecretsManager(context.secrets);
  const apiClient = new OpenRouterClient();
  const cache = new ModelCache(context.globalState);

  // External agent integrations
  const claudeCode = new ClaudeCodeIntegration(context.globalState);
  const codex = new CodexIntegration(context.globalState);
  const integrations: AgentIntegration[] = [claudeCode, codex];

  // Create native VS Code LanguageModelChatProvider for OpenRouter
  const openRouterProvider = new OpenRouterChatProvider(
    cache,
    secrets,
    context.globalState
  );

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR_ID, openRouterProvider)
  );

  // Copilot's fetch_webpage needs an active Copilot subscription; this one does not.
  context.subscriptions.push(
    vscode.lm.registerTool(FETCH_TOOL_NAME, new FetchWebPageTool())
  );

  // Semantic code search: Copilot's #codebase is not offered to BYOK models.
  const codebaseIndex = new CodebaseIndex(context.storageUri, () => secrets.getApiKey());
  context.subscriptions.push(
    vscode.lm.registerTool(CODEBASE_TOOL_NAME, new CodebaseSearchTool(codebaseIndex))
  );

  // Inline completions: Copilot's need a Copilot subscription. Off by default.
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new OpenRouterInlineCompletionProvider(() => secrets.getApiKey(), cache)
    )
  );

  // The provider offers the utility model to Copilot, so changes must reach it.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openrouterMaestro.utilityModel')) {
        openRouterProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterMaestro.chooseUtilityModel', () =>
      chooseUtilityModel(cache, context.globalState)
    ),
    vscode.commands.registerCommand('openrouterMaestro.toggleWebSearch', () =>
      toggleSetting(
        'webSearch.enabled',
        'Maestro web search is on: models that call tools can search the web while answering (about $0.007 per search with the default engine, Exa).',
        'Maestro web search is off.'
      )
    ),
    vscode.commands.registerCommand('openrouterMaestro.toggleInlineCompletions', () =>
      toggleSetting(
        'inlineCompletions.enabled',
        'Maestro inline completions are on. Each suggestion is a paid request; pick the model with openrouterMaestro.inlineCompletions.model.',
        'Maestro inline completions are off.'
      )
    ),
    vscode.commands.registerCommand('openrouterMaestro.rebuildCodebaseIndex', async () => {
      try {
        await codebaseIndex.clear();
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'OpenRouter Maestro: indexing the workspace', cancellable: true },
          (progress, token) => {
            let last = 0;
            return codebaseIndex.update(token, (done, total) => {
              const percent = total ? Math.round((done / total) * 100) : 100;
              progress.report({ increment: percent - last, message: `${done} / ${total} chunks` });
              last = percent;
            }, true);
          }
        );
        vscode.window.showInformationMessage(
          `Indexed ${result.embeddedFiles} files for semantic search ($${result.cost.toFixed(4)}).`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('openrouterMaestro.clearCodebaseIndex', async () => {
      await codebaseIndex.clear();
      vscode.window.showInformationMessage('Deleted the semantic search index of this workspace.');
    })
  );

  // Create status bar item for token usage stats
  const usageStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  usageStatusBar.name = 'OpenRouter Token Usage';
  usageStatusBar.tooltip = 'Token usage from last OpenRouter request';
  context.subscriptions.push(usageStatusBar);
  openRouterProvider.setUsageStatusBar(usageStatusBar);

  // Create the webview provider (passes openRouterProvider so UI updates refresh provider)
  const browserProvider = new ModelBrowserProvider(
    context.extensionUri,
    apiClient,
    cache,
    secrets,
    context.globalState,
    openRouterProvider,
    integrations
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ModelBrowserProvider.viewType,
      browserProvider
    )
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterMaestro.openBrowser', () => {
      browserProvider.openAsPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterMaestro.setApiKey', async () => {
      const result = await secrets.promptForApiKey();
      if (result) {
        const key = await secrets.getApiKey();
        if (key) {
          apiClient.setApiKey(key);
        }
        openRouterProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterMaestro.syncModels', async () => {
      try {
        const hasKey = await secrets.hasApiKey();
        if (hasKey) {
          const key = await secrets.getApiKey();
          apiClient.setApiKey(key!);
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Syncing OpenRouter models...',
            cancellable: false,
          },
          async () => {
            const models = await apiClient.fetchModels();
            await cache.saveModels(models);
            openRouterProvider.refresh();
            vscode.window.showInformationMessage(
              `✅ Synced ${models.length} models from OpenRouter`
            );
          }
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouterMaestro.claudeCode.apply', () =>
      applyToAgentCommand(claudeCode, cache, secrets, 'Claude Code')
    ),
    vscode.commands.registerCommand('openrouterMaestro.claudeCode.restore', () =>
      restoreAgentCommand(claudeCode, 'Claude Code')
    ),
    vscode.commands.registerCommand('openrouterMaestro.codex.apply', () =>
      applyToAgentCommand(codex, cache, secrets, 'Codex')
    ),
    vscode.commands.registerCommand('openrouterMaestro.codex.restore', () =>
      restoreAgentCommand(codex, 'Codex')
    ),
    vscode.commands.registerCommand('openrouterMaestro.showStatus', async () => {
      const lines: string[] = [];
      for (const integration of integrations) {
        const label: Record<AgentTarget, string> = {
          'copilot': 'Copilot',
          'claude-code': 'Claude Code',
          'codex': 'Codex',
        };
        try {
          const s = await integration.getStatus();
          const state = !s.installed
            ? 'not detected'
            : s.active
              ? `using OpenRouter (${s.modelId || 'model unknown'})`
              : 'installed, using its own defaults';
          lines.push(`${label[integration.target]}: ${state}`);
        } catch (e) {
          lines.push(`${label[integration.target]}: status check failed`);
        }
      }
      vscode.window.showInformationMessage(`OpenRouter Maestro — ${lines.join(' · ')}`);
    })
  );

  // Load cache on startup (silent, no network)
  cache.loadFromDisk().then(async (models) => {
    if (models.length > 0) {
      Logger.info(`Loaded ${models.length} cached models on startup`);
      openRouterProvider.refresh();
      await offerUtilityModel(cache, context.globalState, await secrets.hasApiKey());
    }
  });

  Logger.info('OpenRouter Maestro activated ✅');
}

export function deactivate() {
  Logger.info('OpenRouter Maestro deactivating...');
  Logger.dispose();
}
