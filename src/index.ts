import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadEffectiveConfig } from './config.ts';
import { registerWatchdogCommands } from './commands.ts';
import { createSessionState } from './state.ts';

export default function watchdogSupervisor(pi: ExtensionAPI) {
  const { config, warnings } = loadEffectiveConfig(process.cwd());
  const state = createSessionState();

  registerWatchdogCommands(pi, { config, state });

  if (warnings.length > 0) {
    pi.on('session_start', (_event, ctx) => {
      if (ctx.hasUI) {
        for (const warning of warnings) {
          ctx.ui.notify(warning, 'warning');
        }
      }
    });
  }
}
