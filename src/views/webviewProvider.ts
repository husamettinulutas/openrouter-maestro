import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenRouterClient } from '../api/openRouterClient';
import { OpenRouterChatProvider } from '../provider/openRouterProvider';
import { ModelCache } from '../cache/modelCache';
import { SecretsManager } from '../utils/secrets';
import { Logger } from '../utils/logger';
import {
  WebviewMessage,
  ExtensionMessage,
  SelectedModel,
  ProcessedModel,
  ModelFilters,
  ExtensionState,
  ExternalAgentTarget,
  AgentModelEntry,
  AgentRoster,
  IntegrationStatus,
} from '../types/models';
import { AgentIntegration } from '../integrations/agentIntegration';

const SELECTED_MODELS_KEY = 'openrouter-selected-models';

/** globalState key holding the saved model list of each external agent. */
const AGENT_ROSTERS_KEY = 'maestro-agent-rosters';

/** Agents that keep a saved model list of their own (Copilot uses SELECTED_MODELS_KEY). */
const EXTERNAL_AGENTS: ExternalAgentTarget[] = ['claude-code', 'codex'];

/** Human-readable agent names for user-facing messages. */
const AGENT_LABELS: Record<ExternalAgentTarget, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
};

/**
 * Provides the Webview-based Model Browser panel.
 * Manages communication between the Webview UI and the extension host.
 */
