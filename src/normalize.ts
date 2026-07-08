import { createHash } from 'node:crypto';

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

const stripAnsi = (raw: string): string => raw.replace(ANSI_PATTERN, '');

export const normalizeCommand = (raw: string): string =>
  stripAnsi(raw).trim().replace(/\s+/g, ' ');

// Normalize an LLM message body for repetition comparison: strip volatile
// parts (timestamps, dates, UUIDs, long hex ids, digit runs) so two loop
// iterations that differ only in time/sequence markers hash identically.
export const normalizeLlmBody = (raw: string): string =>
  stripAnsi(raw)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .trim()
    .replace(/\s+/g, ' ');

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
