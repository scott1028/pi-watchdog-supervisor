import type { WatchdogConfig, WatchdogEvent } from './types.ts';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertSink = (message: string, severity: AlertSeverity) => void;

export type WatchdogStore = {
  registerChild: (sessionId: string, parentSessionId?: string) => void;
  getChild: (sessionId: string) => { parentSessionId?: string } | undefined;
  linkAgent: (agentId: string, sessionId: string) => void;
  linkNextAgent: (agentId: string) => void;
  resolveTargetKey: (idOrSessionId: string) => string | undefined;
  resolveAgentId: (idOrSessionId: string) => string | undefined;
  appendEvent: (sessionId: string, event: Omit<WatchdogEvent, 'id' | 'targetId'>) => void;
  getEvents: (sessionId: string, limit?: number) => WatchdogEvent[];
  getLastAlert: (targetId: string) => { at: number; evidenceKey: string } | undefined;
  recordAlert: (targetId: string, evidenceKey: string, at: number) => void;
  isPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  getRescueMessage: () => string | undefined;
  setRescueMessage: (message: string) => void;
  getConfigOverride: () => Partial<WatchdogConfig>;
  setConfigOverride: (override: Partial<WatchdogConfig>) => void;
  setAlertSink: (sink: AlertSink) => void;
  alert: (message: string, severity: AlertSeverity) => boolean;
};

// Shared across all extension instances in this process (parent and child sessions)
const STORE_KEY = Symbol.for('pi-watchdog-supervisor:store');

const createStore = (maxEventsPerAgent: number): WatchdogStore => {
  const children = new Map<string, { parentSessionId?: string }>();
  const agentToSession = new Map<string, string>();
  const buffers = new Map<string, WatchdogEvent[]>();
  const seqs = new Map<string, number>();
  const alerts = new Map<string, { at: number; evidenceKey: string }>();
  // FIFO of child sessionIds not yet linked to an agent id.
  // Heuristic: session-created and started fire adjacently per spawn (in-process,
  // synchronous), so pairing oldest-unlinked-first is correct for serialized
  // assembly. A mismatch only affects display linkage, not event collection.
  const unlinked: string[] = [];
  // Runtime policy shared across parent and child instances
  let paused = false;
  let rescueMessage: string | undefined;
  let configOverride: Partial<WatchdogConfig> = {};
  let alertSink: AlertSink | undefined;

  return {
    registerChild: (sessionId, parentSessionId) => {
      children.set(sessionId, { parentSessionId });
      unlinked.push(sessionId);
    },
    getChild: (sessionId) => children.get(sessionId),
    linkAgent: (agentId, sessionId) => {
      agentToSession.set(agentId, sessionId);
      const index = unlinked.indexOf(sessionId);
      if (index !== -1) {
        unlinked.splice(index, 1);
      }
    },
    linkNextAgent: (agentId) => {
      const sessionId = unlinked.shift();
      if (sessionId) {
        agentToSession.set(agentId, sessionId);
      }
    },
    resolveTargetKey: (idOrSessionId) => {
      if (children.has(idOrSessionId) || buffers.has(idOrSessionId)) {
        return idOrSessionId;
      }
      return agentToSession.get(idOrSessionId);
    },
    resolveAgentId: (idOrSessionId) => {
      if (agentToSession.has(idOrSessionId)) {
        return idOrSessionId;
      }
      for (const [agentId, sessionId] of agentToSession) {
        if (sessionId === idOrSessionId) {
          return agentId;
        }
      }
      return undefined;
    },
    appendEvent: (sessionId, event) => {
      const seq = (seqs.get(sessionId) ?? 0) + 1;
      seqs.set(sessionId, seq);
      const buffer = buffers.get(sessionId) ?? [];
      buffer.push({ ...event, id: `${sessionId}-${seq}`, targetId: sessionId });
      if (buffer.length > maxEventsPerAgent) {
        buffer.splice(0, buffer.length - maxEventsPerAgent);
      }
      buffers.set(sessionId, buffer);
    },
    getEvents: (sessionId, limit) => {
      const buffer = buffers.get(sessionId) ?? [];
      return limit === undefined ? [...buffer] : buffer.slice(-limit);
    },
    getLastAlert: (targetId) => alerts.get(targetId),
    recordAlert: (targetId, evidenceKey, at) => {
      alerts.set(targetId, { at, evidenceKey });
    },
    isPaused: () => paused,
    setPaused: (next) => {
      paused = next;
    },
    getRescueMessage: () => rescueMessage,
    setRescueMessage: (message) => {
      rescueMessage = message;
    },
    getConfigOverride: () => ({ ...configOverride }),
    setConfigOverride: (override) => {
      configOverride = { ...configOverride, ...override };
    },
    setAlertSink: (sink) => {
      alertSink = sink;
    },
    alert: (message, severity) => {
      if (!alertSink) {
        return false;
      }
      alertSink(message, severity);
      return true;
    },
  };
};

export const getOrCreateStore = (maxEventsPerAgent: number): WatchdogStore => {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[STORE_KEY]) {
    holder[STORE_KEY] = createStore(maxEventsPerAgent);
  }
  return holder[STORE_KEY] as WatchdogStore;
};

export const resetStoreForTest = (): void => {
  delete (globalThis as Record<symbol, unknown>)[STORE_KEY];
};
