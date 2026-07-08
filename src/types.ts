export type AlertMode = 'main_only' | 'direct_subagent' | 'both';

export type TargetKind = 'task' | 'watchdog' | 'unknown';

export type TargetStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'steered'
  | 'aborted'
  | 'stopped'
  | 'error';

export type WatchdogTarget = {
  id: string;
  name?: string;
  kind: TargetKind;
  status: TargetStatus;
  toolCallCount: number;
  createdAt: number;
  lastActiveAt: number;
};

export type WatchdogEventType =
  | 'subagent_created'
  | 'subagent_started'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'tool_call'
  | 'tool_result'
  | 'edit';

export type WatchdogEvent = {
  id: string;
  targetId: string;
  at: number;
  type: WatchdogEventType;
  summary: string;
  commandKey?: string;
  outputHash?: string;
  outputPreview?: string;
};

export type StuckEvidenceType =
  | 'repeated_command'
  | 'repeated_output'
  | 'idle_no_progress'
  | 'typecheck_loop';

export type StuckEvidence = {
  type: StuckEvidenceType;
  summary: string;
};

export type StuckAnalysis = {
  likelyStuck: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
  evidence: StuckEvidence[];
  evidenceKey: string;
};

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
