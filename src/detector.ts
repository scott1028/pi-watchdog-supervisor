import { createHash } from 'node:crypto';
import type {
  StuckAnalysis,
  StuckEvidence,
  WatchdogConfig,
  WatchdogEvent,
} from './types.ts';

const RECENT_ACTIVITY_MS = 60_000;
const MIN_TOOL_EVENTS_FOR_IDLE = 5;

// Longest run of consecutive identical normalized-body hashes among events of
// one LLM type, ignoring events at or before sinceAt. Consecutive (rather than
// total) keeps ordinary re-visits of an earlier message from counting as a
// loop; sinceAt resets the counter after an alert so a historical run does not
// keep re-triggering once the agent has recovered.
const longestIdenticalRun = (
  events: WatchdogEvent[],
  type: 'llm_input' | 'llm_output',
  sinceAt: number,
): { length: number; hash?: string } => {
  let best = 0;
  let bestHash: string | undefined;
  let current = 0;
  let currentHash: string | undefined;
  for (const event of events) {
    if (event.type !== type || !event.outputHash || event.at <= sinceAt) {
      continue;
    }
    current = event.outputHash === currentHash ? current + 1 : 1;
    currentHash = event.outputHash;
    if (current > best) {
      best = current;
      bestHash = currentHash;
    }
  }
  return { length: best, hash: bestHash };
};

const detectIdleNoProgress = (
  events: WatchdogEvent[],
  config: WatchdogConfig,
  now: number,
): boolean => {
  // idleNoProgressSec <= 0 disables this rule
  if (config.idleNoProgressSec <= 0 || events.length === 0) {
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
  // Only events after this timestamp count toward llm repetition — pass the
  // last alert time so the counter resets after each alert
  sinceAt = 0,
): StuckAnalysis => {
  const evidence: StuckEvidence[] = [];
  const reasons: string[] = [];
  const triggers: string[] = [];

  // LLM-level repetition: same normalized message body (timestamps, ids and
  // digit runs stripped) recurring back-to-back. llmRepeatThreshold <= 0
  // disables this rule.
  if (config.llmRepeatThreshold > 0) {
    const rules = [
      { type: 'llm_input', evidenceType: 'repeated_llm_input', label: 'input sent to the LLM' },
      { type: 'llm_output', evidenceType: 'repeated_llm_output', label: 'LLM output' },
    ] as const;
    for (const rule of rules) {
      const run = longestIdenticalRun(events, rule.type, sinceAt);
      if (run.length >= config.llmRepeatThreshold && run.hash) {
        evidence.push({
          type: rule.evidenceType,
          summary: `llm message repeated ${run.length} times: same ${rule.label} body (hash ${run.hash.slice(0, 8)})`,
        });
        reasons.push(`the same ${rule.label} recurred ${run.length} times in a row`);
        triggers.push(`${rule.type}:${run.hash}`);
      }
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
  // cooldownSec === 0: no cooldown, alert on every check that meets the threshold
  if (cooldownSec === 0) {
    return true;
  }
  // cooldownSec < 0: infinite cooldown, same evidence alerts only once
  const inCooldown = cooldownSec < 0 || now - lastAlert.at < cooldownSec * 1000;
  return !(inCooldown && analysis.evidenceKey === lastAlert.evidenceKey);
};
