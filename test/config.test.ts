import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  getConfigPaths,
  loadConfigFile,
  loadEffectiveConfig,
  mergeConfig,
} from '../src/config.ts';

const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('DEFAULT_CONFIG', () => {
  it('has the documented default values', () => {
    expect(DEFAULT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONFIG.rescueMessage).toBe(
      'The AI agent appears to be stuck in a dead loop. Fix it, then continue the work.',
    );
    expect(DEFAULT_CONFIG.llmRepeatThreshold).toBe(10);
    expect(DEFAULT_CONFIG.idleNoProgressSec).toBe(0);
    expect(DEFAULT_CONFIG.cooldownSec).toBe(0);
    expect(DEFAULT_CONFIG.maxPreviewLines).toBe(20);
    expect(DEFAULT_CONFIG.maxEventsPerAgent).toBe(200);
    expect(DEFAULT_CONFIG.alertMode).toBe('main_only');
    expect(DEFAULT_CONFIG.steerDryRunDefault).toBeNull();
    expect(DEFAULT_CONFIG.debug).toBe(false);
  });
});

describe('getConfigPaths', () => {
  it('returns global path under home and project path under project dir', () => {
    const { globalPath, projectPath } = getConfigPaths('/proj');
    expect(globalPath).toBe(
      join(homedir(), '.pi', 'agent', 'watchdog-supervisor', 'config.json'),
    );
    expect(projectPath).toBe(join('/proj', '.pi', 'watchdog-supervisor.json'));
  });
});

describe('loadConfigFile', () => {
  it('returns null config without warning when file does not exist', () => {
    const { config, warning } = loadConfigFile(join(makeTempDir(), 'missing.json'));
    expect(config).toBeNull();
    expect(warning).toBeUndefined();
  });

  it('returns parsed partial config for a valid file', () => {
    const dir = makeTempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ llmRepeatThreshold: 5 }));
    const { config, warning } = loadConfigFile(path);
    expect(config).toEqual({ llmRepeatThreshold: 5 });
    expect(warning).toBeUndefined();
  });

  it('returns null config with warning for invalid JSON', () => {
    const dir = makeTempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not json');
    const { config, warning } = loadConfigFile(path);
    expect(config).toBeNull();
    expect(warning).toContain(path);
  });

  it('ignores unknown fields', () => {
    const dir = makeTempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ llmRepeatThreshold: 5, bogus: true }));
    const { config } = loadConfigFile(path);
    expect(config).toEqual({ llmRepeatThreshold: 5 });
  });
});

describe('mergeConfig', () => {
  it('returns defaults when no parts are given', () => {
    expect(mergeConfig()).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig(null, undefined)).toEqual(DEFAULT_CONFIG);
  });

  it('overrides defaults with global values, keeping unspecified defaults', () => {
    const merged = mergeConfig({ llmRepeatThreshold: 10 });
    expect(merged.llmRepeatThreshold).toBe(10);
    expect(merged.cooldownSec).toBe(DEFAULT_CONFIG.cooldownSec);
  });

  it('lets later parts (project) override earlier parts (global)', () => {
    const merged = mergeConfig(
      { llmRepeatThreshold: 10, cooldownSec: 120 },
      { llmRepeatThreshold: 7 },
    );
    expect(merged.llmRepeatThreshold).toBe(7);
    expect(merged.cooldownSec).toBe(120);
    expect(merged.idleNoProgressSec).toBe(DEFAULT_CONFIG.idleNoProgressSec);
  });
});

describe('loadEffectiveConfig', () => {
  it('merges project config over defaults and collects no warnings for valid files', () => {
    const projectDir = makeTempDir();
    mkdirSync(join(projectDir, '.pi'));
    writeFileSync(
      join(projectDir, '.pi', 'watchdog-supervisor.json'),
      JSON.stringify({ llmRepeatThreshold: 5 }),
    );
    const { config, warnings } = loadEffectiveConfig(projectDir);
    expect(config.llmRepeatThreshold).toBe(5);
    expect(config.alertMode).toBe('main_only');
    expect(warnings).toEqual([]);
  });

  it('falls back and reports warning when project config is invalid JSON', () => {
    const projectDir = makeTempDir();
    mkdirSync(join(projectDir, '.pi'));
    writeFileSync(join(projectDir, '.pi', 'watchdog-supervisor.json'), '{ oops');
    const { config, warnings } = loadEffectiveConfig(projectDir);
    expect(config.llmRepeatThreshold).toBe(DEFAULT_CONFIG.llmRepeatThreshold);
    expect(warnings).toHaveLength(1);
  });
});
