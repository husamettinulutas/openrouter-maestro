import * as vscode from 'vscode';
import { ModelCache } from '../cache/modelCache';
import { SelectedModel } from '../types/models';
import { Logger } from '../utils/logger';
import {
  isOursOrEmpty,
  modelIdFromUtilitySetting,
  RECOMMENDED_UTILITY_MODELS,
  UTILITY_SETTINGS,
  utilitySettingValue,
} from '../utils/utilityModel';

/**
 * Point Copilot's utility models (chat titles, commit messages, rename
 * suggestions, repairing failed edits) at an OpenRouter model, so they work
 * without a Copilot subscription.
 */

const PROMPT_DISMISSED_KEY = 'openrouter-utility-model-prompt-dismissed';

function chatSetting(name: string): unknown {
  const inspected = vscode.workspace.getConfiguration('chat').inspect(name);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/** The OpenRouter model currently set as utility model, if any. */
export function currentUtilityModel(): string | undefined {
  return vscode.workspace.getConfiguration('openrouterMaestro').get<string | null>('utilityModel', null) ?? undefined;
}

/**
 * Write `chat.utilityModel` and `chat.utilitySmallModel`, plus our own
 * `utilityModel` setting that makes the provider offer the model to Copilot.
 * Values the user pointed at another vendor are only replaced after asking.
 */
export async function applyUtilityModel(modelId: string | undefined): Promise<boolean> {
  const foreign = UTILITY_SETTINGS.filter(name => !isOursOrEmpty(chatSetting(name)));
  if (modelId && foreign.length) {
    const answer = await vscode.window.showWarningMessage(
      `chat.${foreign.join(' and chat.')} already point${foreign.length === 1 ? 's' : ''} at another model. Replace with ${modelId}?`,
      { modal: true },
      'Replace',
    );
    if (answer !== 'Replace') {
      return false;
    }
  }

  await vscode.workspace.getConfiguration('openrouterMaestro')
    .update('utilityModel', modelId ?? null, vscode.ConfigurationTarget.Global);
  const chat = vscode.workspace.getConfiguration('chat');
  for (const name of UTILITY_SETTINGS) {
    if (modelId) {
      await chat.update(name, utilitySettingValue(modelId), vscode.ConfigurationTarget.Global);
    } else if (modelIdFromUtilitySetting(chatSetting(name))) {
      // Turning ours off: clear only values this extension wrote.
      await chat.update(name, undefined, vscode.ConfigurationTarget.Global);
    }
  }
  Logger.info(modelId ? `Utility model set to ${modelId}` : 'Utility model cleared');
  return true;
}

interface ModelPick extends vscode.QuickPickItem {
  modelId?: string;
  action?: 'browse' | 'clear';
}

async function pickModel(cache: ModelCache, globalState: vscode.Memento): Promise<ModelPick | undefined> {
  const current = currentUtilityModel();
  const describe = (id: string) => {
    const m = cache.getModel(id);
    return m ? `$${m.pricing.promptPerMillion.toFixed(2)} / $${m.pricing.completionPerMillion.toFixed(2)} per M tokens` : '';
  };
  const items: ModelPick[] = [];
  const recommended = RECOMMENDED_UTILITY_MODELS.filter(id => cache.getModel(id));
  if (recommended.length) {
    items.push({ label: 'Recommended: fast and cheap', kind: vscode.QuickPickItemKind.Separator });
    for (const id of recommended) {
      items.push({ label: id, description: `${describe(id)}${id === current ? ' · current' : ''}`, modelId: id });
    }
  }
  const active = (globalState.get<SelectedModel[]>('openrouter-selected-models') || [])
    .filter(s => s.enabled && !recommended.includes(s.id));
  if (active.length) {
    items.push({ label: 'Your models in Copilot', kind: vscode.QuickPickItemKind.Separator });
    for (const s of active) {
      items.push({ label: s.id, description: `${describe(s.id)}${s.id === current ? ' · current' : ''}`, modelId: s.id });
    }
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(search) Choose from all OpenRouter models…', action: 'browse' });
  if (current) {
    items.push({ label: '$(close) Stop using an OpenRouter utility model', action: 'clear' });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: 'OpenRouter Maestro: Utility model for Copilot',
    placeHolder: 'Copilot uses it for chat titles, commit messages, rename suggestions and repairing failed edits',
  });
  if (choice?.action !== 'browse') {
    return choice;
  }
  const all = cache.getModels()
    .filter(m => !m.variablePricing)
    .sort((a, b) => a.pricing.completionPerMillion - b.pricing.completionPerMillion)
    .map<ModelPick>(m => ({ label: m.id, description: describe(m.id), detail: m.name, modelId: m.id }));
  return vscode.window.showQuickPick(all, { title: 'OpenRouter Maestro: Utility model for Copilot', placeHolder: 'Cheapest first', matchOnDetail: true });
}

export async function chooseUtilityModel(cache: ModelCache, globalState: vscode.Memento): Promise<void> {
  if (cache.getModels().length === 0) {
    vscode.window.showWarningMessage('The OpenRouter model list is empty. Run "OpenRouter Maestro: Sync Models from API" first.');
    return;
  }
  const choice = await pickModel(cache, globalState);
  if (!choice) {
    return;
  }
  const modelId = choice.action === 'clear' ? undefined : choice.modelId;
  if (await applyUtilityModel(modelId)) {
    vscode.window.showInformationMessage(modelId
      ? `Copilot now uses ${modelId} from OpenRouter for chat titles, commit messages and edit repair.`
      : 'Copilot no longer uses an OpenRouter utility model.');
  }
}

/**
 * Once per install: offer to set a utility model when none is configured.
 * Without one, BYOK users without a Copilot subscription get errors for
 * commit messages and chat titles, and failed edits are not repaired.
 */
export async function offerUtilityModel(cache: ModelCache, globalState: vscode.Memento, hasApiKey: boolean): Promise<void> {
  if (!hasApiKey || globalState.get<boolean>(PROMPT_DISMISSED_KEY) || currentUtilityModel()) {
    return;
  }
  if (UTILITY_SETTINGS.some(name => !isOursOrEmpty(chatSetting(name)))) {
    return; // the user already chose a utility model elsewhere
  }
  const suggested = RECOMMENDED_UTILITY_MODELS.find(id => cache.getModel(id));
  if (!suggested) {
    return;
  }
  const use = `Use ${suggested}`;
  const answer = await vscode.window.showInformationMessage(
    'Without a Copilot subscription, Copilot cannot write chat titles or commit messages, or repair failed edits. ' +
    `Use a small OpenRouter model for these (${suggested}, a fraction of a cent per task)?`,
    use, 'Choose model…', "Don't ask again",
  );
  if (answer === use) {
    await applyUtilityModel(suggested);
  } else if (answer === 'Choose model…') {
    await chooseUtilityModel(cache, globalState);
  }
  if (answer) {
    await globalState.update(PROMPT_DISMISSED_KEY, true);
  }
}
