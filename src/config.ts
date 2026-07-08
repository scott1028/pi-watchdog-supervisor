import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WatchdogConfig } from './types.ts';

export const DEFAULT_CONFIG: WatchdogConfig = {
  enabled: true,
  rescueMessage:
    'AI agent 是不是卡死了?\n請停止目前重複動作，總結你已知的資訊，重新規劃下一步。\n不要再執行相同 command，除非 query 或 path 有改變。',
  repeatThreshold: 3,
  typecheckRepeatThreshold: 2,
  idleNoProgressSec: 300,
  cooldownSec: 60,
  maxPreviewLines: 20,
  maxEventsPerAgent: 200,
  alertMode: 'main_only',
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
  const config: Partial<WatchdogConfig> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof WatchdogConfig>) {
    if (key in parsed) {
      (config as Record<string, unknown>)[key] = (parsed as Record<string, unknown>)[key];
    }
  }
  return { config };
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
