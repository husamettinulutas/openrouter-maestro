import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { withoutCopilotFetch } from '../utils/toolReplacement';

const names = (tools: { name: string }[]) => tools.map(t => t.name);
const OWN = 'maestro_fetchWebPage';

describe('withoutCopilotFetch', () => {
  it("drops Copilot's fetch tool when ours is offered", () => {
    const tools = [{ name: 'read_file' }, { name: 'fetch_webpage' }, { name: OWN }];
    assert.deepEqual(names(withoutCopilotFetch(tools, OWN, new Set())), ['read_file', OWN]);
  });

  it("keeps Copilot's fetch tool when ours is turned off", () => {
    const tools = [{ name: 'read_file' }, { name: 'fetch_webpage' }];
    assert.deepEqual(names(withoutCopilotFetch(tools, OWN, new Set())), ['read_file', 'fetch_webpage']);
  });

  it('keeps it when the conversation already called it', () => {
    const tools = [{ name: 'fetch_webpage' }, { name: OWN }];
    assert.deepEqual(names(withoutCopilotFetch(tools, OWN, new Set(['fetch_webpage']))), ['fetch_webpage', OWN]);
  });

  it('also recognises the VS Code tool id', () => {
    const tools = [{ name: 'copilot_fetchWebPage' }, { name: OWN }];
    assert.deepEqual(names(withoutCopilotFetch(tools, OWN, new Set())), [OWN]);
  });
});
