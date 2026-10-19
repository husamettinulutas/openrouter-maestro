import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DsmlStreamFilter, paramTypesFromTools } from '../utils/dsml';

/** Feed `text` to a filter in chunks of `size` characters, then flush. */
function run(text: string, size = text.length, filter = new DsmlStreamFilter()) {
  let shown = '';
  for (let i = 0; i < text.length; i += size) { shown += filter.push(text.slice(i, i + size)); }
  const { text: rest, calls } = filter.flush();
  return { shown: shown + rest, calls };
}

const TAGGED = [
  'Let me check that page.\n\n',
  '<｜DSML｜function_calls>\n',
  '<｜DSML｜invoke name="maestro_fetchWebPage">\n',
  '<｜DSML｜parameter name="url" string="true">https://example.com</｜DSML｜parameter>\n',
  '</｜DSML｜invoke>\n',
  '</｜DSML｜function_calls>',
].join('');

const BARE = [
  '｜calls｜\n',
  '｜invoke name="maestro_fetchWebPage"｜\n',
  '｜parameter name="url"｜https://example.com｜/parameter｜\n',
  '｜/invoke｜\n',
  '｜/calls｜',
].join('');

describe('DsmlStreamFilter', () => {
  it('turns a DSML block into a tool call and hides the markup', () => {
    const { shown, calls } = run(TAGGED);
    assert.equal(shown, 'Let me check that page.\n\n');
    assert.deepEqual(calls, [{ name: 'maestro_fetchWebPage', input: { url: 'https://example.com' } }]);
  });

  it('gives the same result however the stream is chunked', () => {
    for (const size of [1, 2, 3, 7, 16]) {
      const { shown, calls } = run(TAGGED, size);
      assert.equal(shown, 'Let me check that page.\n\n', `chunk size ${size}`);
      assert.equal(calls.length, 1, `chunk size ${size}`);
      assert.deepEqual(calls[0].input, { url: 'https://example.com' });
    }
  });

  it('reads the bare form without <…> and DSML', () => {
    for (const size of [1, 5, BARE.length]) {
      const { shown, calls } = run(BARE, size);
      assert.equal(shown, '');
      assert.deepEqual(calls, [{ name: 'maestro_fetchWebPage', input: { url: 'https://example.com' } }]);
    }
  });

  it('accepts ASCII bars with the DSML prefix', () => {
    const text = '<|DSML|function_calls><|DSML|invoke name="a"><|DSML|parameter name="x" string="true">1</|DSML|parameter></|DSML|invoke></|DSML|function_calls>';
    assert.deepEqual(run(text, 4).calls, [{ name: 'a', input: { x: '1' } }]);
  });

  it('reads several calls and several parameters', () => {
    const text = [
      '<｜DSML｜function_calls>',
      '<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter>',
      '<｜DSML｜parameter name="startLine" string="false">10</｜DSML｜parameter></｜DSML｜invoke>',
      '<｜DSML｜invoke name="grep"><｜DSML｜parameter name="query" string="true">foo</｜DSML｜parameter></｜DSML｜invoke>',
      '</｜DSML｜function_calls>',
    ].join('\n');
    assert.deepEqual(run(text, 3).calls, [
      { name: 'read_file', input: { path: 'a.ts', startLine: 10 } },
      { name: 'grep', input: { query: 'foo' } },
    ]);
  });

  it("uses the tool's schema when the string attribute is missing", () => {
    const types = paramTypesFromTools([{
      type: 'function',
      function: { name: 'f', parameters: { properties: { n: { type: 'integer' }, q: { type: 'string' }, o: { type: 'object' } } } },
    }]);
    const text = '｜calls｜｜invoke name="f"｜｜parameter name="n"｜42｜/parameter｜｜parameter name="q"｜2024｜/parameter｜｜parameter name="o"｜{"a":1}｜/parameter｜｜/invoke｜｜/calls｜';
    assert.deepEqual(run(text, 5, new DsmlStreamFilter(types)).calls, [{ name: 'f', input: { n: 42, q: '2024', o: { a: 1 } } }]);
  });

  it('keeps markup inside a parameter value', () => {
    const text = '<｜DSML｜function_calls><｜DSML｜invoke name="write"><｜DSML｜parameter name="content" string="true">see ｜invoke name="x"｜ here</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
    assert.deepEqual(run(text).calls, [{ name: 'write', input: { content: 'see ｜invoke name="x"｜ here' } }]);
  });

  it('shows text that follows a block', () => {
    const { shown, calls } = run(BARE + '\nDone.', 2);
    assert.equal(shown, '\nDone.');
    assert.equal(calls.length, 1);
  });

  it('recovers a block cut off by the end of the stream', () => {
    const cut = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="a">\n<｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter>\n';
    assert.deepEqual(run(cut, 3).calls, [{ name: 'a', input: { x: '1' } }]);
  });

  it('shows a block unchanged when it holds no usable call', () => {
    const text = 'before ｜calls｜ nothing here ｜/calls｜ after';
    const { shown, calls } = run(text, 3);
    assert.equal(shown, text);
    assert.deepEqual(calls, []);
  });

  it('leaves ordinary text, code and Markdown tables alone', () => {
    const text = 'if (a < b && c > d) { x = a | b; }\n\n| invoke | parameter |\n|---|---|\n| calls | <div> |\n';
    for (const size of [1, 4, text.length]) {
      const { shown, calls } = run(text, size);
      assert.equal(shown, text);
      assert.deepEqual(calls, []);
    }
  });

  it('streams ordinary text without holding it back', () => {
    const filter = new DsmlStreamFilter();
    assert.equal(filter.push('Hello, '), 'Hello, ');
    assert.equal(filter.push('world <'), 'world ');
    assert.equal(filter.push('b>'), '<b>');
  });

  it('reads the older tool▁calls form', () => {
    const v31 = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"city": "Paris"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    assert.deepEqual(run(v31, 4).calls, [{ name: 'get_weather', input: { city: 'Paris' } }]);

    const v3 = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather\n```json\n{"city": "Paris"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    assert.deepEqual(run(v3, 4).calls, [{ name: 'get_weather', input: { city: 'Paris' } }]);
  });

  it('can be reused after a flush', () => {
    const filter = new DsmlStreamFilter();
    filter.push(BARE);
    assert.equal(filter.flush().calls.length, 1);
    assert.equal(filter.push('plain'), 'plain');
    assert.deepEqual(filter.flush(), { text: '', calls: [] });
  });
});

describe('paramTypesFromTools', () => {
  it('reads parameter types and skips server tools', () => {
    const types = paramTypesFromTools([
      { type: 'function', function: { name: 'f', parameters: { properties: { a: { type: 'string' }, b: { type: ['number', 'null'] } } } } },
      { type: 'openrouter:web_search' },
    ]);
    assert.deepEqual([...types.keys()], ['f']);
    assert.equal(types.get('f')?.get('a'), 'string');
    assert.equal(types.get('f')?.get('b'), 'number');
  });
});
