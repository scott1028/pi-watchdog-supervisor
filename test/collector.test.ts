import { afterEach, describe, expect, it } from 'vitest';
import { startCollector } from '../src/collector.ts';
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
