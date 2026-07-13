import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { getOrCreateStore, resetStoreForTest } from '../src/store.ts';
import { createStuckChecker, type SendMessageLike } from '../src/checker.ts';

const SESSION = 'sess-main';

type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };

const makePi = (sent: SentMessage[]): SendMessageLike => ({
  sendMessage: (message, options) => {
    sent.push({ message: message as Record<string, unknown>, options: options as Record<string, unknown> });
  },
});

const feedRepeatedResults = (
  store: ReturnType<typeof getOrCreateStore>,
  times: number,
  baseAt = Date.now() - times * 1000,
) => {
  for (let i = 0; i < times; i += 1) {
    store.appendEvent(SESSION, {
      at: baseAt + i * 1000,
      type: 'llm_output',
      summary: 'llm_output: same body',
      commandKey: 'llm_output',
      outputHash: 'hash-same',
    });
  }
};

describe('createStuckChecker', () => {
  afterEach(() => {
    resetStoreForTest();
  });

  it('sends a steer rescue message when stuck is detected', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold);
    const check = createStuckChecker(makePi(sent), store, SESSION, DEFAULT_CONFIG);
    check();
    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).toContain(DEFAULT_CONFIG.rescueMessage);
    expect(sent[0].options.deliverAs).toBe('steer');
  });

  it('resets the counter after an alert: no re-alert until the loop repeats again', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold);
    const check = createStuckChecker(makePi(sent), store, SESSION, DEFAULT_CONFIG);
    check();
    expect(sent).toHaveLength(1);
    // no new events: the historical run is excluded by the alert cutoff
    check();
    expect(sent).toHaveLength(1);
    // the loop keeps going: fresh repeats re-trigger (no cooldown by default)
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold, Date.now() + 1000);
    check();
    expect(sent).toHaveLength(2);
  });

  it('does not re-trigger within a positive cooldown even when the loop repeats', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold);
    const check = createStuckChecker(makePi(sent), store, SESSION, {
      ...DEFAULT_CONFIG,
      cooldownSec: 60,
    });
    check();
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold, Date.now() + 1000);
    check();
    expect(sent).toHaveLength(1);
  });

  it('respects the pause state', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold);
    store.setPaused(true);
    const check = createStuckChecker(makePi(sent), store, SESSION, DEFAULT_CONFIG);
    check();
    expect(sent).toHaveLength(0);
  });

  it('does nothing when the session is not stuck', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    const check = createStuckChecker(makePi(sent), store, SESSION, DEFAULT_CONFIG);
    check();
    expect(sent).toHaveLength(0);
  });

  it('does nothing when the watchdog is disabled via config', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold);
    const check = createStuckChecker(makePi(sent), store, SESSION, {
      ...DEFAULT_CONFIG,
      enabled: false,
    });
    check();
    expect(sent).toHaveLength(0);
  });

  it('prefers the runtime rescue message override', () => {
    const store = getOrCreateStore(50);
    const sent: SentMessage[] = [];
    feedRepeatedResults(store, DEFAULT_CONFIG.llmRepeatThreshold);
    store.setRescueMessage('custom rescue');
    const check = createStuckChecker(makePi(sent), store, SESSION, DEFAULT_CONFIG);
    check();
    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).toContain('custom rescue');
  });
});
