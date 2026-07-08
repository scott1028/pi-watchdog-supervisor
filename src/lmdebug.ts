// Debug console at the bottom of the pi TUI: shows the latest request sent to
// the LLM provider (LM Studio) and the latest assistant message received,
// each with a timestamp and the full message body (newlines preserved, no
// truncation). Enabled via the `debug` config flag (default false).
const WIDGET_KEY = 'watchdog-lm-debug';

// Minimal surface used here; satisfied by ExtensionAPI and test fakes
type PiLike = {
  on(
    event: 'before_provider_request',
    handler: (event: { payload: unknown }, ctx: UiCtxLike) => void,
  ): void;
  on(
    event: 'message_end',
    handler: (event: { message: unknown }, ctx: UiCtxLike) => void,
  ): void;
};

type UiCtxLike = {
  hasUI: boolean;
  ui: {
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: 'aboveEditor' | 'belowEditor' },
    ): void;
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

// Text from OpenAI-style content: plain string or [{type:'text',text}] parts
const extractPartsText = (content: unknown): string => {
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

export const describeSentPayload = (payload: unknown): string => {
  const record = asRecord(payload);
  const messages = Array.isArray(record?.messages) ? (record.messages as unknown[]) : [];
  const last = asRecord(messages[messages.length - 1]);
  if (!last) {
    return 'no messages in payload';
  }
  const role = typeof last.role === 'string' ? last.role : 'unknown';
  const text = extractPartsText(last.content);
  // newline before the body so the message starts on its own line
  return `#${messages.length} ${role}:\n${text || '(no text)'}`;
};

// Assistant messages only; other roles return undefined
export const describeAssistantMessage = (message: unknown): string | undefined => {
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
    } else if (blockRecord.type === 'toolCall') {
      const name = typeof blockRecord.name === 'string' ? blockRecord.name : 'tool';
      parts.push(`[toolCall ${name}]`);
    }
  }
  // newline before the body so the message starts on its own line
  return `assistant:\n${parts.join('\n') || '(no text)'}`;
};

const formatTime = (now: number): string => {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const registerLmDebugWidget = (
  pi: PiLike,
  debug: boolean,
  now: () => number = Date.now,
): void => {
  if (!debug) {
    return;
  }

  let sentLines: string[] = [];
  let receivedLines: string[] = [];

  const render = (ctx: UiCtxLike) => {
    if (!ctx.hasUI) {
      return;
    }
    // blank line between the sent block and the recv block
    const separator = sentLines.length > 0 && receivedLines.length > 0 ? [''] : [];
    ctx.ui.setWidget(WIDGET_KEY, [...sentLines, ...separator, ...receivedLines], {
      placement: 'belowEditor',
    });
  };

  pi.on('before_provider_request', (event, ctx) => {
    sentLines = `▲ sent ${formatTime(now())} ${describeSentPayload(event.payload)}`.split('\n');
    render(ctx);
  });

  pi.on('message_end', (event, ctx) => {
    const description = describeAssistantMessage(event.message);
    if (!description) {
      return;
    }
    receivedLines = `▼ recv ${formatTime(now())} ${description}`.split('\n');
    render(ctx);
  });
};
