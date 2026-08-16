import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../utils/logger';

/** Markers delimiting the config block managed by this extension. */
export const MANAGED_BLOCK_BEGIN = '# --- BEGIN OPENROUTER MAESTRO (auto-generated, do not edit) ---';
export const MANAGED_BLOCK_END = '# --- END OPENROUTER MAESTRO ---';

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Read a UTF-8 text file, returning undefined if it does not exist. */
export function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') { return undefined; }
    throw err;
  }
}

/** Read and parse a JSON file. Returns undefined if missing, throws on invalid JSON. */
export function readJsonFile<T = any>(filePath: string): T | undefined {
  const raw = readTextFile(filePath);
  if (raw === undefined || raw.trim() === '') { return undefined; }
  return JSON.parse(raw) as T;
}

/**
 * Write a file atomically: write to a temp sibling then rename over the target.
 * Creates parent directories as needed.
 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.maestro-tmp`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Serialize and write JSON with stable 2-space indentation. */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Create a one-time backup of a config file before the first Maestro write.
 * The backup is only written if it does not already exist, so the pristine
 * pre-Maestro state is always recoverable.
 * Returns the backup path, or undefined when the original does not exist.
 */
export function backupOnce(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) { return undefined; }
  const backupPath = `${filePath}.maestro-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    Logger.info(`Created backup: ${backupPath}`);
  }
  return backupPath;
}

/**
 * Replace (or append) the Maestro-managed block inside a text config file.
 * All user content outside the markers is preserved byte-for-byte.
 */
export function upsertManagedBlock(existing: string | undefined, blockBody: string): string {
  const block = `${MANAGED_BLOCK_BEGIN}\n${blockBody.trim()}\n${MANAGED_BLOCK_END}`;
  if (existing === undefined || existing.trim() === '') {
    return block + '\n';
  }

  const stripped = removeManagedBlock(existing);
  const sep = stripped.endsWith('\n') ? '' : '\n';
  return `${stripped}${sep}\n${block}\n`;
}

/**
 * Remove the Maestro-managed block from a text config file, if present.
 * Whitespace is normalized only at the splice point — user content elsewhere
 * (including blank lines inside multi-line strings) is never touched.
 */
export function removeManagedBlock(existing: string): string {
  const begin = existing.indexOf(MANAGED_BLOCK_BEGIN);
  if (begin === -1) { return existing; }
  const endMarker = existing.indexOf(MANAGED_BLOCK_END, begin);
  if (endMarker === -1) {
    // Malformed: begin marker without end. Truncating to EOF could delete
    // unrelated content appended after the block — refuse instead.
    throw new Error(
      'Maestro managed block is malformed (end marker missing). ' +
      'Fix the file manually or restore it from its .maestro-backup copy.'
    );
  }
  const end = endMarker + MANAGED_BLOCK_END.length;
  // Collapse only the blank lines Maestro added around the block.
  let before = existing.slice(0, begin).replace(/\n+$/, '\n');
  if (before === '\n') { before = ''; }
  let after = existing.slice(end).replace(/^\n+/, '');
  if (after !== '') { after = (before === '' ? '' : '\n') + after; }
  return before + after;
}

/** True when the managed block is present in the file content. */
export function hasManagedBlock(content: string | undefined): boolean {
  return content !== undefined && content.includes(MANAGED_BLOCK_BEGIN);
}

/** Escape a string for embedding inside a double-quoted TOML string. */
export function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Validate a model id before writing it into any agent config.
 *
 * OpenRouter serves two id shapes and BOTH must be written verbatim:
 *  - "provider/model[:variant]"            e.g. "deepseek/deepseek-v4-flash-0731"
 *  - "~provider/model"  (rolling aliases)  e.g. "~deepseek/deepseek-v4-flash-latest"
 *
 * The leading tilde is part of the id: rolling-alias entries exist ONLY in
 * tilde form in the catalog, and the de-tilded slug is rejected by OpenRouter
 * with 400 "not a valid model ID". (An earlier release stripped the tilde
 * "defensively" — that corrupted every rolling-alias id, so never do that.)
 */
export function sanitizeModelId(raw: string): string {
  const id = raw.trim();
  if (!/^~?[A-Za-z0-9][\w.-]*\/[\w.-]+(:[\w.-]+)?$/.test(id)) {
    throw new Error(
      `"${raw}" is not a valid OpenRouter model id (expected "provider/model" or a "~provider/model-latest" rolling alias).`
    );
  }
  return id;
}
