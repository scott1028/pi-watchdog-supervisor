import type { WatchdogConfig } from './types.ts';

export type SessionState = {
  isPaused: () => boolean;
  pause: () => void;
  resume: () => void;
  setRescueMessage: (message: string) => void;
  getEffectiveRescueMessage: (config: WatchdogConfig) => string;
};

export const createSessionState = (): SessionState => {
  let paused = false;
  let rescueMessageOverride: string | undefined;
  return {
    isPaused: () => paused,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    setRescueMessage: (message) => {
      rescueMessageOverride = message;
    },
    getEffectiveRescueMessage: (config) => rescueMessageOverride ?? config.rescueMessage,
  };
};
