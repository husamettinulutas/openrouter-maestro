/**
 * Turn a fetched web page into text a model can read.
 *
 * Copilot's own fetch tool ranks page chunks with GitHub's embeddings service,
 * which fails without an active Copilot subscription. The extension's fetch
 * tool uses this converter instead: no network, no DOM, just enough structure
 * (headings, lists, links, code blocks) for the model to follow the page.
 */

/** Elements whose content is never page text. */
const DROPPED_ELEMENTS = /<(script|style|noscript|template|svg|canvas|iframe|object|head|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Elements that start a new paragraph. */
const BLOCK_TAGS = /<\/?(p|div|section|article|main|header|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|blockquote|figure|figcaption|form|fieldset|details|summary|address)\b[^>]*>/gi;

/** Marks where a code block goes back in; NULs are removed from the page first. */
const CODE_MARK = String.fromCharCode(0);
const CODE_PLACEHOLDER = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g');

/** Zero-width spaces, often the only text of a heading's anchor link. */
const ZERO_WIDTH = new RegExp(`[${String.fromCharCode(0x200b, 0xfeff)}]|&#8203;|&ZeroWidthSpace;`, 'g');

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', times: '×', rarr: '→', larr: '←',
};

export interface PageText {
  title?: string;
  text: string;
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** The first <main>, else the first <article>, else <body>, else the whole document. */
function mainContent(html: string): string {
  for (const tag of ['main', 'article', 'body']) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html);
    if (!open) {
      continue;
    }
    const start = open.index + open[0].length;
    const end = html.toLowerCase().lastIndexOf(`</${tag}`);
    return end > start ? html.slice(start, end) : html.slice(start);
  }
  return html;
}

function absoluteUrl(href: string, baseUrl: string | undefined): string | undefined {
  try {
    const url = new URL(decodeEntities(href.trim()), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function htmlToText(html: string, baseUrl?: string): PageText {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, ' ').trim() : '';

  let body = html.replace(/\x00|<!--[\s\S]*?-->/g, '').replace(DROPPED_ELEMENTS, '');
  body = mainContent(body);

  // Code blocks keep their whitespace, so set them aside before collapsing it.
  const codeBlocks: string[] = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n'))).replace(/^\n+|\s+$/g, '');
    codeBlocks.push('```\n' + code + '\n```');
    return `\n\n${CODE_MARK}${codeBlocks.length - 1}${CODE_MARK}\n\n`;
  });

  // Line breaks in HTML source are not line breaks on the page. Zero-width
  // spaces would leave empty "[](#anchor)" links behind.
  body = body.replace(/\s+/g, ' ').replace(ZERO_WIDTH, '');

  body = body.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
      const label = stripTags(inner).trim();
      const href = absoluteUrl(dq ?? sq ?? bare ?? '', baseUrl);
      return label && href ? `[${label}](${href})` : label;
    },
  );

  body = body
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<tr\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<\/?code\b[^>]*>/gi, '`')
    .replace(BLOCK_TAGS, '\n\n');

  let text = decodeEntities(stripTags(body))
    .replace(/\xa0/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').replace(/(\s*\|\s*)+$/, '').replace(/^#+\s*$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  text = text.replace(CODE_PLACEHOLDER, (_m, i: string) => codeBlocks[Number(i)]);

  return { title: title || undefined, text };
}

export interface TextPage {
  text: string;
  /** Where the next page starts, when there is more text. */
  nextOffset?: number;
}

/** One page of a long text, cut at a line break when one is near the limit. */
export function pageOfText(text: string, offset: number, maxChars: number): TextPage {
  const start = Math.min(Math.max(0, Math.floor(offset)), text.length);
  let end = Math.min(start + maxChars, text.length);
  if (end < text.length) {
    const lineBreak = text.lastIndexOf('\n', end);
    if (lineBreak > start + maxChars / 2) {
      end = lineBreak + 1;
    }
  }
  return { text: text.slice(start, end), nextOffset: end < text.length ? end : undefined };
}
