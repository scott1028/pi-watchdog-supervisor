import { describe, expect, it } from 'vitest';
import {
  describeAssistantMessage,
  describeSentPayload,
  registerLmDebugWidget,
} from '../src/lmdebug.ts';

const NOW = new Date('2026-07-08T14:15:23').getTime();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bivariant fake for overloads
type Handler = (event: any, ctx: any) => void;

const createFakePi = () => {
  const handlers = new Map<string, Handler[]>();
  const widgets: Array<{ key: string; content: string[] | undefined; options: unknown }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: string[] | undefined, options?: unknown) => {
        widgets.push({ key, content, options });
      },
    },
  };
  return {
    pi: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload, ctx);
      }
    },
    widgets,
  };
};

describe('describeSentPayload', () => {
  it('summarizes the last message of an OpenAI-style payload', () => {
    const text = describeSentPayload({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'fix the bug in index.tsx' },
      ],
    });
    expect(text).toBe('#2 user:\nfix the bug in index.tsx');
  });

  it('handles content parts arrays and missing payloads', () => {
    expect(
      describeSentPayload({ messages: [{ role: 'tool', content: [{ type: 'text', text: 'ok' }] }] }),
    ).toBe('#1 tool:\nok');
    expect(describeSentPayload(undefined)).toBe('no messages in payload');
  });
});

describe('describeAssistantMessage', () => {
  it('includes text and toolCall blocks with newlines preserved', () => {
    const text = describeAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will edit\nthe file' },
        { type: 'toolCall', name: 'edit', arguments: {} },
      ],
    });
    expect(text).toBe('assistant:\nI will edit\nthe file\n[toolCall edit]');
  });

  it('returns undefined for non-assistant messages', () => {
    expect(describeAssistantMessage({ role: 'user', content: [] })).toBeUndefined();
  });
});

describe('registerLmDebugWidget', () => {
  it('registers nothing when debug is false (the default)', () => {
    const { pi, emit, widgets } = createFakePi();
    registerLmDebugWidget(pi, false, () => NOW);
    emit('before_provider_request', {
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(widgets).toHaveLength(0);
  });

  it('renders full multi-line messages with timestamps into a belowEditor widget', () => {
    const { pi, emit, widgets } = createFakePi();
    registerLmDebugWidget(pi, true, () => NOW);
    emit('before_provider_request', {
      payload: { messages: [{ role: 'user', content: 'hello\nsecond line' }] },
    });
    emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi there\nmore detail' }] },
    });
    expect(widgets).toHaveLength(2);
    expect(widgets[1].key).toBe('watchdog-lm-debug');
    expect(widgets[1].options).toEqual({ placement: 'belowEditor' });
    expect(widgets[1].content).toEqual([
      '▲ sent 14:15:23 #1 user:',
      'hello',
      'second line',
      '',
      '▼ recv 14:15:23 assistant:',
      'hi there',
      'more detail',
    ]);
  });

  it('ignores non-assistant message_end events', () => {
    const { pi, emit, widgets } = createFakePi();
    registerLmDebugWidget(pi, true, () => NOW);
    emit('message_end', { message: { role: 'toolResult', content: [] } });
    expect(widgets).toHaveLength(0);
  });
});
