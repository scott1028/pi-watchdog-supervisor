import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { WatchdogConfig, WatchdogEvent, WatchdogTarget } from './types.ts';
import type { TargetRegistry } from './registry.ts';
import type { WatchdogStore } from './store.ts';
import { mergeConfig } from './config.ts';
import { detectStuck } from './detector.ts';
import type { SubagentsIntegration } from './integrations/gotgenes-subagents.ts';

type WatchdogRuntime = {
  config: WatchdogConfig;
  registry: TargetRegistry;
  getIntegration: () => Promise<SubagentsIntegration>;
  store: WatchdogStore;
};

const SUBCOMMANDS = 'status | config | set rescueMessage <msg> | pause | resume | inspect <targetId>';

const formatTargets = (
  targets: WatchdogTarget[],
  store: WatchdogStore,
  config: WatchdogConfig,
): string => {
  if (targets.length === 0) {
    return '  (none)';
  }
  return targets
    .map((target) => {
      const key = store.resolveTargetKey(target.id);
      const events = key ? store.getEvents(key) : [];
      const analysis =
        events.length > 0
          ? detectStuck(events, config, Date.now(), store.getLastAlert(key ?? '')?.at ?? 0)
          : undefined;
      return [
        `  [${target.kind}]`.padEnd(13),
        target.id.padEnd(10),
        target.status.padEnd(10),
        `tools=${target.toolCallCount}`.padEnd(10),
        `last=${new Date(target.lastActiveAt).toISOString()}`,
        events.length > 0 ? `events=${events.length}` : '',
        target.name ? `"${target.name}"` : '',
        analysis?.likelyStuck ? `!! likely stuck (${analysis.confidence})` : '',
      ]
        .join(' ')
        .trimEnd();
    })
    .join('\n');
};

const formatEvent = (event: WatchdogEvent): string => {
  const time = new Date(event.at).toISOString().slice(11, 19);
  const hash = event.outputHash ? ` [${event.outputHash.slice(0, 8)}]` : '';
  return `  ${time} ${event.type.padEnd(11)} ${event.summary}${hash}`;
};

const output = (ctx: ExtensionCommandContext, message: string) => {
  if (ctx.hasUI) {
    ctx.ui.notify(message, 'info');
  } else {
    console.log(message);
  }
};

export const registerWatchdogCommands = (pi: ExtensionAPI, runtime: WatchdogRuntime) => {
  pi.registerCommand('watchdog', {
    description: 'Watchdog supervisor: status, config, pause/resume, rescue message',
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      switch (subcommand) {
        case 'status': {
          const { config, registry, getIntegration, store } = runtime;
          const header = [
            'watchdog-supervisor loaded',
            `enabled=${config.enabled}`,
            `paused=${store.isPaused()}`,
            `alertMode=${config.alertMode}`,
          ].join(' | ');
          const integration = await getIntegration();
          if (!integration.available) {
            output(
              ctx,
              `${header}\ntargets: unavailable — install @gotgenes/pi-subagents (${integration.reason})`,
            );
            break;
          }
          registry.syncFromRecords(integration.listAgents());
          const targets = registry.list();
          output(
            ctx,
            `${header}\ntargets (${targets.length}):\n${formatTargets(targets, runtime.store, config)}`,
          );
          break;
        }
        case 'config': {
          const merged = mergeConfig(runtime.config, runtime.store.getConfigOverride());
          const effective = {
            ...merged,
            rescueMessage: runtime.store.getRescueMessage() ?? merged.rescueMessage,
          };
          output(ctx, JSON.stringify(effective, null, 2));
          break;
        }
        case 'set': {
          const [key, ...messageParts] = rest;
          const message = messageParts.join(' ');
          if (key !== 'rescueMessage' || message === '') {
            output(ctx, 'Usage: /watchdog set rescueMessage <message>');
            break;
          }
          runtime.store.setRescueMessage(message);
          output(ctx, 'rescueMessage updated for this session');
          break;
        }
        case 'pause':
          runtime.store.setPaused(true);
          output(ctx, 'watchdog alerting paused');
          break;
        case 'resume':
          runtime.store.setPaused(false);
          output(ctx, 'watchdog alerting resumed');
          break;
        case 'inspect': {
          const [targetId] = rest;
          if (!targetId) {
            output(ctx, 'Usage: /watchdog inspect <targetId>');
            break;
          }
          const key = runtime.store.resolveTargetKey(targetId);
          if (!key) {
            output(ctx, `Unknown target: ${targetId}`);
            break;
          }
          const events = runtime.store.getEvents(key, 20);
          if (events.length === 0) {
            output(ctx, `No events recorded for ${targetId}`);
            break;
          }
          const analysis = detectStuck(
            runtime.store.getEvents(key),
            runtime.config,
            Date.now(),
            runtime.store.getLastAlert(key)?.at ?? 0,
          );
          output(
            ctx,
            `events for ${targetId} (latest ${events.length}):\n${events.map(formatEvent).join('\n')}\n` +
              `analysis: likelyStuck=${analysis.likelyStuck} confidence=${analysis.confidence} reasons=[${analysis.reasons.join('; ')}]`,
          );
          break;
        }
        default:
          output(ctx, `Unknown subcommand. Available: ${SUBCOMMANDS}`);
      }
    },
  });
};
