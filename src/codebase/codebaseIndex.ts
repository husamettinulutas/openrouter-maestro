import * as vscode from 'vscode';
import { createEmbeddings, preferredDimensions } from '../api/embeddings';
import { Logger } from '../utils/logger';
import { getAttributionHeaders } from '../utils/branding';
import { chunkLines, looksIndexable } from './chunker';
import { decodeVector, dot, encodeVector, normalize, topK } from './vectors';

/**
 * A semantic index of the workspace, built with OpenRouter embeddings and kept
 * in the extension's workspace storage. Copilot's #codebase search needs a
 * Copilot subscription and is not offered to BYOK models at all.
 *
 * Only files that changed since the last run (by mtime and size) are embedded
 * again, so later searches are cheap.
 */

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

const INDEX_VERSION = 1;
const BATCH_SIZE = 64;
const PARALLEL_BATCHES = 3;
const MAX_FILE_BYTES = 256 * 1024;
/** Re-scan the workspace for changes at most this often. */
const RESCAN_INTERVAL_MS = 30_000;

const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/.next/**',
  '**/coverage/**', '**/vendor/**', '**/bin/**', '**/obj/**', '**/target/**', '**/__pycache__/**',
  '**/.venv/**', '**/venv/**', '**/.vscode-test/**', '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.lock',
  // Secrets must never be sent off for embedding.
  '**/.env', '**/.env.*', '**/*.key', '**/*.pem', '**/id_rsa*', '**/.npmrc', '**/.netrc', '**/secrets.*',
];

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'zip', 'gz', 'tgz', 'tar', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg',
  'mov', 'avi', 'webm', 'class', 'jar', 'pyc', 'o', 'a', 'lib', 'obj', 'pdb', 'vsix', 'db', 'sqlite',
  'key', 'pem', 'pfx', 'p12', 'snk', 'keystore',
]);

interface StoredChunk {
  s: number;
  e: number;
  v: string;
}

interface StoredFile {
  mtime: number;
  size: number;
  chunks: StoredChunk[];
}

interface StoredIndex {
  version: number;
  model: string;
  files: Record<string, StoredFile>;
}

export interface IndexPlan {
  /** Files to embed (new or changed). */
  changed: vscode.Uri[];
  changedBytes: number;
  /** Indexed files that no longer exist or are now excluded. */
  removed: string[];
  totalFiles: number;
  /** The workspace has more files than `codebaseSearch.maxFiles`. */
  truncated: boolean;
  stats: Map<string, { mtime: number; size: number }>;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

function config() {
  const c = vscode.workspace.getConfiguration('openrouterMaestro');
  return {
    model: c.get<string>('codebaseSearch.embeddingModel', DEFAULT_EMBEDDING_MODEL) || DEFAULT_EMBEDDING_MODEL,
    maxFiles: c.get<number>('codebaseSearch.maxFiles', 3000),
    endpoint: c.get<string>('apiEndpoint', 'https://openrouter.ai/api/v1'),
  };
}

function excludeGlob(): string {
  const patterns = new Set(DEFAULT_EXCLUDES);
  for (const section of ['files.exclude', 'search.exclude']) {
    const map = vscode.workspace.getConfiguration().get<Record<string, unknown>>(section) ?? {};
    for (const [pattern, on] of Object.entries(map)) {
      if (on === true && !pattern.includes('{')) {
        patterns.add(pattern.startsWith('**/') || pattern.startsWith('/') ? pattern : `**/${pattern}`);
      }
    }
  }
  return `{${[...patterns].join(',')}}`;
}

function extensionOf(uri: vscode.Uri): string {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export class CodebaseIndex {
  private index: StoredIndex | undefined;
  private loaded = false;
  private lastSync = 0;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly storageUri: vscode.Uri | undefined,
    private readonly getApiKey: () => Promise<string | undefined>,
  ) {}

  get model(): string {
    return config().model;
  }

  private get indexFile(): vscode.Uri | undefined {
    return this.storageUri && vscode.Uri.joinPath(this.storageUri, 'codebase-index.json');
  }

  private assertWorkspace(): void {
    if (!this.storageUri || !vscode.workspace.workspaceFolders?.length) {
      throw new Error('Open a folder or workspace first; there is no codebase to search.');
    }
  }

  private async load(): Promise<StoredIndex> {
    const model = this.model;
    if (!this.loaded) {
      this.loaded = true;
      try {
        const raw = await vscode.workspace.fs.readFile(this.indexFile!);
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as StoredIndex;
        if (parsed.version === INDEX_VERSION && parsed.files) {
          this.index = parsed;
        }
      } catch {
        // no index yet
      }
    }
    if (!this.index || this.index.model !== model) {
      // A different embedding model's vectors cannot be compared with new ones.
      this.index = { version: INDEX_VERSION, model, files: {} };
    }
    return this.index;
  }

  private async save(): Promise<void> {
    if (!this.index || !this.indexFile) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.storageUri!);
    await vscode.workspace.fs.writeFile(this.indexFile, new TextEncoder().encode(JSON.stringify(this.index)));
  }

