import { afterEach, describe, expect, it } from 'vitest';
import { getOrCreateStore, resetStoreForTest } from '../src/store.ts';

afterEach(() => {
  resetStoreForTest();
});

const event = (overrides: Record<string, unknown> = {}) => ({
  at: 1000,
  type: 'tool_call' as const,
  summary: 'bash: rg "X" src',
  ...overrides,
});

describe('getOrCreateStore', () => {
  it('returns the same instance across calls (globalThis shared)', () => {
    const a = getOrCreateStore(10);
    const b = getOrCreateStore(10);
    expect(a).toBe(b);
  });
});

describe('registerChild / getChild', () => {
  it('registers and resolves a child session', () => {
    const store = getOrCreateStore(10);
    store.registerChild('sess-1', 'parent-1');
    expect(store.getChild('sess-1')).toEqual({ parentSessionId: 'parent-1' });
    expect(store.getChild('sess-x')).toBeUndefined();
  });
});

describe('appendEvent / getEvents', () => {
  it('assigns sequential ids and targetId', () => {
    const store = getOrCreateStore(10);
    store.appendEvent('sess-1', event());
    store.appendEvent('sess-1', event({ at: 2000 }));
    const events = store.getEvents('sess-1');
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe('sess-1-1');
    expect(events[1]?.id).toBe('sess-1-2');
    expect(events[0]?.targetId).toBe('sess-1');
  });

  it('drops oldest events beyond maxEventsPerAgent (ring buffer)', () => {
    const store = getOrCreateStore(3);
    for (let i = 1; i <= 5; i += 1) {
      store.appendEvent('sess-1', event({ at: i }));
    }
    const events = store.getEvents('sess-1');
    expect(events).toHaveLength(3);
    expect(events[0]?.at).toBe(3);
    expect(events[2]?.at).toBe(5);
  });

  it('returns the latest limit entries in chronological order', () => {
    const store = getOrCreateStore(10);
    for (let i = 1; i <= 4; i += 1) {
      store.appendEvent('sess-1', event({ at: i }));
    }
    const events = store.getEvents('sess-1', 2);
    expect(events.map((e) => e.at)).toEqual([3, 4]);
  });

  it('returns empty array for unknown target', () => {
    const store = getOrCreateStore(10);
    expect(store.getEvents('nope')).toEqual([]);
  });
});

describe('linkAgent / resolveTargetKey', () => {
  it('resolves both agentId and sessionId to the session key', () => {
    const store = getOrCreateStore(10);
    store.registerChild('sess-1', 'parent-1');
    store.linkAgent('agent-1', 'sess-1');
    expect(store.resolveTargetKey('agent-1')).toBe('sess-1');
    expect(store.resolveTargetKey('sess-1')).toBe('sess-1');
    expect(store.resolveTargetKey('unknown')).toBeUndefined();
  });
});

describe('getLastAlert / recordAlert', () => {
  it('round-trips the last alert per target', () => {
    const store = getOrCreateStore(10);
    expect(store.getLastAlert('sess-1')).toBeUndefined();
    store.recordAlert('sess-1', 'key-1', 5000);
    expect(store.getLastAlert('sess-1')).toEqual({ at: 5000, evidenceKey: 'key-1' });
    store.recordAlert('sess-1', 'key-2', 6000);
    expect(store.getLastAlert('sess-1')).toEqual({ at: 6000, evidenceKey: 'key-2' });
  });

  it('is shared across getOrCreateStore calls', () => {
    getOrCreateStore(10).recordAlert('sess-1', 'key-1', 5000);
    expect(getOrCreateStore(10).getLastAlert('sess-1')).toEqual({ at: 5000, evidenceKey: 'key-1' });
  });
});

describe('FIFO agent linking', () => {
  it('pairs session-created and started events in order', () => {
    const store = getOrCreateStore(10);
    store.registerChild('sess-1');
    store.registerChild('sess-2');
    store.linkNextAgent('agent-1');
    store.linkNextAgent('agent-2');
    expect(store.resolveTargetKey('agent-1')).toBe('sess-1');
    expect(store.resolveTargetKey('agent-2')).toBe('sess-2');
  });

  it('ignores linkNextAgent when no unlinked child is pending', () => {
    const store = getOrCreateStore(10);
    store.linkNextAgent('agent-1');
    expect(store.resolveTargetKey('agent-1')).toBeUndefined();
  });
});
