import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  classifyKind,
  createTargetRegistry,
  syncFromRecords,
  toWatchdogTarget,
  type SubagentRecordLike,
} from '../src/registry.ts';
import type { WatchdogTarget } from '../src/types.ts';

const record = (overrides: Partial<SubagentRecordLike> = {}): SubagentRecordLike => ({
  id: 'a1',
  type: 'Explore',
  description: 'explore campaign-list',
  status: 'running',
  toolUses: 12,
  startedAt: 1000,
  ...overrides,
});

const targetsOf = (...items: WatchdogTarget[]): Map<string, WatchdogTarget> =>
  new Map(items.map((item) => [item.id, item]));

describe('classifyKind', () => {
  it('detects watchdog by type (case-insensitive)', () => {
    expect(classifyKind('Watchdog', 'anything')).toBe('watchdog');
    expect(classifyKind('my-watchdog-agent', '')).toBe('watchdog');
  });

  it('detects watchdog by description', () => {
    expect(classifyKind('Explore', 'Watchdog supervisor for tasks')).toBe('watchdog');
  });

  it('classifies regular agents as task', () => {
    expect(classifyKind('Explore', 'fix type errors')).toBe('task');
  });

  it('returns unknown when nothing to classify', () => {
    expect(classifyKind(undefined, undefined)).toBe('unknown');
    expect(classifyKind('', '')).toBe('unknown');
  });
});

describe('toWatchdogTarget', () => {
  it('maps record fields', () => {
    const target = toWatchdogTarget(record());
    expect(target).toEqual({
      id: 'a1',
      name: 'explore campaign-list',
      kind: 'task',
      status: 'running',
      toolCallCount: 12,
      createdAt: 1000,
      lastActiveAt: 1000,
    });
  });

  it('uses completedAt as lastActiveAt when present', () => {
    const target = toWatchdogTarget(record({ status: 'completed', completedAt: 5000 }));
    expect(target.lastActiveAt).toBe(5000);
  });
});

describe('applyEvent', () => {
  it('updates status and lastActiveAt of an existing target on started', () => {
    const existing = { ...toWatchdogTarget(record({ status: 'queued' })) };
    const next = applyEvent(targetsOf(existing), 'subagents:started', { id: 'a1' }, 2000);
    expect(next.get('a1')?.status).toBe('running');
    expect(next.get('a1')?.lastActiveAt).toBe(2000);
  });

  it('creates a minimal target for an unknown id', () => {
    const next = applyEvent(
      new Map(),
      'subagents:created',
      { id: 'b2', type: 'Explore', description: 'new agent' },
      3000,
    );
    const created = next.get('b2');
    expect(created?.status).toBe('queued');
    expect(created?.kind).toBe('task');
    expect(created?.createdAt).toBe(3000);
  });

  it('takes failed status from payload when valid', () => {
    const existing = toWatchdogTarget(record());
    const next = applyEvent(
      targetsOf(existing),
      'subagents:failed',
      { id: 'a1', status: 'aborted' },
      4000,
    );
    expect(next.get('a1')?.status).toBe('aborted');
  });

  it('defaults failed status to error when payload has no valid status', () => {
    const existing = toWatchdogTarget(record());
    const next = applyEvent(targetsOf(existing), 'subagents:failed', { id: 'a1' }, 4000);
    expect(next.get('a1')?.status).toBe('error');
  });

  it('only touches lastActiveAt on steered and compacted', () => {
    const existing = toWatchdogTarget(record());
    for (const channel of ['subagents:steered', 'subagents:compacted']) {
      const next = applyEvent(targetsOf(existing), channel, { id: 'a1' }, 6000);
      expect(next.get('a1')?.status).toBe('running');
      expect(next.get('a1')?.lastActiveAt).toBe(6000);
    }
  });

  it('ignores payloads without a string id', () => {
    const existing = toWatchdogTarget(record());
    const targets = targetsOf(existing);
    expect(applyEvent(targets, 'subagents:started', {}, 2000)).toBe(targets);
    expect(applyEvent(targets, 'subagents:started', null, 2000)).toBe(targets);
  });
});

describe('syncFromRecords', () => {
  it('adds new records as targets', () => {
    const next = syncFromRecords(new Map(), [record()]);
    expect(next.get('a1')?.name).toBe('explore campaign-list');
  });

  it('keeps the newer lastActiveAt on existing targets', () => {
    const existing = { ...toWatchdogTarget(record()), lastActiveAt: 9000 };
    const next = syncFromRecords(targetsOf(existing), [record({ toolUses: 20 })]);
    expect(next.get('a1')?.lastActiveAt).toBe(9000);
    expect(next.get('a1')?.toolCallCount).toBe(20);
  });

  it('keeps targets missing from the record list', () => {
    const existing = toWatchdogTarget(record({ id: 'gone' }));
    const next = syncFromRecords(targetsOf(existing), []);
    expect(next.get('gone')).toBeDefined();
  });
});

describe('createTargetRegistry', () => {
  it('accumulates events and record syncs', () => {
    const registry = createTargetRegistry();
    registry.applyEvent('subagents:created', { id: 'a1', type: 'watchdog' }, 1000);
    registry.syncFromRecords([record({ id: 'b2' })]);
    const ids = registry.list().map((target) => target.id);
    expect(ids).toContain('a1');
    expect(ids).toContain('b2');
  });
});
