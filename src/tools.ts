import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mergeConfig, pickKnownConfig } from './config.ts';
import { detectStuck, shouldAlert } from './detector.ts';
import type { AlertSeverity, WatchdogStore } from './store.ts';
import type { TargetRegistry } from './registry.ts';
import type { SubagentsIntegration } from './integrations/gotgenes-subagents.ts';
import type { StuckAnalysis, WatchdogConfig, WatchdogEvent } from './types.ts';

export type ToolDeps = {
  store: WatchdogStore;
  registry: TargetRegistry;
  getIntegration: () => Promise<SubagentsIntegration>;
  baseConfig: WatchdogConfig;
  now: () => number;
};

const TERMINAL_STATUSES = new Set(['completed', 'aborted', 'stopped', 'error']);

const effectiveConfig = (deps: ToolDeps): WatchdogConfig =>
  mergeConfig(deps.baseConfig, deps.store.getConfigOverride());

const effectiveRescueMessage = (deps: ToolDeps): string =>
  deps.store.getRescueMessage() ?? effectiveConfig(deps).rescueMessage;

const analyzeTarget = (deps: ToolDeps, targetKey: string): StuckAnalysis =>
  detectStuck(deps.store.getEvents(targetKey), effectiveConfig(deps), deps.now());

// Pull the repeat count out of the repeated_command evidence summary
const repeatedCommandCount = (analysis: StuckAnalysis): number => {
  const summary = analysis.evidence.find((item) => item.type === 'repeated_command')?.summary;
  const match = summary?.match(/repeated (\d+) times/);
  return match ? Number(match[1]) : 0;
};

export const executeListTargets = async (
  deps: ToolDeps,
  input: { includeCompleted?: boolean },
): Promise<string> => {
  const integration = await deps.getIntegration();
  if (!integration.available) {
    return `targets unavailable: ${integration.reason}`;
  }
  deps.registry.syncFromRecords(integration.listAgents());
  const targets = deps.registry
    .list()
    .filter((target) => input.includeCompleted === true || !TERMINAL_STATUSES.has(target.status))
    .map((target) => {
      const key = deps.store.resolveTargetKey(target.id);
      const analysis = key ? analyzeTarget(deps, key) : undefined;
      return {
        id: target.id,
        name: target.name,
        kind: target.kind,
        status: target.status,
        lastActiveAt: new Date(target.lastActiveAt).toISOString(),
        toolCallCount: target.toolCallCount,
        patchCount: key
          ? deps.store.getEvents(key).filter((event) => event.type === 'edit').length
          : 0,
        repeatedCommandCount: analysis ? repeatedCommandCount(analysis) : 0,
        likelyStuck: analysis?.likelyStuck ?? false,
      };
    });
  return JSON.stringify({ targets }, null, 2);
};

export const executeReadEvents = (
  deps: ToolDeps,
  input: { targetId: string; limit?: number },
): string => {
  const key = deps.store.resolveTargetKey(input.targetId);
  if (!key) {
    return `Unknown target: ${input.targetId}`;
  }
  const events = deps.store.getEvents(key, input.limit ?? 50);
  return JSON.stringify({ targetId: key, events }, null, 2);
};

export const executeDetectStuck = (deps: ToolDeps, input: { targetId: string }): string => {
  const key = deps.store.resolveTargetKey(input.targetId);
  if (!key) {
    return `Unknown target: ${input.targetId}`;
  }
  const analysis = analyzeTarget(deps, key);
  return JSON.stringify(
    {
      targetId: key,
      likelyStuck: analysis.likelyStuck,
      confidence: analysis.confidence,
      reasons: analysis.reasons,
      evidence: analysis.evidence,
      evidenceKey: analysis.evidenceKey,
      suggestedRescueMessage: effectiveRescueMessage(deps),
    },
    null,
    2,
  );
};

export const formatAlert = (
  targetId: string,
  analysis: Pick<StuckAnalysis, 'likelyStuck' | 'confidence' | 'evidence'>,
  events: WatchdogEvent[],
  note: string,
  rescueMessage?: string,
): string => {
  const lastCommand = [...events].reverse().find((event) => event.commandKey)?.commandKey;
  const evidenceLines =
    analysis.evidence.length > 0
      ? analysis.evidence.map((item) => `- ${item.summary}`).join('\n')
      : '- (no deterministic evidence; reported by watchdog agent)';
  return [
    '[Watchdog Alert]',
    '',
    `Target: ${targetId}`,
    `Status: ${analysis.likelyStuck ? 'likely stuck' : 'reported by watchdog'}`,
    `Confidence: ${analysis.confidence}`,
    '',
    'Evidence:',
    evidenceLines,
    '',
    'Note:',
    note,
    '',
    'Last command:',
    lastCommand ?? '(none recorded)',
    '',
    'Suggested rescue:',
    rescueMessage ?? '',
  ].join('\n');
};

