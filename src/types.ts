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
  | 'edit'
  | 'llm_input'
  | 'llm_output';

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
  | 'repeated_llm_input'
  | 'repeated_llm_output'
  | 'idle_no_progress';

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
  // Identical (normalized) LLM message bodies in a row to count as a loop; 0 disables
  llmRepeatThreshold: number;
  idleNoProgressSec: number;
  cooldownSec: number;
  maxPreviewLines: number;
  maxEventsPerAgent: number;
  alertMode: AlertMode;
  // Default for watchdog_steer_subagent's dryRun when the call omits it;
  // null keeps the built-in safe default (dry-run)
  steerDryRunDefault: boolean | null;
  // Show the lm-debug console below the editor with the full latest
  // sent/received LLM messages (newlines preserved, untruncated)
  debug: boolean;
};
