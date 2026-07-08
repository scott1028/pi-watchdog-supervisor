import { describe, expect, it } from 'vitest';
import { hashOutput, normalizeCommand, normalizeLlmBody } from '../src/normalize.ts';

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

describe('normalizeLlmBody', () => {
  it('makes bodies differing only in timestamps identical', () => {
    const a = normalizeLlmBody('done at 2026-07-08T14:15:23.018Z, retry 10:15:46 PM');
    const b = normalizeLlmBody('done at 2026-07-08T14:16:41.777Z, retry 10:17:02 PM');
    expect(a).toBe(b);
  });

  it('makes bodies differing only in ids and sequence numbers identical', () => {
    const a = normalizeLlmBody('call tc-17 session 019f4213-974b-742e-883c-12f525463fb2 hash a1b2c3d4e5f6');
    const b = normalizeLlmBody('call tc-42 session 22222222-974b-742e-883c-125254632222 hash ffffffffffff');
    expect(a).toBe(b);
  });

  it('keeps genuinely different bodies different', () => {
    expect(normalizeLlmBody('read file a.ts')).not.toBe(normalizeLlmBody('edit file a.ts'));
  });

  it('collapses whitespace and strips ANSI', () => {
    expect(normalizeLlmBody('\u001b[31mok\u001b[0m   done\n\n now')).toBe('ok done now');
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
