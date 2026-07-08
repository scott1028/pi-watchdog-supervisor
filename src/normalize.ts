import { createHash } from 'node:crypto';

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

const stripAnsi = (raw: string): string => raw.replace(ANSI_PATTERN, '');

export const normalizeCommand = (raw: string): string =>
  stripAnsi(raw).trim().replace(/\s+/g, ' ');

export type HashOutputOptions = {
  maxBytes?: number;
  previewLines: number;
};

const DEFAULT_MAX_BYTES = 65536;

export const hashOutput = (
  raw: string,
  { maxBytes = DEFAULT_MAX_BYTES, previewLines }: HashOutputOptions,
): { hash: string; preview: string } => {
  const stripped = stripAnsi(raw);
  const truncated = stripped.slice(0, maxBytes);
  const hash = createHash('sha256').update(truncated).digest('hex');
  const preview = truncated.split('\n').slice(0, previewLines).join('\n');
  return { hash, preview };
};
