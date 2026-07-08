import type { WatchdogConfig } from './types.ts';
import type { WatchdogStore } from './store.ts';
import { mergeConfig } from './config.ts';
import { detectStuck, shouldAlert } from './detector.ts';

// Minimal message surface used by the checker; satisfied by ExtensionAPI
export type SendMessageLike = {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: 'steer'; triggerTurn: boolean },
  ): void;
};

// Event-driven self-check: invoked on every LLM round-trip (provider request /
// response) instead of a timer, so a loop is caught on the round-trip that
// crosses the threshold. Runs in every session (main or child); each session
// checks its own buffer and steers itself.
export const createStuckChecker = (
  pi: SendMessageLike,
  store: WatchdogStore,
  sessionId: string,
  config: WatchdogConfig,
): (() => void) => {
  return () => {
    if (store.isPaused()) {
      return;
    }
    const effective = mergeConfig(config, store.getConfigOverride());
    if (!effective.enabled) {
      return;
    }
    const now = Date.now();
    const lastAlert = store.getLastAlert(sessionId);
    const analysis = detectStuck(store.getEvents(sessionId), effective, now, lastAlert?.at ?? 0);
    if (!analysis.likelyStuck) {
      return;
    }
    if (!shouldAlert(lastAlert, analysis, now, effective.cooldownSec)) {
      return;
    }
    const rescueMessage = store.getRescueMessage() ?? effective.rescueMessage;
    pi.sendMessage(
      {
        customType: 'watchdog-alert',
        content: `[Watchdog] ${rescueMessage}\nReasons: ${analysis.reasons.join('; ')}`,
        display: true,
      },
      // 'steer' is delivered after the current tool calls, before the next LLM
      // call; 'nextTurn' would wait for a user prompt that never comes in a loop
      { deliverAs: 'steer', triggerTurn: true },
    );
    store.recordAlert(sessionId, analysis.evidenceKey, now);
  };
};
