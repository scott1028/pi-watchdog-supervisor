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

// N consecutive llm events of one type with configurable body hashes
const llmRun = (
  type: 'llm_input' | 'llm_output',
  count: number,
  hash: string | ((i: number) => string),
) =>
  Array.from({ length: count }, (_, i) =>
    ev(type, NOW - 10_000 + i * 1000, type, typeof hash === 'string' ? hash : hash(i)),
  );

describe('detectStuck: repeated llm messages', () => {
  it('flags repeated_llm_output for 3x identical normalized output body', () => {
    const analysis = detectStuck(llmRun('llm_output', 3, 'body-1'), DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(true);
    expect(analysis.confidence).toBe('medium');
    expect(analysis.evidence.map((item) => item.type)).toEqual(['repeated_llm_output']);
  });

  it('flags repeated_llm_input for 3x identical input body', () => {
    const analysis = detectStuck(llmRun('llm_input', 3, 'body-1'), DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).toEqual(['repeated_llm_input']);
  });

  it('flags both types with high confidence when input and output both loop', () => {
    const events = [0, 1, 2].flatMap((i) => [
      ev('llm_input', NOW - 10_000 + i * 2000, 'llm_input', 'in-same'),
      ev('llm_output', NOW - 9000 + i * 2000, 'llm_output', 'out-same'),
    ]);
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(true);
    expect(analysis.confidence).toBe('high');
  });

  it('does not flag 2x identical body', () => {
    const analysis = detectStuck(llmRun('llm_output', 2, 'body-1'), DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(false);
    expect(analysis.evidence).toEqual([]);
  });

  it('does not flag when bodies differ', () => {
    const analysis = detectStuck(llmRun('llm_output', 5, (i) => `body-${i}`), DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(false);
  });

  it('requires the repeats to be consecutive', () => {
    const events = [
      ...llmRun('llm_output', 2, 'body-1'),
      ev('llm_output', NOW - 7000, 'llm_output', 'body-other'),
      ev('llm_output', NOW - 6000, 'llm_output', 'body-1'),
    ];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(false);
  });

  it('resets the counter via sinceAt: only events after the last alert count', () => {
    const events = llmRun('llm_output', 5, 'body-1');
    // alert happened after the 3rd event → only 2 remain countable
    const sinceAt = events[2].at;
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW, sinceAt);
    expect(analysis.likelyStuck).toBe(false);
    // three more repeats after the alert → triggers again
    const more = [...events, ...llmRun('llm_output', 1, 'body-1').map((e) => ({ ...e, at: NOW - 1000 }))];
    expect(detectStuck(more, DEFAULT_CONFIG, NOW, sinceAt).likelyStuck).toBe(true);
  });

  it('counts the full buffer when sinceAt is omitted', () => {
    const analysis = detectStuck(llmRun('llm_output', 3, 'body-1'), DEFAULT_CONFIG, NOW);
    expect(analysis.likelyStuck).toBe(true);
  });

  it('ignores interleaved tool events when counting the run', () => {
    const events = [0, 1, 2].flatMap((i) => [
      ev('llm_output', NOW - 10_000 + i * 2000, 'llm_output', 'out-same'),
      ev('tool_result', NOW - 9500 + i * 2000, 'edit src/a.ts', `tool-${i}`),
      ev('edit', NOW - 9200 + i * 2000, 'edit src/a.ts'),
    ]);
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).toEqual(['repeated_llm_output']);
  });
});

describe('detectStuck: idle no progress', () => {
  // R4 is disabled by default (idleNoProgressSec: 0); enable it for these tests
  const IDLE_CONFIG = { ...DEFAULT_CONFIG, idleNoProgressSec: 300 };
  const IDLE = IDLE_CONFIG.idleNoProgressSec * 1000;

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
    const analysis = detectStuck(events, IDLE_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).toContain('idle_no_progress');
  });

  it('does not flag with fewer than 5 tool events', () => {
    const events = [
      ev('tool_call', NOW - IDLE - 10_000, 'cmd-a'),
      ev('tool_result', NOW - IDLE - 9000, 'cmd-a', 'ha'),
      ev('tool_call', NOW - 30_000, 'cmd-b'),
    ];
    const analysis = detectStuck(events, IDLE_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });

  it('does not flag when the agent has gone quiet', () => {
    const events = busyNoEditEvents(6).map((event) => ({ ...event, at: event.at - 120_000 }));
    const analysis = detectStuck(events, IDLE_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });

  it('does not flag when a recent edit shows progress', () => {
    const events = [...busyNoEditEvents(6), ev('edit', NOW - 60_000, 'edit src/a.ts'), ev('tool_call', NOW - 30_000, 'cmd-last')];
    const analysis = detectStuck(events, IDLE_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });

  it('is disabled when idleNoProgressSec is 0 (the default)', () => {
    const events = [...busyNoEditEvents(6), ev('tool_call', NOW - 30_000, 'cmd-last')];
    const analysis = detectStuck(events, DEFAULT_CONFIG, NOW);
    expect(analysis.evidence.map((item) => item.type)).not.toContain('idle_no_progress');
  });
});

describe('detectStuck: zero thresholds disable rules', () => {
  it('never flags llm repetition when llmRepeatThreshold is 0', () => {
    const config = { ...DEFAULT_CONFIG, llmRepeatThreshold: 0 };
    const analysis = detectStuck(llmRun('llm_output', 5, 'body-1'), config, NOW);
    expect(analysis.likelyStuck).toBe(false);
    expect(analysis.evidence).toEqual([]);
  });
});

describe('detectStuck: evidenceKey and empty buffer', () => {
  it('is stable for the same input and differs across evidence sets', () => {
    const repeated = llmRun('llm_output', 3, 'body-1');
    const first = detectStuck(repeated, DEFAULT_CONFIG, NOW);
    const second = detectStuck(repeated, DEFAULT_CONFIG, NOW);
    const other = detectStuck(llmRun('llm_input', 3, 'body-2'), DEFAULT_CONFIG, NOW);
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
  const stuck = detectStuck(llmRun('llm_output', 3, 'body-1'), DEFAULT_CONFIG, NOW);
  const calm = detectStuck([], DEFAULT_CONFIG, NOW);
  const COOLDOWN = 60;

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

  it('treats cooldownSec -1 as infinite: same evidence alerts only once', () => {
    const lastAlert = { at: NOW - 999_999_999, evidenceKey: stuck.evidenceKey };
    expect(shouldAlert(lastAlert, stuck, NOW, -1)).toBe(false);
  });

  it('still alerts for new evidence when cooldownSec is -1', () => {
    const lastAlert = { at: NOW - 30_000, evidenceKey: 'other-key' };
    expect(shouldAlert(lastAlert, stuck, NOW, -1)).toBe(true);
  });

  it('treats cooldownSec 0 (the default) as no cooldown: same evidence alerts every time', () => {
    const lastAlert = { at: NOW - 1, evidenceKey: stuck.evidenceKey };
    expect(shouldAlert(lastAlert, stuck, NOW, 0)).toBe(true);
    expect(shouldAlert(lastAlert, stuck, NOW, DEFAULT_CONFIG.cooldownSec)).toBe(true);
  });
});
