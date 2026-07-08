export type AlertMode = 'main_only' | 'direct_subagent' | 'both';

export type WatchdogConfig = {
  enabled: boolean;
  rescueMessage: string;
  repeatThreshold: number;
  typecheckRepeatThreshold: number;
  idleNoProgressSec: number;
  cooldownSec: number;
  maxPreviewLines: number;
  maxEventsPerAgent: number;
  alertMode: AlertMode;
};
