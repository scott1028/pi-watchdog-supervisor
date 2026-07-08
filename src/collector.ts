import { createHash } from 'node:crypto';
import type { WatchdogConfig, WatchdogEventType } from './types.ts';
import type { WatchdogStore } from './store.ts';
import { hashOutput, normalizeCommand, normalizeLlmBody } from './normalize.ts';

// Minimal event surface used by the collector; satisfied by ExtensionAPI's
// tool_call / tool_result overloads and by test fakes
type PiLike = {
  on(event: 'tool_call', handler: (event: unknown) => void): void;
  on(event: 'tool_result', handler: (event: unknown) => void): void;
};

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'patch', 'multi_edit']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

// commandKey: bash command when present, otherwise toolName + first string input value.
// Edit-family keys also include a hash of the full input, so re-running the exact
// same edit shares a key (loop signal) while a different edit to the same file
// gets a new key (progress).
const extractCommandKey = (toolName: string, input: Record<string, unknown>): string => {
  if (typeof input.command === 'string') {
    return normalizeCommand(input.command);
  }
  const firstString = Object.values(input).find((value) => typeof value === 'string');
  const base = normalizeCommand(firstString ? `${toolName} ${firstString}` : toolName);
  if (EDIT_TOOL_NAMES.has(toolName.toLowerCase())) {
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);
    return `${base} #${inputHash}`;
  }
  return base;
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

// Minimal event surface for the LLM-level collector (same sources as the
// lm-debug widget: provider request payload + finalized assistant message)
type LlmPiLike = {
  on(event: 'before_provider_request', handler: (event: unknown) => void): void;
  on(event: 'message_end', handler: (event: unknown) => void): void;
};

const SNIPPET_LEN = 100;

const toSnippet = (raw: string): string => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LEN ? `${flat.slice(0, SNIPPET_LEN)}…` : flat;
};

// Text from OpenAI-style content: plain string or parts with text fields
const extractPayloadText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
};

// Body of the newest message sent to the provider. The full payload always
// grows with the context, so only the last message (the per-turn delta) is
// comparable across loop iterations.
export const extractSentBody = (payload: unknown): string | undefined => {
  const record = asRecord(payload);
  const messages = Array.isArray(record?.messages) ? (record.messages as unknown[]) : [];
  const last = asRecord(messages[messages.length - 1]);
  if (!last) {
    return undefined;
  }
  const role = typeof last.role === 'string' ? last.role : 'unknown';
  return `${role}: ${extractPayloadText(last.content)}`;
};

// Body of a finalized assistant message: text + thinking + tool calls
// (name and arguments — a loop usually re-issues the identical call)
export const extractAssistantBody = (message: unknown): string | undefined => {
  const record = asRecord(message);
  if (record?.role !== 'assistant' || !Array.isArray(record.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of record.content) {
    const blockRecord = asRecord(block);
    if (!blockRecord) {
      continue;
    }
    if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') {
      parts.push(blockRecord.text);
    } else if (blockRecord.type === 'thinking' && typeof blockRecord.thinking === 'string') {
      parts.push(blockRecord.thinking);
    } else if (blockRecord.type === 'toolCall') {
      const name = typeof blockRecord.name === 'string' ? blockRecord.name : 'tool';
      parts.push(`toolCall ${name} ${JSON.stringify(blockRecord.arguments ?? {})}`);
    }
  }
  return parts.join('\n');
};

export const startLlmCollector = (
  pi: LlmPiLike,
  store: WatchdogStore,
  sessionId: string,
  // Invoked right after each llm event is appended — the hook for the
  // event-driven stuck check
  onEvent?: () => void,
): (() => void) => {
  let active = true;

  const append = (type: 'llm_input' | 'llm_output', body: string) => {
    const normalized = normalizeLlmBody(body);
    store.appendEvent(sessionId, {
      at: Date.now(),
      type,
      summary: `${type}: ${toSnippet(normalized)}`,
      commandKey: type,
      outputHash: createHash('sha256').update(normalized).digest('hex'),
      outputPreview: toSnippet(normalized),
    });
    onEvent?.();
  };

  pi.on('before_provider_request', (event) => {
    if (!active) {
      return;
    }
    const body = extractSentBody(asRecord(event)?.payload);
    if (body !== undefined) {
      append('llm_input', body);
    }
  });

  pi.on('message_end', (event) => {
    if (!active) {
      return;
    }
    const body = extractAssistantBody(asRecord(event)?.message);
    if (body !== undefined) {
      append('llm_output', body);
    }
  });

  return () => {
    active = false;
  };
};
