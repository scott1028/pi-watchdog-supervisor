import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WatchdogConfig } from './types.ts';

export const DEFAULT_CONFIG: WatchdogConfig = {
  enabled: true,
  rescueMessage:
    'The AI agent appears to be stuck in a dead loop. Fix it, then continue the work.',
  llmRepeatThreshold: 10,
  idleNoProgressSec: 0, // 0 = idle_no_progress detection disabled
  cooldownSec: 0, // 0 = no cooldown; -1 = same evidence alerts once; >0 = seconds
  maxPreviewLines: 20,
  maxEventsPerAgent: 200,
  alertMode: 'main_only',
  steerDryRunDefault: null, // null = built-in safe default (dry-run)
  debug: false, // show the lm-debug console (full sent/received messages)
};

export const getConfigPaths = (projectDir: string) => ({
  globalPath: join(homedir(), '.pi', 'agent', 'watchdog-supervisor', 'config.json'),
  projectPath: join(projectDir, '.pi', 'watchdog-supervisor.json'),
});

export const loadConfigFile = (
  path: string,
): { config: Partial<WatchdogConfig> | null; warning?: string } => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // missing file is not an error
    return { config: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: null, warning: `Invalid JSON in ${path}; file ignored` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { config: null, warning: `Expected a JSON object in ${path}; file ignored` };
  }
  return { config: pickKnownConfig(parsed as Record<string, unknown>) };
};

// Keep only WatchdogConfig fields; drop unknown keys
export const pickKnownConfig = (raw: Record<string, unknown>): Partial<WatchdogConfig> => {
  const config: Partial<WatchdogConfig> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof WatchdogConfig>) {
    if (key in raw) {
      (config as Record<string, unknown>)[key] = raw[key];
    }
  }
  return config;
};

export const mergeConfig = (
  ...parts: Array<Partial<WatchdogConfig> | null | undefined>
): WatchdogConfig => {
  const merged: WatchdogConfig = { ...DEFAULT_CONFIG };
  for (const part of parts) {
    if (part) {
      Object.assign(merged, part);
    }
  }
  return merged;
};

export const loadEffectiveConfig = (
  projectDir: string,
): { config: WatchdogConfig; warnings: string[] } => {
  const { globalPath, projectPath } = getConfigPaths(projectDir);
  const globalResult = loadConfigFile(globalPath);
  const projectResult = loadConfigFile(projectPath);
  const warnings = [globalResult.warning, projectResult.warning].filter(
    (warning): warning is string => warning !== undefined,
  );
  return { config: mergeConfig(globalResult.config, projectResult.config), warnings };
};
