import { describe, expect, it } from 'vitest';
import { hashOutput, normalizeCommand } from '../src/normalize.ts';

describe('normalizeCommand', () => {
  it('strips ANSI escape codes', () => {
    expect(normalizeCommand('\u001b[31mrg\u001b[0m "X" src')).toBe('rg "X" src');
  });

  it('trims and collapses repeated whitespace', () => {
    expect(normalizeCommand('  rg   "X"\t src  ')).toBe('rg "X" src');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeCommand('   \t  ')).toBe('');
  });
});

describe('hashOutput', () => {
  it('is stable for identical input', () => {
    const a = hashOutput('same output', { previewLines: 5 });
    const b = hashOutput('same output', { previewLines: 5 });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different input', () => {
    expect(hashOutput('one', { previewLines: 5 }).hash).not.toBe(
      hashOutput('two', { previewLines: 5 }).hash,
    );
  });

  it('strips ANSI before hashing', () => {
    expect(hashOutput('\u001b[32mok\u001b[0m', { previewLines: 5 }).hash).toBe(
      hashOutput('ok', { previewLines: 5 }).hash,
    );
  });

  it('truncates to maxBytes before hashing', () => {
    const long = 'x'.repeat(100);
    expect(hashOutput(long, { maxBytes: 10, previewLines: 5 }).hash).toBe(
      hashOutput(long.slice(0, 10), { previewLines: 5 }).hash,
    );
  });

  it('limits preview to previewLines lines', () => {
    const output = ['l1', 'l2', 'l3', 'l4'].join('\n');
    const { preview } = hashOutput(output, { previewLines: 2 });
    expect(preview).toBe('l1\nl2');
  });

  it('handles empty input', () => {
    const { hash, preview } = hashOutput('', { previewLines: 5 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview).toBe('');
  });
});
