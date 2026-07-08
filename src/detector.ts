import { createHash } from 'node:crypto';
import type {
  StuckAnalysis,
  StuckEvidence,
  WatchdogConfig,
  WatchdogEvent,
} from './types.ts';

const TYPECHECK_PATTERN = /tsc|type-?check/i;
const RECENT_ACTIVITY_MS = 60_000;
const MIN_TOOL_EVENTS_FOR_IDLE = 5;

type CommandStats = {
  count: number;
  hashCounts: Map<string, number>;
};

// Count tool_result events per commandKey; an edit event resets all counts
// (progress means earlier repetition is no longer a loop signal)
const countCommands = (events: WatchdogEvent[]): Map<string, CommandStats> => {
  const stats = new Map<string, CommandStats>();
  for (const event of events) {
    if (event.type === 'edit') {
      stats.clear();
      continue;
    }
    if (event.type !== 'tool_result' || !event.commandKey) {
      continue;
    }
    const entry = stats.get(event.commandKey) ?? { count: 0, hashCounts: new Map() };
    entry.count += 1;
    if (event.outputHash) {
      entry.hashCounts.set(event.outputHash, (entry.hashCounts.get(event.outputHash) ?? 0) + 1);
    }
    stats.set(event.commandKey, entry);
  }
  return stats;
};

const maxHashCount = (entry: CommandStats): number =>
  Math.max(0, ...entry.hashCounts.values());

const detectIdleNoProgress = (
  events: WatchdogEvent[],
  config: WatchdogConfig,
  now: number,
): boolean => {
  if (events.length === 0) {
    return false;
  }
  const last = events[events.length - 1];
  if (now - last.at >= RECENT_ACTIVITY_MS) {
    return false;
  }
  const idleMs = config.idleNoProgressSec * 1000;
  const lastEdit = [...events].reverse().find((event) => event.type === 'edit');
  const progressCutoff = lastEdit ? lastEdit.at : events[0].at;
  if (lastEdit && now - lastEdit.at < idleMs) {
    return false;
  }
  if (!lastEdit && now - events[0].at < idleMs) {
    return false;
  }
  const toolEvents = events.filter(
    (event) =>
      (event.type === 'tool_call' || event.type === 'tool_result') && event.at >= progressCutoff,
  );
  return toolEvents.length >= MIN_TOOL_EVENTS_FOR_IDLE;
};

export const detectStuck = (
  events: WatchdogEvent[],
  config: WatchdogConfig,
  now: number,
): StuckAnalysis => {
  const evidence: StuckEvidence[] = [];
  const reasons: string[] = [];
  const triggers: string[] = [];

  const stats = countCommands(events);
  for (const [commandKey, entry] of stats) {
    if (entry.count >= config.repeatThreshold) {
      evidence.push({
        type: 'repeated_command',
        summary: `command repeated ${entry.count} times: ${commandKey}`,
      });
      reasons.push(`same command ran ${entry.count} times without progress`);
      triggers.push(commandKey);
      if (maxHashCount(entry) >= config.repeatThreshold) {
        evidence.push({
          type: 'repeated_output',
          summary: `identical output ${maxHashCount(entry)} times for: ${commandKey}`,
        });
        reasons.push('the repeated command keeps producing identical output');
      }
    }
    if (
      TYPECHECK_PATTERN.test(commandKey) &&
      maxHashCount(entry) >= config.typecheckRepeatThreshold
    ) {
      evidence.push({
        type: 'typecheck_loop',
        summary: `same typecheck error ${maxHashCount(entry)} times: ${commandKey}`,
      });
      reasons.push('the same typecheck error keeps recurring');
      triggers.push(commandKey);
    }
  }

  if (detectIdleNoProgress(events, config, now)) {
    evidence.push({
      type: 'idle_no_progress',
      summary: `no edit for >= ${config.idleNoProgressSec}s while tools keep running`,
    });
    reasons.push('tools keep running but nothing has been edited');
    triggers.push('idle_no_progress');
  }

  const likelyStuck = evidence.length > 0;
  const distinctTypes = new Set(evidence.map((item) => item.type)).size;
  const evidenceKey = likelyStuck
    ? createHash('sha256')
        .update(
          `${[...new Set(evidence.map((item) => item.type))].sort().join(',')}|${[...triggers].sort().join(',')}`,
        )
        .digest('hex')
        .slice(0, 16)
    : '';

  return {
    likelyStuck,
    confidence: distinctTypes >= 2 ? 'high' : distinctTypes === 1 ? 'medium' : 'low',
    reasons,
    evidence,
    evidenceKey,
  };
};

export const shouldAlert = (
  lastAlert: { at: number; evidenceKey: string } | undefined,
  analysis: StuckAnalysis,
  now: number,
  cooldownSec: number,
): boolean => {
  if (!analysis.likelyStuck) {
    return false;
  }
  if (!lastAlert) {
    return true;
  }
  const inCooldown = now - lastAlert.at < cooldownSec * 1000;
  return !(inCooldown && analysis.evidenceKey === lastAlert.evidenceKey);
};
