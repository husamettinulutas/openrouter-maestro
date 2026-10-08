import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decodeEntities, htmlToText, pageOfText } from '../utils/htmlToText';

describe('htmlToText', () => {
  it('keeps the title, headings, paragraphs and lists', () => {
    const { title, text } = htmlToText(`<!doctype html><html><head><title>FAQ &amp; Help</title>
      <style>body { color: red }</style></head>
      <body><h1>FAQ</h1><p>First   paragraph
      over two lines.</p><ul><li>One</li><li>Two</li></ul></body></html>`);
    assert.equal(title, 'FAQ & Help');
    assert.equal(text, '# FAQ\n\nFirst paragraph over two lines.\n\n- One\n- Two');
  });

  it('drops scripts, navigation and footers', () => {
    const { text } = htmlToText(`<body><nav><a href="/">Home</a></nav><script>alert(1)</script>
      <p>Content</p><footer>© 2026</footer></body>`);
    assert.equal(text, 'Content');
  });

  it('prefers <main> over the rest of the body', () => {
    const { text } = htmlToText('<body><div>Sidebar</div><main><p>Article</p></main><div>Ads</div></body>');
    assert.equal(text, 'Article');
  });

  it('turns links into Markdown with absolute URLs', () => {
    const { text } = htmlToText(
      '<p>See <a href="/docs/start?a=1&amp;b=2">the guide</a> or <a href="javascript:void(0)">this</a>.</p>',
      'https://example.com/faq',
    );
    assert.equal(text, 'See [the guide](https://example.com/docs/start?a=1&b=2) or this.');
  });

  it('drops anchor links whose only text is a zero-width space', () => {
    const zwsp = String.fromCharCode(0x200b);
    const { text } = htmlToText(`<h2><a href="#start">${zwsp}</a>Getting started</h2>`, 'https://example.com/faq');
    assert.equal(text, '## Getting started');
  });

  it('drops headings left empty', () => {
    const { text } = htmlToText('<h2><a href="#x"></a></h2><p>Getting started</p>');
    assert.equal(text, 'Getting started');
  });

  it('keeps whitespace inside code blocks', () => {
    const { text } = htmlToText('<p>Run:</p><pre><code>if (a &lt; b) {\n  go();\n}</code></pre>');
    assert.equal(text, 'Run:\n\n```\nif (a < b) {\n  go();\n}\n```');
  });

  it('separates table cells', () => {
    const { text } = htmlToText('<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$10</td></tr></table>');
    assert.equal(text, 'Plan | Price\nPro | $10');
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves unknown ones', () => {
    assert.equal(decodeEntities('&lt;a&gt; &#39;x&#x27; &mdash; &unknown;'), "<a> 'x' — &unknown;");
  });
});

describe('pageOfText', () => {
  it('returns the whole text when it fits', () => {
    assert.deepEqual(pageOfText('short', 0, 100), { text: 'short', nextOffset: undefined });
  });

  it('cuts at a line break and points to the rest', () => {
    const text = 'aaaa\nbbbb\ncccc';
    const first = pageOfText(text, 0, 12);
    assert.deepEqual(first, { text: 'aaaa\nbbbb\n', nextOffset: 10 });
    assert.deepEqual(pageOfText(text, first.nextOffset!, 12), { text: 'cccc', nextOffset: undefined });
  });

  it('clamps an offset past the end', () => {
    assert.deepEqual(pageOfText('abc', 50, 10), { text: '', nextOffset: undefined });
  });
});
