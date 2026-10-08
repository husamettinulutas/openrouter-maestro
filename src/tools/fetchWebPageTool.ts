import * as vscode from 'vscode';
import { htmlToText, pageOfText } from '../utils/htmlToText';
import { Logger } from '../utils/logger';
import { OPENROUTER_APP_URL } from '../utils/branding';

/**
 * A web fetch tool for Copilot agent mode that works without a Copilot subscription.
 *
 * Copilot's `fetch_webpage` sends page text to GitHub's embeddings service to
 * pick the relevant parts. With an expired or missing subscription that call
 * fails ("Your subscription has ended"), so BYOK users cannot fetch at all.
 * This tool downloads the page itself and returns its text in pages.
 */

export const FETCH_TOOL_NAME = 'maestro_fetchWebPage';

const TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
/** Roughly 10k tokens per call; the model asks for the rest with `offset`. */
const MAX_CHARS_PER_CALL = 40_000;

interface FetchWebPageInput {
  url: string;
  offset?: number;
}

function parseHttpUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Pass the page address in "url".');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid URL. Use a full address such as https://example.com/page.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https addresses can be fetched, not ${url.protocol}`);
  }
  return url;
}

async function readBody(response: Response, token: vscode.CancellationToken): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_DOWNLOAD_BYTES && !token.isCancellationRequested) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body.subarray(0, MAX_DOWNLOAD_BYTES);
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function isTextType(contentType: string): boolean {
  return /^text\//i.test(contentType) || /json|xml|javascript|ecmascript|markdown|yaml|csv/i.test(contentType);
}

export class FetchWebPageTool implements vscode.LanguageModelTool<FetchWebPageInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FetchWebPageInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    let target: string;
    try {
      target = parseHttpUrl(options.input.url).href;
    } catch {
      target = String(options.input.url);
    }
    return {
      invocationMessage: `Fetching ${target}`,
      confirmationMessages: {
        title: 'Fetch web page?',
        message: `Download ${target} and give its text to the model.`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FetchWebPageInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const url = parseHttpUrl(options.input.url);
    const offset = typeof options.input.offset === 'number' ? options.input.offset : 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onCancel = token.onCancellationRequested(() => controller.abort());

    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await fetch(url.href, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': `Mozilla/5.0 (compatible; OpenRouterMaestro; +${OPENROUTER_APP_URL})`,
          Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
        },
      });
      bytes = await readBody(response, token);
    } catch (error) {
      const reason = controller.signal.aborted && !token.isCancellationRequested
        ? `no answer within ${TIMEOUT_MS / 1000} seconds`
        : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      Logger.warn(`Fetch tool: ${url.href} failed: ${reason}`);
      throw new Error(`Could not fetch ${url.href}: ${reason}`);
    } finally {
      clearTimeout(timer);
      onCancel.dispose();
    }

    const finalUrl = response.url || url.href;
    const contentType = response.headers.get('content-type') ?? '';
    Logger.info(`Fetch tool: ${finalUrl} → HTTP ${response.status}, ${contentType || 'no content type'}, ${bytes.byteLength} bytes`);

    if (!response.ok) {
      throw new Error(`${finalUrl} answered HTTP ${response.status} ${response.statusText}.`.trim());
    }
    if (contentType && !isTextType(contentType) && !/html/i.test(contentType)) {
      throw new Error(`${finalUrl} returned ${contentType.split(';')[0]}, which is not a text page.`);
    }

    const raw = decode(bytes, contentType);
    const looksLikeHtml = /html/i.test(contentType) || (!contentType && /^\s*<(!doctype html|html)\b/i.test(raw));
    const { title, text } = looksLikeHtml ? htmlToText(raw, finalUrl) : { title: undefined, text: raw.trim() };

    const page = pageOfText(text, offset, MAX_CHARS_PER_CALL);
    const header = [
      title ? `Title: ${title}` : undefined,
      `URL: ${finalUrl}`,
      text.length > MAX_CHARS_PER_CALL || offset > 0
        ? `Characters ${Math.min(offset, text.length)}–${page.nextOffset ?? text.length} of ${text.length}`
        : undefined,
    ].filter(Boolean).join('\n');
    const footer = page.nextOffset !== undefined
      ? `\n\n[The page continues. Call ${FETCH_TOOL_NAME} again with offset ${page.nextOffset} to read more.]`
      : '';
    const content = page.text || (offset > 0 ? '(No more text on this page.)' : '(The page has no readable text.)');

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`${header}\n\n${content}${footer}`),
    ]);
  }
}
