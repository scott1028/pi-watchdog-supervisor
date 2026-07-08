import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createTargetRegistry } from '../src/registry.ts';
import { getOrCreateStore, resetStoreForTest } from '../src/store.ts';
import type { SubagentsIntegration } from '../src/integrations/gotgenes-subagents.ts';
import {
  executeAlertMain,
  executeConfig,
  executeDetectStuck,
  executeListTargets,
  executeReadEvents,
  executeSteerSubagent,
  formatAlert,
  type ToolDeps,
} from '../src/tools.ts';

afterEach(() => {
  resetStoreForTest();
});

const NOW = 1_000_000;

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  type: 'Explore',
  description: 'explore stuff',
  status: 'running' as const,
  toolUses: 3,
  startedAt: NOW - 10_000,
  ...overrides,
});

const makeDeps = (overrides: Partial<ToolDeps> = {}): ToolDeps => ({
  store: getOrCreateStore(50),
  registry: createTargetRegistry(),
  getIntegration: async () => ({ available: false, reason: 'test' }),
  baseConfig: DEFAULT_CONFIG,
  now: () => NOW,
  ...overrides,
});

const availableIntegration = (
  records: ReturnType<typeof record>[],
  steered: Array<[string, string]> = [],
): SubagentsIntegration => ({
  available: true,
  listAgents: () => records,
  steer: async (id, message) => {
    steered.push([id, message]);
    return true;
  },
});

// Feed N repeated tool_result events so the detector flags repeated_command
const feedRepeatedResults = (deps: ToolDeps, sessionId: string, times: number) => {
  deps.store.registerChild(sessionId);
  for (let i = 0; i < times; i += 1) {
    deps.store.appendEvent(sessionId, {
      at: NOW - (times - i) * 1000,
      type: 'tool_result',
      summary: 'bash result',
      commandKey: 'rg "TOKEN" src',
      outputHash: 'hash-same',
    });
  }
};

describe('executeListTargets', () => {
  it('reports unavailable integration', async () => {
    const text = await executeListTargets(makeDeps(), {});
    expect(text).toContain('unavailable');
  });

  it('filters completed targets by default and includes them on request', async () => {
    const deps = makeDeps({
      getIntegration: async () =>
        availableIntegration([record(), record({ id: 'agent-2', status: 'completed' })]),
    });
    const defaultText = await executeListTargets(deps, {});
    const defaultParsed = JSON.parse(defaultText);
    expect(defaultParsed.targets).toHaveLength(1);
    expect(defaultParsed.targets[0].id).toBe('agent-1');

    const allText = await executeListTargets(deps, { includeCompleted: true });
    expect(JSON.parse(allText).targets).toHaveLength(2);
  });

  it('marks likelyStuck from buffered events', async () => {
    const deps = makeDeps({
      getIntegration: async () => availableIntegration([record()]),
    });
    feedRepeatedResults(deps, 'sess-1', 3);
    deps.store.linkAgent('agent-1', 'sess-1');
    const parsed = JSON.parse(await executeListTargets(deps, {}));
    expect(parsed.targets[0].likelyStuck).toBe(true);
    expect(parsed.targets[0].repeatedCommandCount).toBe(3);
  });
});

describe('executeReadEvents', () => {
  it('returns an error message for an unknown target', () => {
    expect(executeReadEvents(makeDeps(), { targetId: 'nope' })).toContain('Unknown target');
  });

  it('returns recent events as JSON', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 2);
    const parsed = JSON.parse(executeReadEvents(deps, { targetId: 'sess-1' }));
    expect(parsed.targetId).toBe('sess-1');
    expect(parsed.events).toHaveLength(2);
  });
});

describe('executeDetectStuck', () => {
  it('includes analysis and the suggested rescue message', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 3);
    const parsed = JSON.parse(executeDetectStuck(deps, { targetId: 'sess-1' }));
    expect(parsed.likelyStuck).toBe(true);
    expect(parsed.evidence.some((e: { type: string }) => e.type === 'repeated_command')).toBe(true);
    expect(parsed.suggestedRescueMessage).toBe(DEFAULT_CONFIG.rescueMessage);
  });

  it('prefers the shared rescue message override', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 3);
    deps.store.setRescueMessage('custom rescue');
    const parsed = JSON.parse(executeDetectStuck(deps, { targetId: 'sess-1' }));
    expect(parsed.suggestedRescueMessage).toBe('custom rescue');
  });
});