export class ModelBrowserProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openrouter-maestro-browse';

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly apiClient: OpenRouterClient,
    private readonly cache: ModelCache,
    private readonly secrets: SecretsManager,
    private readonly globalState: vscode.Memento,
    private readonly chatProvider?: OpenRouterChatProvider,
    private readonly integrations: AgentIntegration[] = [],
  ) { }

  /**
   * Called when the webview view is resolved (sidebar).
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    webviewView.webview.html = this.getWebviewContent(webviewView.webview);
    this.setupMessageHandler(webviewView.webview);
  }

  /**
   * Open the Model Browser as a full editor panel.
   */
  openAsPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'openrouter-maestro-browser',
      'OpenRouter Maestro',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'webview'),
          vscode.Uri.joinPath(this.extensionUri, 'resources'),
        ],
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon('sparkle');
    this.panel.webview.html = this.getWebviewContent(this.panel.webview);
    this.setupMessageHandler(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  /**
   * Set up the message handler for webview ↔ extension communication.
   */
  private setupMessageHandler(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.type) {
          case 'ready':
            await this.handleReady(webview);
            break;
          case 'requestModels':
            await this.handleRequestModels(webview, message.filters);
            break;
          case 'addModel':
            await this.handleAddModel(webview, message.modelId);
            break;
          case 'removeModel':
            await this.handleRemoveModel(webview, message.modelId);
            break;
          case 'removeActiveModel':
            await this.handleRemoveActiveModel(webview, message.modelId);
            break;
          case 'clearDraftModels':
            await this.saveSelectedModels([]);
            await this.sendSelectedModels(webview);
            break;
          case 'toggleModel':
            await this.handleToggleModel(webview, message.modelId, message.enabled);
            break;
          case 'applyToCopilot':
            await this.handleApplyToCopilot(webview);
            break;
          case 'toggleCopilot':
            await this.handleToggleCopilot(webview, message.modelId);
            break;
          case 'addToAgent':
            await this.handleAddToAgent(webview, message.target, message.modelId);
            break;
          case 'removeFromAgent':
            await this.handleRemoveFromAgent(webview, message.target, message.modelId);
            break;
          case 'activateAgentModel':
            await this.handleActivateAgentModel(webview, message.target, message.modelId);
            break;
          case 'deactivateAgent':
          case 'restoreIntegration':
            await this.handleRestoreIntegration(webview, message.target);
            break;
          case 'getAgentRosters':
            await this.sendAgentRosters(webview);
            break;
          case 'reloadWindow':
            // Claude Code and Codex read their config when they start. A
            // running session keeps whatever it loaded, so switching models —
            // or back to the agent's own model — only takes effect after the
            // agent restarts; reloading the window is the reliable way there.
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
            break;
          case 'getIntegrationStatus':
            await this.sendIntegrationStatus(webview);
            break;
          case 'setApiKey':
            await this.handleSetApiKey(webview);
            break;
          case 'syncModels':
            await this.handleSyncModels(webview);
            break;
          case 'getSelectedModels':
            await this.sendSelectedModels(webview);
            await this.sendActiveModels(webview);
            break;
          case 'getApiKeyStatus':
            await this.sendApiKeyStatus(webview);
            break;
        }
      } catch (error) {
        Logger.error('Webview message handler error', error);
        this.postMessage(webview, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        });
      }
    });
  }

  /**
   * Handle 'ready' — webview has loaded, send initial data.
   */
  private async handleReady(webview: vscode.Webview): Promise<void> {
    await this.sendApiKeyStatus(webview);

    // Load from cache first for instant display
    if (this.cache.hasModels()) {
      const models = this.cache.getModels();
      this.postMessage(webview, {
        type: 'modelsLoaded',
        models,
        total: models.length,
      });
    }

    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
    await this.sendAgentRosters(webview);
    await this.sendIntegrationStatus(webview);

    if (this.cache.isStale()) {
      await this.handleSyncModels(webview);
    }
  }

  /**
   * One-click toggle of a model in Copilot Chat: adds it enabled, or removes
   * it entirely. Replaces the old draft + "Apply to Copilot" two-step flow.
   */
  private async handleToggleCopilot(webview: vscode.Webview, modelId: string): Promise<void> {
    const selected = this.getSelectedModels();
    const existing = selected.find((m) => m.id === modelId);
    const model = this.cache.getModel(modelId);
    const name = model?.name || existing?.name || modelId;

    let enabled: boolean;
    if (existing?.enabled) {
      await this.saveSelectedModels(selected.filter((m) => m.id !== modelId));
      enabled = false;
    } else {
      // Adding a model: make sure requests can actually authenticate.
      const hasKey = await this.secrets.hasApiKey();
      if (!hasKey) {
        const didSet = await this.secrets.promptForApiKey();
        if (!didSet) {
          this.postMessage(webview, {
            type: 'copilotToggled',
            modelId,
            enabled: false,
            message: 'OpenRouter API key is required to use models in Copilot.',
          });
          return;
        }
      }
      if (existing) {
        existing.enabled = true;
      } else {
        selected.push({ id: modelId, name, addedAt: Date.now(), enabled: true });
      }
      await this.saveSelectedModels(selected);
      enabled = true;
    }

    this.chatProvider?.refresh();
    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
    this.postMessage(webview, {
      type: 'copilotToggled',
      modelId,
      enabled,
      message: enabled
        ? `✅ ${name} is now available in Copilot Chat`
        : `${name} removed from Copilot Chat`,
    });
  }

  // ── Agent model lists (Claude Code / Codex) ────────────────────────────────

  /** Read one agent's saved model list. */
  private getAgentRoster(target: ExternalAgentTarget): AgentModelEntry[] {
    const all =
      this.globalState.get<Partial<Record<ExternalAgentTarget, AgentModelEntry[]>>>(
        AGENT_ROSTERS_KEY
      ) || {};
    return [...(all[target] || [])];
  }

  private async saveAgentRoster(
    target: ExternalAgentTarget,
    entries: AgentModelEntry[]
  ): Promise<void> {
    const all =
      this.globalState.get<Partial<Record<ExternalAgentTarget, AgentModelEntry[]>>>(
        AGENT_ROSTERS_KEY
      ) || {};
    await this.globalState.update(AGENT_ROSTERS_KEY, { ...all, [target]: entries });
  }

  /**
   * Put a model in an agent's list. Membership alone writes nothing to the
   * agent's config — only activation does.
   */
  private async addToRoster(target: ExternalAgentTarget, modelId: string): Promise<boolean> {
    const roster = this.getAgentRoster(target);
    if (roster.some((m) => m.id === modelId)) { return false; }

    const meta = this.cache.getModel(modelId);
    roster.push({ id: modelId, name: meta?.name || modelId, addedAt: Date.now() });
    await this.saveAgentRoster(target, roster);
    return true;
  }

  /** Push every agent's saved model list to the webview. */
  private async sendAgentRosters(webview: vscode.Webview): Promise<void> {
    const rosters: AgentRoster[] = EXTERNAL_AGENTS.map((target) => ({
      target,
      models: this.getAgentRoster(target),
    }));
    this.postMessage(webview, { type: 'agentRostersUpdated', rosters });
  }

  /**
   * Add a model to an agent's list. If that agent is still running on its own
   * provider, the model is activated too, so a single click keeps working;
   * once something is active, further additions only join the list.
   */
  private async handleAddToAgent(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
    modelId: string,
  ): Promise<void> {
    const isNew = await this.addToRoster(target, modelId);
    await this.sendAgentRosters(webview);

    const label = AGENT_LABELS[target];
    const name = this.cache.getModel(modelId)?.name || modelId;
    const integration = this.integrations.find((i) => i.target === target);

    let status: IntegrationStatus | undefined;
    if (integration) {
      try {
        status = await integration.getStatus();
      } catch (error) {
        Logger.warn(`Failed to read ${target} status before add`, error);
      }
    }

    if (integration && status?.installed && !status.active) {
      await this.handleActivateAgentModel(webview, target, modelId);
      return;
    }

    this.postMessage(webview, {
      type: 'integrationApplied',
      target,
      success: true,
      message: isNew
        ? `${name} added to the ${label} list — activate it in the ${label} tab.`
        : `${name} is already in the ${label} list.`,
    });
  }

  /**
   * Drop a model from an agent's list. If it happens to be the active one, the
   * agent is put back on its own provider first.
   */
  private async handleRemoveFromAgent(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
    modelId: string,
  ): Promise<void> {
    const integration = this.integrations.find((i) => i.target === target);
    let wasActive = false;

    if (integration) {
      try {
        const status = await integration.getStatus();
        wasActive = !!status.active && status.modelId === modelId;
      } catch (error) {
        Logger.warn(`Failed to read ${target} status before remove`, error);
      }
    }

    if (wasActive) {
      await this.handleRestoreIntegration(webview, target);
    }

    await this.saveAgentRoster(target, this.getAgentRoster(target).filter((m) => m.id !== modelId));
    await this.sendAgentRosters(webview);

    if (!wasActive) {
      const name = this.cache.getModel(modelId)?.name || modelId;
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: true,
        message: `${name} removed from the ${AGENT_LABELS[target]} list.`,
      });
    }
  }

  /**
   * Make one of the listed models the agent's active model.
   * Prompts for the API key first if none is stored.
   */
  private async handleActivateAgentModel(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
    modelId: string,
  ): Promise<void> {
    const integration = this.integrations.find((i) => i.target === target);
    if (!integration) {
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: false,
        message: `No integration registered for ${target}.`,
      });
      return;
    }

    let apiKey = await this.secrets.getApiKey();
    if (!apiKey) {
      const didSet = await this.secrets.promptForApiKey();
      if (didSet) { apiKey = await this.secrets.getApiKey(); }
    }
    if (!apiKey) {
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: false,
        message: 'OpenRouter API key is required to wire a model into an agent.',
      });
      return;
    }

    try {
      const meta = this.cache.getModel(modelId);
      const status = await integration.apply(modelId, apiKey, {
        contextLength: meta?.contextLength,
        maxOutputTokens: meta?.maxOutputTokens,
        supportsReasoning: meta?.capabilities?.reasoning,
      });
      await this.addToRoster(target, modelId);
      await this.sendAgentRosters(webview);
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: true,
        message: `${modelId} is now active in ${AGENT_LABELS[target]}. ${status.detail || ''}`.trim(),
      });
    } catch (error) {
      Logger.error(`Failed to apply model to ${target}`, error);
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: false,
        message: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }

    await this.sendIntegrationStatus(webview);
  }

  /**
   * Put an agent back on its own model. The saved model list is kept — this
   * only un-wires the config, so the user can re-activate any entry later.
   */
  private async handleRestoreIntegration(
    webview: vscode.Webview,
    target: ExternalAgentTarget,
  ): Promise<void> {
    const integration = this.integrations.find((i) => i.target === target);
    if (!integration) { return; }

    try {
      await integration.restore();
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: true,
        message: `${AGENT_LABELS[target]} is back on its own model. Your saved list is kept.`,
      });
    } catch (error) {
      Logger.error(`Failed to restore ${target}`, error);
      this.postMessage(webview, {
        type: 'integrationApplied',
        target,
        success: false,
        message: `Restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }

    await this.sendIntegrationStatus(webview);
  }

  /** Push current Claude Code / Codex integration status to the webview. */
  private async sendIntegrationStatus(webview: vscode.Webview): Promise<void> {
    const statuses: IntegrationStatus[] = [];
    let rostersChanged = false;

    for (const integration of this.integrations) {
      try {
        const status = await integration.getStatus();
        statuses.push(status);

        // A model can become active without passing through the list — an
        // apply from the command palette, or a config written by an older
        // version. Adopt it so the list always shows what is really wired in.
        const target = status.target as ExternalAgentTarget;
        if (status.active && status.modelId && EXTERNAL_AGENTS.includes(target)) {
          rostersChanged = (await this.addToRoster(target, status.modelId)) || rostersChanged;
        }
      } catch (error) {
        Logger.warn(`Failed to get status for ${integration.target}`, error);
        statuses.push({
          target: integration.target,
          installed: false,
          active: false,
          detail: `Status check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        });
      }
    }

    if (rostersChanged) {
      await this.sendAgentRosters(webview);
    }
    this.postMessage(webview, { type: 'integrationStatus', statuses });
  }

  /**
   * Handle model list request with optional filters.
   */
  private async handleRequestModels(
    webview: vscode.Webview,
    filters?: ModelFilters
  ): Promise<void> {
    let models = this.cache.getModels();

    if (!models.length) {
      this.postMessage(webview, { type: 'loading', isLoading: true });
      const hasKey = await this.secrets.hasApiKey();
      if (hasKey) {
        const key = await this.secrets.getApiKey();
        this.apiClient.setApiKey(key!);
      }
      models = await this.apiClient.fetchModels();
      await this.cache.saveModels(models);
      this.postMessage(webview, { type: 'loading', isLoading: false });
    }

    let filtered = models;
    if (filters) {
      filtered = this.applyFilters(models, filters);
    }

    this.postMessage(webview, {
      type: 'modelsLoaded',
      models: filtered,
      total: models.length,
    });
  }

  private applyFilters(models: ProcessedModel[], filters: ModelFilters): ProcessedModel[] {
    let result = [...models];

    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q)
      );
    }

    if (filters.capabilities?.vision) {
      result = result.filter((m) => m.capabilities.vision);
    }
    if (filters.capabilities?.toolCalling) {
      result = result.filter((m) => m.capabilities.toolCalling);
    }
    if (filters.capabilities?.imageOutput) {
      result = result.filter((m) => m.capabilities.imageOutput);
    }

    if (filters.freeOnly) {
      result = result.filter((m) => m.isFree);
    }

    if (filters.providers && filters.providers.length > 0) {
      result = result.filter((m) => filters.providers!.includes(m.provider));
    }

    if (filters.priceRange?.max !== undefined) {
      result = result.filter((m) => m.pricing.promptPerMillion <= filters.priceRange!.max!);
    }

    if (filters.contextLengthMin) {
      result = result.filter((m) => m.contextLength >= filters.contextLengthMin!);
    }

    switch (filters.sortBy) {
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

  private async handleAddModel(webview: vscode.Webview, modelId: string): Promise<void> {
    const selected = this.getSelectedModels();
    if (selected.find((m) => m.id === modelId)) {
      return;
    }

    const model = this.cache.getModel(modelId);
    selected.push({
      id: modelId,
      name: model?.name || modelId,
      addedAt: Date.now(),
      enabled: false,
    });

    await this.saveSelectedModels(selected);
    this.chatProvider?.refresh();
    this.postMessage(webview, { type: 'modelAdded', modelId });
    await this.sendSelectedModels(webview);
  }

  private async handleRemoveModel(webview: vscode.Webview, modelId: string): Promise<void> {
    const selected = this.getSelectedModels().filter((m) => m.id !== modelId);
    await this.saveSelectedModels(selected);
    this.chatProvider?.refresh();
    this.postMessage(webview, { type: 'modelRemoved', modelId });
    await this.sendSelectedModels(webview);
  }

  private async handleRemoveActiveModel(webview: vscode.Webview, modelId: string): Promise<void> {
    const selected = this.getSelectedModels().filter((m) => m.id !== modelId);
    await this.saveSelectedModels(selected);

    this.chatProvider?.refresh();
    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);
    this.postMessage(webview, { type: 'modelRemoved', modelId });
  }

  private async handleToggleModel(
    webview: vscode.Webview,
    modelId: string,
    enabled: boolean
  ): Promise<void> {
    const selected = this.getSelectedModels();
    const model = selected.find((m) => m.id === modelId);
    if (model) {
      model.enabled = enabled;
      await this.saveSelectedModels(selected);
      this.chatProvider?.refresh();
      await this.sendSelectedModels(webview);
      await this.sendActiveModels(webview);
    }
  }

  /**
   * Enable selected models and refresh native provider.
   * No external config files are written; state is fully managed in extension storage.
   */
  private async handleApplyToCopilot(webview: vscode.Webview): Promise<void> {
    const selected = this.getSelectedModels();

    const hasKey = await this.secrets.hasApiKey();
    if (!hasKey) {
      const didSet = await this.secrets.promptForApiKey();
      if (!didSet) {
        this.postMessage(webview, {
          type: 'appliedToCopilot',
          success: false,
          message: 'API key is required to use OpenRouter models.',
        });
        return;
      }
    }

    // Set enabled flag for all selected models
    for (const m of selected) {
      m.enabled = true;
    }
    await this.saveSelectedModels(selected);

    const enabledCount = selected.filter((m) => m.enabled).length;
    this.chatProvider?.refresh();
    await this.sendSelectedModels(webview);
    await this.sendActiveModels(webview);

    this.postMessage(webview, {
      type: 'appliedToCopilot',
      success: true,
      message: `${enabledCount} model(s) active in Copilot Chat under OpenRouter!`,
    });
  }

  private async handleSetApiKey(webview: vscode.Webview): Promise<void> {
    const result = await this.secrets.promptForApiKey();
    if (result) {
      const key = await this.secrets.getApiKey();
      if (key) {
        this.apiClient.setApiKey(key);
      }
      this.chatProvider?.refresh();
    }
    await this.sendApiKeyStatus(webview);
  }

  private async handleSyncModels(webview: vscode.Webview): Promise<void> {
    this.postMessage(webview, { type: 'loading', isLoading: true });

    try {
      const hasKey = await this.secrets.hasApiKey();
      if (hasKey) {
        const key = await this.secrets.getApiKey();
        this.apiClient.setApiKey(key!);
      }

      const models = await this.apiClient.fetchModels();
      const oldCount = this.cache.getModels().length;
      await this.cache.saveModels(models);
      const newCount = models.length - oldCount;

      this.chatProvider?.refresh();

      this.postMessage(webview, {
        type: 'modelsLoaded',
        models,
        total: models.length,
      });

      this.postMessage(webview, {
        type: 'syncComplete',
        newModelsCount: Math.max(0, newCount),
      });
    } catch (error) {
      this.postMessage(webview, {
        type: 'error',
        message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      this.postMessage(webview, { type: 'loading', isLoading: false });
    }
  }

  private async sendSelectedModels(webview: vscode.Webview): Promise<void> {
    const selected = this.getSelectedModels();
    this.postMessage(webview, {
      type: 'selectedModelsUpdated',
      models: selected,
    });
  }

  private async sendActiveModels(webview: vscode.Webview): Promise<void> {
    const selected = this.getSelectedModels();
    const allModels = this.cache.getModels();

    const activeModels = selected
      .filter((s) => s.enabled)
      .map((s) => {
        const full = allModels.find((m) => m.id === s.id);
        return {
          id: s.id,
          name: full ? full.name : s.name,
          url: 'https://openrouter.ai/api/v1/chat/completions',
          toolCalling: full ? full.capabilities.toolCalling : true,
          vision: full ? full.capabilities.vision : false,
          maxInputTokens: full ? full.contextLength : 128000,
          maxOutputTokens: full ? full.maxOutputTokens : 4096,
        };
      });

    this.postMessage(webview, {
      type: 'activeModelsUpdated',
      models: activeModels,
    });
  }

  private async sendApiKeyStatus(webview: vscode.Webview): Promise<void> {
    const hasKey = await this.secrets.hasApiKey();
    this.postMessage(webview, { type: 'apiKeyStatus', hasKey });
  }

  getSelectedModels(): SelectedModel[] {
    return this.globalState.get<SelectedModel[]>(SELECTED_MODELS_KEY) || [];
  }

  private async saveSelectedModels(models: SelectedModel[]): Promise<void> {
    await this.globalState.update(SELECTED_MODELS_KEY, models);
  }

  private postMessage(webview: vscode.Webview, message: ExtensionMessage): void {
    webview.postMessage(message);
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const getUri = (...segments: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', ...segments)).toString();

    const cspSource = webview.cspSource;
    const htmlPath = path.join(this.extensionUri.fsPath, 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .split('{{cspSource}}').join(cspSource)
      .split('{{variablesCssUri}}').join(getUri('styles', 'variables.css'))
      .split('{{mainCssUri}}').join(getUri('styles', 'main.css'))
      .split('{{cardsCssUri}}').join(getUri('styles', 'cards.css'))
      .split('{{animationsCssUri}}').join(getUri('styles', 'animations.css'))
      .split('{{vscodeApiJsUri}}').join(getUri('scripts', 'vscode-api.js'))
      .split('{{filtersJsUri}}').join(getUri('scripts', 'filters.js'))
      .split('{{appJsUri}}').join(getUri('scripts', 'app.js'));

    return html;
  }
}
