import * as vscode from 'vscode';
import { CodebaseIndex, DEFAULT_EMBEDDING_MODEL } from '../codebase/codebaseIndex';

/**
 * Semantic code search for agent mode, backed by OpenRouter embeddings.
 * Copilot's #codebase needs a Copilot subscription and is never offered to
 * BYOK models (VS Code 1.127+), so without this tool the model can only grep.
 */

export const CODEBASE_TOOL_NAME = 'maestro_codebaseSearch';

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_OUTPUT_CHARS = 30_000;

interface CodebaseSearchInput {
  query: string;
  maxResults?: number;
}

/** text-embedding-3-small: $0.02 per million tokens, about 4 characters per token. */
function estimateDefaultModelCost(bytes: number): string {
  const dollars = (bytes / 4 / 1_000_000) * 0.02;
  return dollars < 0.01 ? 'under $0.01' : `about $${dollars.toFixed(2)}`;
}

export class CodebaseSearchTool implements vscode.LanguageModelTool<CodebaseSearchInput> {
  constructor(private readonly index: CodebaseIndex) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CodebaseSearchInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const query = String(options.input.query ?? '');
    if (await this.index.hasIndex()) {
      return { invocationMessage: `Searching the codebase for "${query}"` };
    }
    // First run: the files' contents leave the machine, so ask once.
    let detail = '';
    try {
      const plan = await this.index.plan();
      const megabytes = (plan.changedBytes / 1024 / 1024).toFixed(1);
      const cost = this.index.model === DEFAULT_EMBEDDING_MODEL ? `, ${estimateDefaultModelCost(plan.changedBytes)}` : '';
      detail = ` ${plan.changed.length} files (${megabytes} MB${cost})`;
    } catch {
      // the confirmation still makes sense without numbers
    }
    return {
      invocationMessage: 'Indexing the workspace for semantic search',
      confirmationMessages: {
        title: 'Index this workspace?',
        message:
          `To search code by meaning, the${detail} of this workspace are sent to OpenRouter to compute embeddings with ${this.index.model}. ` +
          'The index stays on this machine, and later searches only send files that changed. ' +
          'Secrets such as .env and key files are skipped.',
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CodebaseSearchInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const query = typeof options.input.query === 'string' ? options.input.query.trim() : '';
    if (!query) {
      throw new Error('Pass what to look for in "query", e.g. "where API keys are validated".');
    }
    const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.round(options.input.maxResults ?? DEFAULT_RESULTS)));

    const firstRun = !(await this.index.hasIndex());
    if (firstRun) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'OpenRouter Maestro: indexing the workspace', cancellable: true },
        (progress, cancel) => {
          let last = 0;
          return this.index.update(cancel, (done, total) => {
            const percent = total ? Math.round((done / total) * 100) : 100;
            progress.report({ increment: percent - last, message: `${done} / ${total} chunks` });
            last = percent;
          });
        },
      );
    } else {
      await this.index.update(token);
    }

    const hits = await this.index.search(query, maxResults, token);
    if (!hits.length) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No indexed code matched. The workspace may have no indexable files; try a text search instead.'),
      ]);
    }

    let output = `Top ${hits.length} code locations for "${query}" (semantic match, best first):\n`;
    for (const hit of hits) {
      // A fence longer than any backtick run in the code, so Markdown files cannot close it early.
      const fence = '`'.repeat(Math.max(3, ...(hit.text.match(/`+/g) ?? []).map(run => run.length + 1)));
      const block = `\n## ${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(2)})\n${fence}\n${hit.text}\n${fence}\n`;
      if (output.length + block.length > MAX_OUTPUT_CHARS) {
        output += `\n(${hits.length - hits.indexOf(hit)} more results left out to save space.)\n`;
        break;
      }
      output += block;
    }
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
  }
}
