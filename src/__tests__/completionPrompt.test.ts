import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildCompletionMessages, cleanCompletion } from '../inline/completionPrompt';

describe('buildCompletionMessages', () => {
  it('marks the cursor between prefix and suffix', () => {
    const [system, user] = buildCompletionMessages({ path: 'src/a.ts', languageId: 'typescript', prefix: 'const x = ', suffix: ';\n' });
    assert.equal(system.role, 'system');
    assert.equal(user.content, 'File: src/a.ts (typescript)\n<PREFIX>const x = </PREFIX><CURSOR><SUFFIX>;\n</SUFFIX>');
  });
});

describe('cleanCompletion', () => {
  it('drops indentation the model repeats (Codestral, live)', () => {
    const prefix = 'for (const line of lines) {\n    ';
    const raw = "    const trimmed = line.trim();\n    if (!trimmed) continue;";
    assert.equal(cleanCompletion(raw, prefix, '\n  }\n'), "const trimmed = line.trim();\n    if (!trimmed) continue;");
  });

  it('removes a Markdown fence around the answer (Qwen Coder, live)', () => {
    const raw = "```typescript\n    const [key, value] = line.split('=');\n```";
    assert.equal(cleanCompletion(raw, 'x\n    ', ''), "const [key, value] = line.split('=');");
  });

  it('removes the part of the current line the model repeats', () => {
    assert.equal(cleanCompletion('const total = a + b;', 'function f() {\n  const total = ', '\n}'), 'a + b;');
  });

  it('drops a trailing echo of the code after the cursor', () => {
    const raw = '  return a + b;\n}';
    assert.equal(cleanCompletion(raw, 'function add(a, b) {\n', '\n}\n'), '  return a + b;');
  });

  it('caps the length and trims trailing whitespace', () => {
    const raw = Array.from({ length: 40 }, (_, i) => `x${i}`).join('\n') + '\n\n';
    assert.equal(cleanCompletion(raw, 'a\n', '').split('\n').length, 20);
    assert.equal(cleanCompletion('   \n', 'a = ', ''), '');
  });
});
