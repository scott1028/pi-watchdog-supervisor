import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createSessionState } from '../src/state.ts';

describe('createSessionState', () => {
  it('starts unpaused without rescue message override', () => {
    const state = createSessionState();
    expect(state.isPaused()).toBe(false);
    expect(state.getEffectiveRescueMessage(DEFAULT_CONFIG)).toBe(
      DEFAULT_CONFIG.rescueMessage,
    );
  });

  it('toggles paused via pause() and resume()', () => {
    const state = createSessionState();
    state.pause();
    expect(state.isPaused()).toBe(true);
    state.resume();
    expect(state.isPaused()).toBe(false);
  });

  it('prefers the session rescue message override over config', () => {
    const state = createSessionState();
    state.setRescueMessage('custom message');
    expect(state.getEffectiveRescueMessage(DEFAULT_CONFIG)).toBe('custom message');
  });
});
