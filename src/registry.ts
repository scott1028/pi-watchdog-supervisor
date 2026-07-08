import type { TargetKind, TargetStatus, WatchdogTarget } from './types.ts';

// Local structural type for @gotgenes/pi-subagents records; no direct type import (adapter isolation)
export type SubagentRecordLike = {
  id: string;
  type: string;
  description: string;
  status: TargetStatus;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
};

const TARGET_STATUSES: readonly TargetStatus[] = [
  'queued',
  'running',
  'completed',
  'steered',
  'aborted',
  'stopped',
  'error',
];

const isTargetStatus = (value: unknown): value is TargetStatus =>
  TARGET_STATUSES.includes(value as TargetStatus);

export const classifyKind = (type?: string, description?: string): TargetKind => {
  if (!type && !description) {
    return 'unknown';
  }
  const haystack = `${type ?? ''} ${description ?? ''}`.toLowerCase();
  return haystack.includes('watchdog') ? 'watchdog' : 'task';
};

export const toWatchdogTarget = (record: SubagentRecordLike): WatchdogTarget => ({
  id: record.id,
  name: record.description,
  kind: classifyKind(record.type, record.description),
  status: record.status,
  toolCallCount: record.toolUses,
  createdAt: record.startedAt,
  lastActiveAt: record.completedAt ?? record.startedAt,
});

// Status implied by each lifecycle channel; steered/compacted only refresh activity
const CHANNEL_STATUS: Record<string, TargetStatus | undefined> = {
  'subagents:created': 'queued',
  'subagents:started': 'running',
  'subagents:completed': 'completed',
  'subagents:failed': 'error',
  'subagents:steered': undefined,
  'subagents:compacted': undefined,
};

export const applyEvent = (
  targets: Map<string, WatchdogTarget>,
  channel: string,
  payload: unknown,
  now: number,
): Map<string, WatchdogTarget> => {
  if (typeof payload !== 'object' || payload === null) {
    return targets;
  }
  const data = payload as Record<string, unknown>;
  if (typeof data.id !== 'string') {
    return targets;
  }
  const existing = targets.get(data.id);
  const payloadStatus = isTargetStatus(data.status) ? data.status : undefined;
  const status = payloadStatus ?? CHANNEL_STATUS[channel] ?? existing?.status ?? 'queued';
  const base: WatchdogTarget = existing ?? {
    id: data.id,
    name: typeof data.description === 'string' ? data.description : undefined,
    kind: classifyKind(
      typeof data.type === 'string' ? data.type : undefined,
      typeof data.description === 'string' ? data.description : undefined,
    ),
    status,
    toolCallCount: 0,
    createdAt: now,
    lastActiveAt: now,
  };
  const next = new Map(targets);
  next.set(data.id, { ...base, status, lastActiveAt: now });
  return next;
};

export const syncFromRecords = (
  targets: Map<string, WatchdogTarget>,
  records: SubagentRecordLike[],
): Map<string, WatchdogTarget> => {
  const next = new Map(targets);
  for (const record of records) {
    const mapped = toWatchdogTarget(record);
    const existing = next.get(record.id);
    next.set(record.id, {
      ...mapped,
      lastActiveAt: Math.max(mapped.lastActiveAt, existing?.lastActiveAt ?? 0),
    });
  }
  return next;
};

export type TargetRegistry = {
  applyEvent: (channel: string, payload: unknown, now: number) => void;
  syncFromRecords: (records: SubagentRecordLike[]) => void;
  list: () => WatchdogTarget[];
};

export const createTargetRegistry = (): TargetRegistry => {
  let targets = new Map<string, WatchdogTarget>();
  return {
    applyEvent: (channel, payload, now) => {
      targets = applyEvent(targets, channel, payload, now);
    },
    syncFromRecords: (records) => {
      targets = syncFromRecords(targets, records);
    },
    list: () => [...targets.values()],
  };
};
