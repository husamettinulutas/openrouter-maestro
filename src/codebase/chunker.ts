/**
 * Split source files into overlapping line windows for embedding.
 * Line-based windows keep every hit addressable as `path:start-end`.
 */

export interface Chunk {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChunkOptions {
  maxLines: number;
  overlapLines: number;
  maxChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxLines: 60, overlapLines: 10, maxChars: 3000 };

export function chunkLines(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    // Grow the window until it hits the line or character budget (at least one line).
    while (end < lines.length && end - start < options.maxLines) {
      const next = lines[end].length + 1;
      if (end > start && chars + next > options.maxChars) {
        break;
      }
      chars += next;
      end++;
    }
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) {
      chunks.push({ startLine: start + 1, endLine: end, text: body.slice(0, options.maxChars) });
    }
    if (end >= lines.length) {
      break;
    }
    start = Math.max(end - options.overlapLines, start + 1);
  }
  return chunks;
}

/** Generated or binary content that would only add noise to the index. */
export function looksIndexable(text: string): boolean {
  if (text.includes(String.fromCharCode(0))) {
    return false;
  }
  const lines = text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  // Minified bundles: a few enormous lines.
  return !(longest > 2000 && text.length / lines.length > 300);
}
