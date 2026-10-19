/**
 * Some DeepSeek models (V3.x, V4.x) occasionally write a tool call into the
 * ordinary `content` text, in DeepSeek's own markup, instead of sending
 * structured `tool_calls` deltas. Shown as is, the user sees raw markup and
 * the tool never runs. `DsmlStreamFilter` takes that markup out of the
 * streamed text and turns it back into tool calls.
 *
 * Recognised forms:
 *
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="get_weather">
 *   <｜DSML｜parameter name="city" string="true">Paris</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 *
 * the same tags without `<…>` and `DSML` (`｜calls｜ ｜invoke name="x"｜ … ｜/calls｜`),
 * and the older `<｜tool▁calls▁begin｜> … <｜tool▁calls▁end｜>` form.
 */

export interface RecoveredToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Tool name → parameter name → JSON Schema type, from the request's tool definitions. */
export type ToolParamTypes = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Build `ToolParamTypes` from OpenAI-style tool definitions (`{ type: 'function', function: {…} }`). */
export function paramTypesFromTools(tools: readonly any[] | undefined): ToolParamTypes {
  const result = new Map<string, Map<string, string>>();
  for (const tool of tools ?? []) {
    const fn = tool?.type === 'function' ? tool.function : undefined;
    if (typeof fn?.name !== 'string') { continue; }
    const types = new Map<string, string>();
    for (const [param, schema] of Object.entries<any>(fn.parameters?.properties ?? {})) {
      const type = Array.isArray(schema?.type) ? schema.type.find((t: string) => t !== 'null') : schema?.type;
      if (typeof type === 'string') { types.set(param, type); }
    }
    result.set(fn.name, types);
  }
  return result;
}

// A DSML tag. The full-width bar (｜) works with or without `DSML`; the ASCII
// bar only as `<|DSML|`, so Markdown tables (`| invoke |`) are left alone.
const TAG_SOURCE =
  String.raw`(?:<\s*)?(\/)?\s*(?:｜\s*(?:DSML\s*[｜|]\s*)?|\|\s*DSML\s*[｜|]\s*)(\/)?\s*` +
  String.raw`(function_calls|tool_calls|calls|invoke|parameter)((?:\s+[\w-]+\s*=\s*"[^"]*")*)\s*\/?\s*(?:>|[｜|])`;
const tagRegex = () => new RegExp(TAG_SOURCE, 'g');

const LEGACY_BEGIN = /<｜tool[▁_]calls[▁_]begin｜>/;
const LEGACY_END = /<｜tool[▁_]calls[▁_]end｜>/;
const LEGACY_CALL = /<｜tool[▁_]call[▁_]begin｜>([\s\S]*?)(?:<｜tool[▁_]call[▁_]end｜>|$)/g;
const LEGACY_SEP = /<｜tool[▁_]sep｜>/;

const WRAPPERS = new Set(['function_calls', 'tool_calls', 'calls']);

/** Longest stretch of text held back while it might still become a tag. */
const MAX_PARTIAL = 80;

interface Tag {
  index: number;
  end: number;
  closing: boolean;
  kind: string;
  attrs: Record<string, string>;
}

function readTag(m: RegExpExecArray): Tag {
  const attrs: Record<string, string> = {};
  for (const a of m[4].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) { attrs[a[1]] = a[2]; }
  return { index: m.index, end: m.index + m[0].length, closing: !!(m[1] || m[2]), kind: m[3], attrs };
}

/** Where a tool-call block starts in `text`, if one does. */
function findBlockStart(text: string): { index: number; legacy: boolean } | undefined {
  let dsml: number | undefined;
  const re = tagRegex();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const tag = readTag(m);
    if (!tag.closing && (WRAPPERS.has(tag.kind) || tag.kind === 'invoke')) { dsml = tag.index; break; }
  }
  const legacy = LEGACY_BEGIN.exec(text)?.index;
  if (dsml === undefined && legacy === undefined) { return undefined; }
  if (legacy !== undefined && (dsml === undefined || legacy < dsml)) { return { index: legacy, legacy: true }; }
  return { index: dsml!, legacy: false };
}

/** End of the block (just past its closing marker) in `text`, if it has arrived. */
function findBlockEnd(text: string, legacy: boolean): number | undefined {
  if (legacy) {
    const m = LEGACY_END.exec(text);
    return m ? m.index + m[0].length : undefined;
  }
  const re = tagRegex();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const tag = readTag(m);
    if (tag.closing && WRAPPERS.has(tag.kind)) { return tag.end; }
  }
  return undefined;
}

/**
 * Index from which `text` must be held back because its tail may be the
 * beginning of a tag that has not fully arrived yet.
 */
function partialTagStart(text: string): number {
  const from = Math.max(0, text.length - MAX_PARTIAL);
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c !== '<' && c !== '｜') { continue; }
    const tail = text.slice(i);
    if (tail.includes('\n')) { continue; }
    if (c === '｜' || /^<\s*(?:[｜|][^>]*)?$/.test(tail)) { return i; }
  }
  return text.length;
}

