import { describe, expect, it } from 'vitest';
import { detectStuck, shouldAlert } from '../src/detector.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { WatchdogEvent, WatchdogEventType } from '../src/types.ts';

const NOW = 1_000_000_000;

let seq = 0;
const ev = (
  type: WatchdogEventType,
  at: number,
  commandKey?: string,
  outputHash?: string,
): WatchdogEvent => ({
  id: `s1-${++seq}`,
  targetId: 's1',
  at,
  type,
  summary: `${type}: ${commandKey ?? ''}`,
  commandKey,
  outputHash,
});

// Three same-command results with same hash, recent activity
const repeatedResults = (commandKey: string, hash: string | ((i: number) => string)) =>
  [0, 1, 2].map((i) =>
    ev('tool_result', NOW - 10_000 + i * 1000, commandKey, typeof hash === 'string' ? hash : hash(i)),
  );

describe('detectStuck: repeated command/output', () => {
  it('flags repeated_command and repeated_output for 3x same command + same hash', () => {
    const analysis = detectStuck(repeatedResults('rg "TOKEN" src', 'h1'), DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(true);
    expect(analysis.confidence).toBe('high');
    const types = analysis.evidence.map((item) => item.type);
    expect(types).toContain('repeated_command');
    expect(types).toContain('repeated_output');
  });

  it('flags only repeated_command when hashes differ', () => {
    const analysis = detectStuck(
      repeatedResults('rg "TOKEN" src', (i) => `h${i}`),
      DEFAULT_CONFIG,
      NOW,
    );
    expect(analysis.likelyStuck).toBe(true);
    expect(analysis.confidence).toBe('medium');
    expect(analysis.evidence.map((item) => item.type)).toEqual(['repeated_command']);
  });

  it('does not flag 2x same command', () => {
    const events = repeatedResults('rg "TOKEN" src', 'h1').slice(0, 2);
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(false);
    expect(analysis.confidence).toBe('low');
    expect(analysis.evidence).toEqual([]);
  });

  it('resets command counts when an edit happens in between', () => {
    const [first, second, third] = repeatedResults('rg "TOKEN" src', 'h1');
    const events = [first, second, ev('edit', NOW - 8500, 'edit src/a.ts'), third];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(false);
  });
});

describe('detectStuck: typecheck loop', () => {
  it('flags typecheck_loop for 2x same typecheck error output', () => {
    const events = [
      ev('tool_result', NOW - 5000, 'npm run type-check', 'err1'),
      ev('tool_result', NOW - 3000, 'npm run type-check', 'err1'),
    ];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).toContain('typecheck_loop');
    expect(analysis.likelyStuck).toBe(true);
  });
});

describe('detectStuck: idle no progress', () => {
  const IDLE = DEFAULT_CONFIG.idleNoProgressSec * 1000;

  const busyNoEditEvents = (toolEventCount: number) =>
    Array.from({ length: toolEventCount }, (_, i) =>
      ev(
        i % 2 === 0 ? 'tool_call' : 'tool_result',
        NOW - IDLE - 60_000 + i * ((IDLE + 30_000) / toolEventCount),
        `cmd-${i}`,
        `h-${i}`,
      ),
    );

  it('flags idle_no_progress when tools keep running without edits', () => {
    const events = [...busyNoEditEvents(6), ev('tool_call', NOW - 30_000, 'cmd-last')];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).toContain('idle_no_progress');
  });

  it('does not flag with fewer than 5 tool events', () => {
    const events = [
      ev('tool_call', NOW - IDLE - 10_000, 'cmd-a'),
      ev('tool_result', NOW - IDLE - 9000, 'cmd-a', 'ha'),
      ev('tool_call', NOW - 30_000, 'cmd-b'),
    ];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });

  it('does not flag when the agent has gone quiet', () => {
    const events = busyNoEditEvents(6).map((event) => ({ ...event, at: event.at - 120_000 }));
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });

  it('does not flag when a recent edit shows progress', () => {
    const events = [...busyNoEditEvents(6), ev('edit', NOW - 60_000, 'edit src/a.ts'), ev('tool_call', NOW - 30_000, 'cmd-last')];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });
});

describe('detectStuck: evidenceKey and empty buffer', () => {
  it('is stable for the same input and differs across evidence sets', () => {
    const repeated = repeatedResults('rg "TOKEN" src', 'h1');
    const first = detectStuck(repeated, DEFAULT_CONFIG, NOW);
    const second = detectStuck(repeated, DEFAULT_CONFIG, NOW);
    const other = detectStuck(repeatedResults('rg "OTHER" src', (i) => `x${i}`), DEFAULT_CONFIG, NOW);
    expect(first.evidenceKey).toBe(second.evidenceKey);
    expect(first.evidenceKey).not.toBe(other.evidenceKey);
  });

  it('returns not stuck for an empty buffer', () => {
    const analysis = detectStuck([], DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(false);
    expect(analysis.evidenceKey).toBe('');
  });
});

describe('shouldAlert', () => {
  const stuck = detectStuck(repeatedResults('rg "TOKEN" src', 'h1'), DEFAULT_CONFIG, NOW);
  const calm = detectStuck([], DEFAULT_CONFIG, NOW);
  const COOLDOWN = DEFAULT_CONFIG.cooldownSec;

  it('never alerts when not stuck', () => {
    expect(shouldAlert(undefined, calm, NOW, COOLDOWN)).toBe(false);
  });

  it('alerts when there is no previous alert', () => {
    expect(shouldAlert(undefined, stuck, NOW, COOLDOWN)).toBe(true);
  });

  it('suppresses the same evidence during cooldown', () => {
    const lastAlert = { at: NOW - 30_000, evidenceKey: stuck.evidenceKey };
    expect(shouldAlert(lastAlert, stuck, NOW, COOLDOWN)).toBe(false);
  });

  it('alerts for new evidence even during cooldown', () => {
    const lastAlert = { at: NOW - 30_000, evidenceKey: 'other-key' };
    expect(shouldAlert(lastAlert, stuck, NOW, COOLDOWN)).toBe(true);
  });

  it('alerts again after cooldown expires', () => {
    const lastAlert = { at: NOW - COOLDOWN * 1000 - 1, evidenceKey: stuck.evidenceKey };
    expect(shouldAlert(lastAlert, stuck, NOW, COOLDOWN)).toBe(true);
  });
});
