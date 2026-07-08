import type { WatchdogConfig, WatchdogEventType } from './types.ts';
import type { WatchdogStore } from './store.ts';
import { hashOutput, normalizeCommand } from './normalize.ts';

// Minimal event surface used by the collector; satisfied by ExtensionAPI's
// tool_call / tool_result overloads and by test fakes
type PiLike = {
  on(event: 'tool_call', handler: (event: unknown) => void): void;
  on(event: 'tool_result', handler: (event: unknown) => void): void;
};

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'patch', 'multi_edit']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

// commandKey: bash command when present, otherwise toolName + first string input value
const extractCommandKey = (toolName: string, input: Record<string, unknown>): string => {
  if (typeof input.command === 'string') {
    return normalizeCommand(input.command);
  }
  const firstString = Object.values(input).find((value) => typeof value === 'string');
  return normalizeCommand(firstString ? `${toolName} ${firstString}` : toolName);
};

const extractResultText = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      const record = asRecord(item);
      return record && record.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .filter((text) => text !== '')
    .join('\n');
};

export const startCollector = (
  pi: PiLike,
  store: WatchdogStore,
  sessionId: string,
  config: WatchdogConfig,
): (() => void) => {
  let active = true;

  pi.on('tool_call', (event) => {
    if (!active) {
      return;
    }
    const data = asRecord(event);
    const input = asRecord(data?.input);
    if (!data || typeof data.toolName !== 'string' || !input) {
      return;
    }
    const commandKey = extractCommandKey(data.toolName, input);
    const type: WatchdogEventType = EDIT_TOOL_NAMES.has(data.toolName.toLowerCase())
      ? 'edit'
      : 'tool_call';
    store.appendEvent(sessionId, {
      at: Date.now(),
      type,
      summary: `${data.toolName}: ${commandKey}`,
      commandKey,
    });
  });

  pi.on('tool_result', (event) => {
    if (!active) {
      return;
    }
    const data = asRecord(event);
    if (!data || typeof data.toolName !== 'string') {
      return;
    }
    const input = asRecord(data.input) ?? {};
    const commandKey = extractCommandKey(data.toolName, input);
    const { hash, preview } = hashOutput(extractResultText(data.content), {
      previewLines: config.maxPreviewLines,
    });
    store.appendEvent(sessionId, {
      at: Date.now(),
      type: 'tool_result',
      summary: `${data.toolName} result${data.isError === true ? ' (error)' : ''}`,
      commandKey,
      outputHash: hash,
      outputPreview: preview,
    });
  });

  return () => {
    active = false;
  };
};
