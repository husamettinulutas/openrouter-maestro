/**
 * Flatten the content of a VS Code LanguageModelToolResultPart into what the
 * OpenAI-style chat API accepts: a `role: 'tool'` message carries text only, so
 * images have to travel separately.
 *
 * Duck-typed (no `vscode` import) so it can be unit tested. A tool result's
 * content may hold:
 * - LanguageModelTextPart        → { value: string }
 * - LanguageModelPromptTsxPart   → { value: <prompt-tsx JSON tree> }
 * - LanguageModelDataPart        → { data: Uint8Array, mimeType: string }
 *   (images, text/JSON payloads, or VS Code's `cache_control` markers)
 * - plain strings
 */

export interface ToolResultImage {
  mimeType: string;
  data: Uint8Array;
}

export interface FlattenedToolResult {
  text: string;
  images: ToolResultImage[];
}

/** MIME types whose bytes are UTF-8 text the model should read verbatim. */
function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml')
  );
}

/**
 * Collect the text of a prompt-tsx JSON tree in document order. Text chunks
 * are objects with a string `text` property; everything else is structure.
 */
export function promptTsxToText(node: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!n || typeof n !== 'object') {
      return;
    }
    const obj = n as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      out.push(obj.text);
      return;
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(node);
  return out.join('');
}

export function flattenToolResultContent(content: unknown): FlattenedToolResult {
  const result: FlattenedToolResult = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (!Array.isArray(content)) {
    return result;
  }

  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') {
      continue;
    }
    const p = part as Record<string, unknown>;

    if ('value' in p) {
      if (typeof p.value === 'string') {
        texts.push(p.value);
      } else if (p.value && typeof p.value === 'object') {
        const text = promptTsxToText(p.value);
        texts.push(text || safeJson(p.value));
      }
      continue;
    }

    if ('data' in p && typeof p.mimeType === 'string' && p.data instanceof Uint8Array) {
      const mime = p.mimeType.toLowerCase();
      if (mime.startsWith('image/')) {
        result.images.push({ mimeType: p.mimeType, data: p.data });
      } else if (isTextMime(mime)) {
        texts.push(new TextDecoder().decode(p.data));
      }
      // Anything else (e.g. VS Code's `cache_control` marker) carries no content.
    }
  }

  result.text = texts.join('');
  return result;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