export const executeAlertMain = (
  deps: ToolDeps,
  input: { targetId: string; message: string; severity?: AlertSeverity },
): string => {
  if (deps.store.isPaused()) {
    return 'alert suppressed (watchdog paused)';
  }
  const key = deps.store.resolveTargetKey(input.targetId) ?? input.targetId;
  const config = effectiveConfig(deps);
  const now = deps.now();
  const analysis = analyzeTarget(deps, key);
  if (
    analysis.likelyStuck &&
    !shouldAlert(deps.store.getLastAlert(key), analysis, now, config.cooldownSec)
  ) {
    return 'alert suppressed (cooldown)';
  }
  const alert = formatAlert(
    key,
    analysis,
    deps.store.getEvents(key),
    input.message,
    effectiveRescueMessage(deps),
  );
  if (!deps.store.alert(alert, input.severity ?? 'warning')) {
    return 'alert failed: no alert sink registered (is the main session running this extension?)';
  }
  if (analysis.likelyStuck) {
    deps.store.recordAlert(key, analysis.evidenceKey, now);
  }
  return `alert sent to main session (severity=${input.severity ?? 'warning'})`;
};

export const executeSteerSubagent = async (
  deps: ToolDeps,
  input: { targetId: string; message?: string; dryRun?: boolean },
): Promise<string> => {
  const message = input.message ?? effectiveRescueMessage(deps);
  if (input.dryRun !== false) {
    return `dry-run: would steer ${input.targetId} with:\n${message}`;
  }
  const config = effectiveConfig(deps);
  if (config.alertMode === 'main_only') {
    return `steer refused: alertMode is main_only — update config (alertMode: direct_subagent or both) to allow direct steering`;
  }
  const agentId = deps.store.resolveAgentId(input.targetId);
  if (!agentId) {
    return `Unknown target: ${input.targetId} (no linked agent id)`;
  }
  const integration = await deps.getIntegration();
  if (!integration.available) {
    return `steer unavailable: ${integration.reason}`;
  }
  const ok = await integration.steer(agentId, message);
  return ok ? `steered ${agentId} with rescue message` : `steer failed for ${agentId}`;
};

export const executeConfig = (
  deps: ToolDeps,
  input: { action: 'get' | 'set'; config?: Partial<WatchdogConfig> },
): string => {
  if (input.action === 'set') {
    deps.store.setConfigOverride(pickKnownConfig((input.config ?? {}) as Record<string, unknown>));
  }
  return JSON.stringify(effectiveConfig(deps), null, 2);
};

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: undefined });

export const registerWatchdogTools = (pi: ExtensionAPI, deps: ToolDeps) => {
  pi.registerTool({
    name: 'watchdog_list_targets',
    label: 'Watchdog: list targets',
    description:
      'List sub-agents visible to the watchdog with status and stuck signals. Completed agents are excluded unless includeCompleted is true.',
    parameters: Type.Object({
      includeCompleted: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params) => text(await executeListTargets(deps, params)),
  });

  pi.registerTool({
    name: 'watchdog_read_events',
    label: 'Watchdog: read events',
    description: 'Read compact recent events (commands, output hashes, edits) for one target.',
    parameters: Type.Object({
      targetId: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params) => text(executeReadEvents(deps, params)),
  });

  pi.registerTool({
    name: 'watchdog_detect_stuck',
    label: 'Watchdog: detect stuck',
    description:
      'Run deterministic stuck analysis for one target: repeated commands/output, typecheck loops, idle without progress.',
    parameters: Type.Object({
      targetId: Type.String(),
    }),
    execute: async (_id, params) => text(executeDetectStuck(deps, params)),
  });

  pi.registerTool({
    name: 'watchdog_alert_main',
    label: 'Watchdog: alert main session',
    description:
      'Send a compact stuck alert to the main agent session. Respects pause state and per-target cooldown.',
    parameters: Type.Object({
      targetId: Type.String(),
      message: Type.String(),
      severity: Type.Optional(
        Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('critical')]),
      ),
    }),
    execute: async (_id, params) => text(executeAlertMain(deps, params)),
  });

  pi.registerTool({
    name: 'watchdog_steer_subagent',
    label: 'Watchdog: steer sub-agent',
    description:
      'Send a rescue message to a target sub-agent. Defaults to dry-run; real steering requires alertMode other than main_only.',
    parameters: Type.Object({
      targetId: Type.String(),
      message: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params) => text(await executeSteerSubagent(deps, params)),
  });

  pi.registerTool({
    name: 'watchdog_config',
    label: 'Watchdog: config',
    description: 'Read or update the watchdog policy (thresholds, cooldown, alertMode, rescue message).',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('get'), Type.Literal('set')]),
      config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: async (_id, params) =>
      text(
        executeConfig(deps, {
          action: params.action,
          config: params.config as Partial<WatchdogConfig> | undefined,
        }),
      ),
  });
};
