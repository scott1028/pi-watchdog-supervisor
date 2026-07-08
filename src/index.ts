import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadEffectiveConfig } from './config.ts';
import { registerWatchdogCommands } from './commands.ts';
import { createSessionState } from './state.ts';
import { createTargetRegistry } from './registry.ts';
import { getOrCreateStore } from './store.ts';
import { startCollector } from './collector.ts';
import {
  connectSubagents,
  SUBAGENT_EVENT_CHANNELS,
  type SubagentsIntegration,
} from './integrations/gotgenes-subagents.ts';

// This factory runs in the parent session AND in every child session
// (pi-subagents children always load the parent's extensions).
export default function watchdogSupervisor(pi: ExtensionAPI) {
  const { config, warnings } = loadEffectiveConfig(process.cwd());
  const state = createSessionState();
  const registry = createTargetRegistry();
  const store = getOrCreateStore(config.maxEventsPerAgent);

  // Lazy + retry: the subagents extension may publish its service after we load
  let integration: SubagentsIntegration | undefined;
  const getIntegration = async () => {
    if (!integration?.available) {
      integration = await connectSubagents();
    }
    return integration;
  };

  // Parent side: fires before the child's extensions bind (synchronous dispatch),
  // so the child instance can recognize itself in session_start below.
  pi.events.on('subagents:child:session-created', (data) => {
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
    if (record && typeof record.sessionId === 'string') {
      store.registerChild(
        record.sessionId,
        typeof record.parentSessionId === 'string' ? record.parentSessionId : undefined,
      );
    }
  });

  for (const channel of SUBAGENT_EVENT_CHANNELS) {
    pi.events.on(channel, (data) => {
      registry.applyEvent(channel, data, Date.now());
      if (channel === 'subagents:started') {
        const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
        if (record && typeof record.id === 'string') {
          store.linkNextAgent(record.id);
        }
      }
    });
  }

  registerWatchdogCommands(pi, { config, state, registry, getIntegration, store });

  pi.on('session_start', (_event, ctx) => {
    // Child side: if our sessionId was registered by the parent instance, collect
    const sessionId = ctx.sessionManager.getSessionId();
    if (store.getChild(sessionId)) {
      startCollector(pi, store, sessionId, config);
    }

    if (ctx.hasUI) {
      for (const warning of warnings) {
        ctx.ui.notify(warning, 'warning');
      }
    }
  });
}
