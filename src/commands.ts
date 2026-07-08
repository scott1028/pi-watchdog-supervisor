import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { WatchdogConfig } from './types.ts';
import type { SessionState } from './state.ts';

type WatchdogRuntime = {
  config: WatchdogConfig;
  state: SessionState;
};

const SUBCOMMANDS = 'status | config | set rescueMessage <msg> | pause | resume | inspect <targetId>';

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
          const { config, state } = runtime;
          output(
            ctx,
            [
              'watchdog-supervisor loaded',
              `enabled=${config.enabled}`,
              `paused=${state.isPaused()}`,
              `alertMode=${config.alertMode}`,
              `repeatThreshold=${config.repeatThreshold}`,
              'targets: 0 (subagent discovery: Task02)',
            ].join(' | '),
          );
          break;
        }
        case 'config': {
          const effective = {
            ...runtime.config,
            rescueMessage: runtime.state.getEffectiveRescueMessage(runtime.config),
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
          runtime.state.setRescueMessage(message);
          output(ctx, 'rescueMessage updated for this session');
          break;
        }
        case 'pause':
          runtime.state.pause();
          output(ctx, 'watchdog alerting paused');
          break;
        case 'resume':
          runtime.state.resume();
          output(ctx, 'watchdog alerting resumed');
          break;
        case 'inspect':
          output(ctx, 'inspect not implemented yet (Task03)');
          break;
        default:
          output(ctx, `Unknown subcommand. Available: ${SUBCOMMANDS}`);
      }
    },
  });
};