function coerce(raw: string, stringAttr: string | undefined, schemaType: string | undefined): unknown {
  const value = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  if (stringAttr === 'true' || schemaType === 'string') { return value; }
  const wantsJson = stringAttr === 'false' || schemaType !== undefined || /^\s*[[{]/.test(value);
  if (!wantsJson) { return value; }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseDsmlBlock(block: string, types: ToolParamTypes): RecoveredToolCall[] {
  const calls: RecoveredToolCall[] = [];
  let call: { name: string; input: Record<string, unknown> } | undefined;
  let param: { name: string; stringAttr?: string; start: number } | undefined;

  const closeParam = (end: number) => {
    if (call && param) {
      call.input[param.name] = coerce(block.slice(param.start, end), param.stringAttr, types.get(call.name)?.get(param.name));
    }
    param = undefined;
  };
  const closeCall = (end: number) => {
    closeParam(end);
    if (call) { calls.push(call); }
    call = undefined;
  };

  const re = tagRegex();
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const tag = readTag(m);
    // Inside a value only its closing tag counts, so a value may contain markup.
    if (param && !(tag.kind === 'parameter' && tag.closing)) { continue; }
    if (tag.kind === 'invoke') {
      closeCall(tag.index);
      if (!tag.closing && tag.attrs.name) { call = { name: tag.attrs.name, input: {} }; }
    } else if (tag.kind === 'parameter') {
      if (tag.closing) {
        closeParam(tag.index);
      } else if (call && tag.attrs.name) {
        param = { name: tag.attrs.name, stringAttr: tag.attrs.string, start: tag.end };
      }
    } else if (tag.closing) {
      closeCall(tag.index);
    }
  }
  closeCall(block.length);
  return calls;
}

function stripFences(text: string): string {
  const m = /^```[\w-]*\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
  return (m ? m[1] : text).trim();
}

function parseLegacyBlock(block: string): RecoveredToolCall[] {
  const calls: RecoveredToolCall[] = [];
  for (const m of block.matchAll(LEGACY_CALL)) {
    const parts = m[1].split(LEGACY_SEP);
    if (parts.length < 2) { continue; }
    let name: string;
    let args: string;
    const head = parts[0].trim();
    const rest = parts.slice(1).join('');
    if (head === '' || head === 'function') {
      // V3: function<｜tool▁sep｜>name\n```json\n{…}\n```
      const newline = rest.indexOf('\n');
      name = (newline < 0 ? rest : rest.slice(0, newline)).trim();
      args = newline < 0 ? '' : rest.slice(newline + 1);
    } else {
      // V3.1: name<｜tool▁sep｜>{…}
      name = head;
      args = rest;
    }
    if (!name) { continue; }
    args = stripFences(args);
    try {
      const input = args ? JSON.parse(args) : {};
      if (input && typeof input === 'object' && !Array.isArray(input)) { calls.push({ name, input }); }
    } catch {
      // Not a usable call: the block is shown as text if nothing else in it parses.
    }
  }
  return calls;
}

/**
 * Streaming filter over a response's `content` text. `push` returns the text
 * that can be shown now; markup that may start a tool-call block is held back
 * until it is either complete (then removed and parsed) or clearly not markup.
 * A block that yields no tool call is shown unchanged, so nothing is lost.
 */
export class DsmlStreamFilter {
  private pending = '';
  private inBlock = false;
  private legacy = false;
  private calls: RecoveredToolCall[] = [];

  constructor(private readonly types: ToolParamTypes = new Map()) {}

  /** Add streamed text; returns the part safe to display now. */
  push(text: string): string {
    this.pending += text;
    let out = '';
    for (;;) {
      if (!this.inBlock) {
        const start = findBlockStart(this.pending);
        if (!start) {
          const hold = partialTagStart(this.pending);
          out += this.pending.slice(0, hold);
          this.pending = this.pending.slice(hold);
          return out;
        }
        out += this.pending.slice(0, start.index);
        this.pending = this.pending.slice(start.index);
        this.inBlock = true;
        this.legacy = start.legacy;
      }
      const end = findBlockEnd(this.pending, this.legacy);
      if (end === undefined) { return out; }
      out += this.finishBlock(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
    }
  }

  /**
   * End of stream (or of one choice): returns the remaining text and every
   * tool call recovered since the last flush. The filter can be reused.
   */
  flush(): { text: string; calls: RecoveredToolCall[] } {
    let text = this.pending;
    if (this.inBlock) { text = this.finishBlock(this.pending); }
    const calls = this.calls;
    this.pending = '';
    this.calls = [];
    return { text, calls };
  }

  /** Parse a complete (or cut-off) block; returns the text to show in its place. */
  private finishBlock(block: string): string {
    this.inBlock = false;
    const calls = this.legacy ? parseLegacyBlock(block) : parseDsmlBlock(block, this.types);
    if (calls.length === 0) { return block; }
    this.calls.push(...calls);
    return '';
  }
}