  /** True once the workspace has been indexed with the current model. */
  async hasIndex(): Promise<boolean> {
    if (!this.storageUri) {
      return false;
    }
    const index = await this.load();
    return Object.keys(index.files).length > 0;
  }

  async plan(): Promise<IndexPlan> {
    this.assertWorkspace();
    const index = await this.load();
    const { maxFiles } = config();
    const found = await vscode.workspace.findFiles('**/*', excludeGlob(), maxFiles + 1);
    const truncated = found.length > maxFiles;
    const files = found.slice(0, maxFiles).filter(uri => !BINARY_EXTENSIONS.has(extensionOf(uri)));

    const stats = new Map<string, { mtime: number; size: number }>();
    const changed: vscode.Uri[] = [];
    let changedBytes = 0;
    await Promise.all(files.map(async uri => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
          return;
        }
        const key = uri.toString();
        stats.set(key, { mtime: stat.mtime, size: stat.size });
        const known = index.files[key];
        if (!known || known.mtime !== stat.mtime || known.size !== stat.size) {
          changed.push(uri);
          changedBytes += stat.size;
        }
      } catch {
        // deleted while scanning
      }
    }));
    const removed = Object.keys(index.files).filter(key => !stats.has(key));
    return { changed, changedBytes, removed, totalFiles: stats.size, truncated, stats };
  }

  /**
   * Embed new and changed files. Runs at most once at a time; a call made
   * while a run is in progress waits for that run.
   */
  async update(
    token?: vscode.CancellationToken,
    onProgress?: (done: number, total: number) => void,
    force = false,
  ): Promise<{ embeddedFiles: number; cost: number }> {
    if (this.running) {
      await this.running.catch(() => undefined);
      if (!force) {
        return { embeddedFiles: 0, cost: 0 };
      }
    }
    if (!force && Date.now() - this.lastSync < RESCAN_INTERVAL_MS) {
      return { embeddedFiles: 0, cost: 0 };
    }
    const run = this.doUpdate(token, onProgress);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = undefined;
    }
  }

  private async doUpdate(
    token: vscode.CancellationToken | undefined,
    onProgress: ((done: number, total: number) => void) | undefined,
  ): Promise<{ embeddedFiles: number; cost: number }> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Set your OpenRouter API key first (OpenRouter Maestro: Set API Key).');
    }
    const index = await this.load();
    const plan = await this.plan();
    for (const key of plan.removed) {
      delete index.files[key];
    }

    const { model, endpoint } = config();
    const dimensions = preferredDimensions(model);
    const controller = new AbortController();
    const onCancel = token?.onCancellationRequested(() => controller.abort());
    let embeddedFiles = 0;
    let cost = 0;
    let done = 0;
    const started = Date.now();

    try {
      // Read and chunk every changed file, then embed the chunks in batches.
      const pending: { key: string; stat: { mtime: number; size: number }; chunks: { s: number; e: number; input: string }[] }[] = [];
      for (const uri of plan.changed) {
        const key = uri.toString();
        const stat = plan.stats.get(key)!;
        let text: string;
        try {
          text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          continue;
        }
        if (!looksIndexable(text)) {
          index.files[key] = { ...stat, chunks: [] };
          continue;
        }
        const path = vscode.workspace.asRelativePath(uri);
        const chunks = chunkLines(text).map(c => ({ s: c.startLine, e: c.endLine, input: `${path}\n${c.text}` }));
        pending.push({ key, stat, chunks });
      }

      const total = pending.reduce((n, f) => n + f.chunks.length, 0);
      onProgress?.(0, total);
      // Embed file by file in groups so a failure keeps the files finished before it.
      let fileCursor = 0;
      while (fileCursor < pending.length) {
        if (token?.isCancellationRequested) {
          break;
        }
        const group: typeof pending = [];
        let groupChunks = 0;
        while (fileCursor < pending.length && groupChunks < BATCH_SIZE * PARALLEL_BATCHES) {
          group.push(pending[fileCursor]);
          groupChunks += pending[fileCursor].chunks.length;
          fileCursor++;
        }
        const inputs = group.flatMap(f => f.chunks.map(c => c.input));
        const batches: string[][] = [];
        for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
          batches.push(inputs.slice(i, i + BATCH_SIZE));
        }
        const results = await Promise.all(batches.map(batch =>
          createEmbeddings(apiKey, endpoint, model, batch, { dimensions, signal: controller.signal, headers: getAttributionHeaders() })));
        const vectors = results.flatMap(r => r.vectors);
        cost += results.reduce((sum, r) => sum + (r.cost ?? 0), 0);

        let v = 0;
        for (const file of group) {
          index.files[file.key] = {
            ...file.stat,
            chunks: file.chunks.map(c => ({ s: c.s, e: c.e, v: encodeVector(normalize(vectors[v++])) })),
          };
          embeddedFiles++;
        }
        done += inputs.length;
        onProgress?.(done, total);
      }
      this.lastSync = token?.isCancellationRequested ? 0 : Date.now();
    } finally {
      onCancel?.dispose();
      await this.save();
    }
    if (embeddedFiles > 0 || plan.removed.length > 0) {
      Logger.info(
        `Codebase index: embedded ${embeddedFiles} files (${done} chunks) with ${model} in ${Date.now() - started} ms` +
        `, removed ${plan.removed.length}, $${cost.toFixed(6)}${plan.truncated ? `; stopped at ${config().maxFiles} files (codebaseSearch.maxFiles)` : ''}`,
      );
    }
    return { embeddedFiles, cost };
  }

  async search(query: string, maxResults: number, token?: vscode.CancellationToken): Promise<SearchHit[]> {
    this.assertWorkspace();
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Set your OpenRouter API key first (OpenRouter Maestro: Set API Key).');
    }
    const index = await this.load();
    const { model, endpoint } = config();
    const controller = new AbortController();
    const onCancel = token?.onCancellationRequested(() => controller.abort());
    let queryVector: Float32Array;
    try {
      const { vectors } = await createEmbeddings(apiKey, endpoint, model, [query], {
        dimensions: preferredDimensions(model),
        signal: controller.signal,
        headers: getAttributionHeaders(),
      });
      queryVector = normalize(vectors[0]);
    } finally {
      onCancel?.dispose();
    }

    const candidates = function* () {
      for (const [key, file] of Object.entries(index.files)) {
        for (const chunk of file.chunks) {
          yield { key, chunk };
        }
      }
    };
    const ranked = topK(candidates(), c => dot(queryVector, decodeVector(c.chunk.v)), maxResults * 3);

    // Drop hits that overlap a better hit in the same file.
    const kept: typeof ranked = [];
    for (const hit of ranked) {
      const overlaps = kept.some(k => k.item.key === hit.item.key &&
        hit.item.chunk.s <= k.item.chunk.e && k.item.chunk.s <= hit.item.chunk.e);
      if (!overlaps) {
        kept.push(hit);
      }
      if (kept.length >= maxResults) {
        break;
      }
    }

    const hits: SearchHit[] = [];
    for (const { item, score } of kept) {
      const uri = vscode.Uri.parse(item.key);
      try {
        const lines = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/);
        hits.push({
          path: vscode.workspace.asRelativePath(uri),
          startLine: item.chunk.s,
          endLine: Math.min(item.chunk.e, lines.length),
          score,
          text: lines.slice(item.chunk.s - 1, item.chunk.e).join('\n'),
        });
      } catch {
        // file deleted since indexing
      }
    }
    return hits;
  }

  async clear(): Promise<void> {
    this.index = undefined;
    this.loaded = true;
    this.lastSync = 0;
    if (this.indexFile) {
      try {
        await vscode.workspace.fs.delete(this.indexFile);
      } catch {
        // nothing to delete
      }
    }
  }
}
