/**
 * Copilot's own fetch tool (`fetch_webpage`) fails for anyone signed in to
 * GitHub without an active Copilot plan ("Your subscription has ended"), and
 * models often pick it over this extension's fetch tool. When a request
 * offers both, leave Copilot's out so the model can only choose the one that
 * works. Signing out of GitHub is then no longer needed.
 */

/** Model-facing name and VS Code tool id of Copilot's fetch tool. */
export const COPILOT_FETCH_TOOL_NAMES: ReadonlySet<string> = new Set(['fetch_webpage', 'copilot_fetchWebPage']);

/**
 * The request's tools without Copilot's fetch tool, when `ownFetchTool` is
 * among them. A tool the conversation already called keeps its definition:
 * some providers reject a history that calls a tool the request no longer
 * defines.
 */
export function withoutCopilotFetch<T extends { name: string }>(
  tools: readonly T[],
  ownFetchTool: string,
  calledTools: ReadonlySet<string>,
): T[] {
  if (!tools.some(tool => tool.name === ownFetchTool)) {
    return [...tools];
  }
  return tools.filter(tool => !COPILOT_FETCH_TOOL_NAMES.has(tool.name) || calledTools.has(tool.name));
}
