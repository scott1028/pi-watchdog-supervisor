import type { SubagentRecordLike } from '../registry.ts';

export type SubagentsIntegration =
  | { available: true; listAgents: () => SubagentRecordLike[] }
  | { available: false; reason: string };

// Lifecycle channels emitted by @gotgenes/pi-subagents on pi.events
export const SUBAGENT_EVENT_CHANNELS = [
  'subagents:created',
  'subagents:started',
  'subagents:completed',
  'subagents:failed',
  'subagents:steered',
  'subagents:compacted',
] as const;

type ServiceLike = { listAgents: () => SubagentRecordLike[] };

export const connectSubagents = async (): Promise<SubagentsIntegration> => {
  let getService: (() => ServiceLike | undefined) | undefined;
  try {
    const mod = (await import('@gotgenes/pi-subagents')) as {
      getSubagentsService?: () => ServiceLike | undefined;
    };
    getService = mod.getSubagentsService;
  } catch {
    return { available: false, reason: '@gotgenes/pi-subagents is not installed' };
  }
  const service = getService?.();
  if (!service) {
    return { available: false, reason: 'subagents service not published (extension not loaded?)' };
  }
  return { available: true, listAgents: () => service.listAgents() };
};