describe('executeAlertMain', () => {
  it('suppresses alerts while paused', () => {
    const deps = makeDeps();
    deps.store.setPaused(true);
    expect(executeAlertMain(deps, { targetId: 'sess-1', message: 'stuck!' })).toContain('paused');
  });

  it('delivers the alert to the sink and records it', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 3);
    const received: string[] = [];
    deps.store.setAlertSink((message) => {
      received.push(message);
    });
    const result = executeAlertMain(deps, { targetId: 'sess-1', message: 'stuck!' });
    expect(result).toContain('alert sent');
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('[Watchdog Alert]');
    expect(deps.store.getLastAlert('sess-1')).toBeDefined();
  });

  it('suppresses a repeat alert for the same evidence within cooldown', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 3);
    deps.store.setAlertSink(() => {});
    executeAlertMain(deps, { targetId: 'sess-1', message: 'stuck!' });
    const second = executeAlertMain(deps, { targetId: 'sess-1', message: 'stuck!' });
    expect(second).toContain('cooldown');
  });

  it('reports a missing sink as an error', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 3);
    expect(executeAlertMain(deps, { targetId: 'sess-1', message: 'stuck!' })).toContain('no alert sink');
  });
});

describe('executeSteerSubagent', () => {
  it('defaults to dry-run with the effective rescue message', async () => {
    const deps = makeDeps();
    deps.store.registerChild('sess-1');
    const result = await executeSteerSubagent(deps, { targetId: 'sess-1' });
    expect(result).toContain('would steer');
    expect(result).toContain(DEFAULT_CONFIG.rescueMessage);
  });

  it('refuses a real steer in main_only mode', async () => {
    const deps = makeDeps();
    deps.store.registerChild('sess-1');
    const result = await executeSteerSubagent(deps, { targetId: 'sess-1', dryRun: false });
    expect(result).toContain('main_only');
  });

  it('performs a real steer when alertMode allows it', async () => {
    const steered: Array<[string, string]> = [];
    const deps = makeDeps({
      baseConfig: { ...DEFAULT_CONFIG, alertMode: 'both' },
      getIntegration: async () => availableIntegration([record()], steered),
    });
    deps.store.registerChild('sess-1');
    deps.store.linkAgent('agent-1', 'sess-1');
    const result = await executeSteerSubagent(deps, {
      targetId: 'sess-1',
      message: 'wake up',
      dryRun: false,
    });
    expect(result).toContain('steered');
    expect(steered).toEqual([['agent-1', 'wake up']]);
  });
});

describe('executeConfig', () => {
  it('returns the effective config including overrides', () => {
    const deps = makeDeps();
    deps.store.setConfigOverride({ repeatThreshold: 7 });
    const parsed = JSON.parse(executeConfig(deps, { action: 'get' }));
    expect(parsed.repeatThreshold).toBe(7);
    expect(parsed.alertMode).toBe(DEFAULT_CONFIG.alertMode);
  });

  it('applies only known fields on set', () => {
    const deps = makeDeps();
    executeConfig(deps, {
      action: 'set',
      config: { cooldownSec: 90, bogus: true } as never,
    });
    expect(deps.store.getConfigOverride()).toEqual({ cooldownSec: 90 });
  });
});

describe('formatAlert', () => {
  it('renders the requirement §8.2 template', () => {
    const deps = makeDeps();
    feedRepeatedResults(deps, 'sess-1', 3);
    const alert = formatAlert(
      'sess-1',
      JSON.parse(executeDetectStuck(deps, { targetId: 'sess-1' })),
      deps.store.getEvents('sess-1'),
      'stuck!',
      DEFAULT_CONFIG.rescueMessage,
    );
    expect(alert).toBe(
      [
        '[Watchdog Alert]',
        '',
        'Target: sess-1',
        'Status: likely stuck',
        'Confidence: high',
        '',
        'Evidence:',
        '- command repeated 3 times: rg "TOKEN" src',
        '- identical output 3 times for: rg "TOKEN" src',
        '',
        'Note:',
        'stuck!',
        '',
        'Last command:',
        'rg "TOKEN" src',
        '',
        'Suggested rescue:',
        DEFAULT_CONFIG.rescueMessage,
      ].join('\n'),
    );
  });
});
