import { describe, expect, it } from 'vitest';
import { extractStructured } from './extract.js';
import { subjectOutput } from '../testing.js';

describe('extractStructured', () => {
  it('prefers the first tool call input over any text', () => {
    const result = extractStructured(
      subjectOutput({
        text: '{"intent":"from_text"}',
        toolCalls: [
          { name: 'record_extraction', input: { intent: 'from_tool' } },
          { name: 'record_extraction', input: { intent: 'second' } },
        ],
      }),
    );

    expect(result).toEqual({ data: { intent: 'from_tool' } });
  });

  it('parses bare JSON text', () => {
    const result = extractStructured(subjectOutput({ text: '{"intent":"refund","n":2}' }));

    expect(result).toEqual({ data: { intent: 'refund', n: 2 } });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    const result = extractStructured(
      subjectOutput({ text: '```json\n{"intent":"refund"}\n```' }),
    );

    expect(result).toEqual({ data: { intent: 'refund' } });
  });

  it('parses a fence with no language tag', () => {
    const result = extractStructured(subjectOutput({ text: '```\n[1, 2, 3]\n```\n' }));

    expect(result).toEqual({ data: [1, 2, 3] });
  });

  it('describes an error instead of throwing when the model returned prose', () => {
    const result = extractStructured(
      subjectOutput({ text: 'Sure! The customer is asking for a refund on order 48812.' }),
    );

    /* A prose response is a scoring result, not a crash. */
    expect(result).toEqual({ error: expect.stringContaining('did not parse as JSON') });
    expect('error' in result && result.error).toContain('Sure!');
  });

  it('does not scavenge a fenced block out of surrounding prose', () => {
    const result = extractStructured(
      subjectOutput({ text: 'Here you go:\n\n```json\n{"intent":"refund"}\n```' }),
    );

    /* Digging this out would hide a format-compliance failure behind a
       passing score. See the note on stripFence. */
    expect('error' in result).toBe(true);
  });

  it('reports an empty response', () => {
    const result = extractStructured(subjectOutput({}));

    expect(result).toEqual({ error: expect.stringContaining('no text') });
  });

  it('treats a literal JSON null as data, not as absence', () => {
    const result = extractStructured(subjectOutput({ text: 'null' }));

    expect(result).toEqual({ data: null });
  });
});
