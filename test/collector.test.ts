import { afterEach, describe, expect, it } from 'vitest';
import { startCollector, startLlmCollector } from '../src/collector.ts';
import { getOrCreateStore, resetStoreForTest } from '../src/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

afterEach(() => {
  resetStoreForTest();
});

type Handler = (event: unknown) => void;

// Fake pi exposing only the `on` surface the collector uses
const createFakePi = () => {
  const handlers = new Map<string, Handler[]>();
  return {
    pi: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
};

describe('startCollector', () => {
  it('records bash tool_call with normalized commandKey', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startCollector(pi, store, 'sess-1', DEFAULT_CONFIG);
    emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'bash',
      input: { command: 'rg  "X"  src' },
    });
    const events = store.getEvents('sess-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('tool_call');
    expect(events[0]?.commandKey).toBe('rg "X" src');
    expect(events[0]?.summary).toBe('bash: rg "X" src');
  });

  it('records tool_result with output hash and preview', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startCollector(pi, store, 'sess-1', DEFAULT_CONFIG);
    emit('tool_result', {
      type: 'tool_result',
      toolCallId: 'tc-1',
      toolName: 'bash',
      input: { command: 'rg "X" src' },
      content: [{ type: 'text', text: 'match line 1\nmatch line 2' }],
      isError: false,
    });
    const events = store.getEvents('sess-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('tool_result');
    expect(events[0]?.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]?.outputPreview).toBe('match line 1\nmatch line 2');
  });

  it('classifies edit-family tools as edit events', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startCollector(pi, store, 'sess-1', DEFAULT_CONFIG);
    emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc-2',
      toolName: 'edit',
      input: { path: 'src/a.ts' },
    });
    expect(store.getEvents('sess-1')[0]?.type).toBe('edit');
  });

  it('uses first string input value as commandKey for non-bash tools', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startCollector(pi, store, 'sess-1', DEFAULT_CONFIG);
    emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc-3',
      toolName: 'grep',
      input: { pattern: 'TOKEN', path: 'src' },
    });
    expect(store.getEvents('sess-1')[0]?.commandKey).toBe('grep TOKEN');
  });

  it('ignores malformed payloads without throwing', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startCollector(pi, store, 'sess-1', DEFAULT_CONFIG);
    emit('tool_call', null);
    emit('tool_result', { unexpected: true });
    expect(store.getEvents('sess-1')).toEqual([]);
  });

  it('stops recording after unsubscribe', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    const stop = startCollector(pi, store, 'sess-1', DEFAULT_CONFIG);
    stop();
    emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc-4',
      toolName: 'bash',
      input: { command: 'ls' },
    });
    expect(store.getEvents('sess-1')).toEqual([]);
  });
});

describe('startLlmCollector', () => {
  it('records the last payload message as llm_input with a normalized-body hash', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startLlmCollector(pi, store, 'sess-1');
    emit('before_provider_request', {
      type: 'before_provider_request',
      payload: {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'fix bug at 2026-07-08T14:15:23Z run #17' },
        ],
      },
    });
    const events = store.getEvents('sess-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('llm_input');
    expect(events[0]?.commandKey).toBe('llm_input');
    expect(events[0]?.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]?.outputPreview).toContain('user: fix bug at <ts> run #<n>');
  });

  it('hashes identically when bodies differ only in timestamps/ids', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startLlmCollector(pi, store, 'sess-1');
    const send = (text: string) =>
      emit('before_provider_request', {
        type: 'before_provider_request',
        payload: { messages: [{ role: 'user', content: text }] },
      });
    send('retry at 2026-07-08T14:15:23Z seq 17');
    send('retry at 2026-07-08T14:16:41Z seq 42');
    const [first, second] = store.getEvents('sess-1');
    expect(first?.outputHash).toBe(second?.outputHash);
  });

  it('records assistant message_end as llm_output including tool calls', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startLlmCollector(pi, store, 'sess-1');
    emit('message_end', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I need to edit the file' },
          { type: 'text', text: 'Editing now' },
          { type: 'toolCall', id: 'tc-1', name: 'edit', arguments: { path: 'a.ts' } },
        ],
      },
    });
    const events = store.getEvents('sess-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('llm_output');
    expect(events[0]?.outputPreview).toContain('toolCall edit');
  });

  it('invokes onEvent after each recorded llm event (event-driven check hook)', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    let calls = 0;
    startLlmCollector(pi, store, 'sess-1', () => {
      calls += 1;
      expect(store.getEvents('sess-1').length).toBe(calls);
    });
    emit('before_provider_request', {
      type: 'before_provider_request',
      payload: { messages: [{ role: 'user', content: 'go' }] },
    });
    emit('message_end', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });
    expect(calls).toBe(2);
  });

  it('ignores non-assistant message_end and malformed payloads', () => {
    const store = getOrCreateStore(10);
    const { pi, emit } = createFakePi();
    startLlmCollector(pi, store, 'sess-1');
    emit('message_end', { type: 'message_end', message: { role: 'toolResult', content: [] } });
    emit('before_provider_request', { type: 'before_provider_request', payload: null });
    expect(store.getEvents('sess-1')).toEqual([]);
  });
});
