/**
 * Prompt and post-processing for inline (ghost text) completions.
 *
 * OpenRouter has no fill-in-the-middle endpoint, so the code before and after
 * the cursor goes to a chat model with instructions to return only the
 * insertion. Models still add fences, repeat the indentation already typed or
 * echo the code after the cursor; cleanCompletion undoes that.
 */

export const DEFAULT_INLINE_MODEL = 'mistralai/codestral-2508';

const SYSTEM_PROMPT =
  'You are a code completion engine inside an editor. Reply with ONLY the text to insert at <CURSOR>, ' +
  'continuing the code naturally. No explanations, no Markdown fences, and never repeat code that is ' +
  'already before or after the cursor. Complete at most one logical block. If nothing fits, reply with nothing.';

export interface CompletionContext {
  path: string;
  languageId: string;
  prefix: string;
  suffix: string;
}

export function buildCompletionMessages(ctx: CompletionContext): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `File: ${ctx.path} (${ctx.languageId})\n<PREFIX>${ctx.prefix}</PREFIX><CURSOR><SUFFIX>${ctx.suffix}</SUFFIX>`,
    },
  ];
}

const MAX_LINES = 20;

export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/\r\n?/g, '\n');

  // A Markdown fence around the whole answer.
  const fenced = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) {
    text = fenced[1];
  }
  text = text.replace(/<\/?(CURSOR|PREFIX|SUFFIX)>/g, '');

  // The indentation (or partial line) typed before the cursor, repeated.
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const typed = currentLine.trimStart();
  if (currentLine && text.startsWith(currentLine)) {
    text = text.slice(currentLine.length);
  } else if (typed && text.startsWith(typed)) {
    text = text.slice(typed.length);
  } else if (/^\s+$/.test(currentLine)) {
    // Cursor sits in indentation: drop the leading whitespace the model added.
    text = text.replace(/^[ \t]+/, '');
  }

  // The code after the cursor, echoed at the end of the answer.
  const suffixHead = suffix.replace(/^\s+/, '');
  if (suffixHead) {
    const firstSuffixLine = suffixHead.split('\n')[0].trim();
    const lines = text.split('\n');
    while (lines.length > 1 && firstSuffixLine && lines[lines.length - 1].trim() === firstSuffixLine) {
      lines.pop();
    }
    text = lines.join('\n');
  }

  const lines = text.split('\n');
  if (lines.length > MAX_LINES) {
    text = lines.slice(0, MAX_LINES).join('\n');
  }
  return text.replace(/\s+$/, '');
}
