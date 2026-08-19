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

    expect(result).toEqual({ data: { intent: 'from_tool' }, via: 'tool-call' });
  });

  it('parses bare JSON text', () => {
    const result = extractStructured(subjectOutput({ text: '{"intent":"refund","n":2}' }));

    expect(result).toEqual({ data: { intent: 'refund', n: 2 }, via: 'json' });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    const result = extractStructured(subjectOutput({ text: '```json\n{"intent":"refund"}\n```' }));

    expect(result).toEqual({ data: { intent: 'refund' }, via: 'fenced' });
  });

  it('parses a fence with no language tag', () => {
    const result = extractStructured(subjectOutput({ text: '```\n[1, 2, 3]\n```\n' }));

    expect(result).toEqual({ data: [1, 2, 3], via: 'fenced' });
  });

  it('scavenges a fenced block out of surrounding prose, and says it did', () => {
    const result = extractStructured(
      subjectOutput({ text: 'Here you go:\n\n```json\n{"intent":"refund"}\n```\n\nHope that helps!' }),
    );

    /* Recovered, not refused — but `via` records how, so formatCompliance can
       score the preamble separately instead of the two being conflated. */
    expect(result).toEqual({ data: { intent: 'refund' }, via: 'scavenged' });
  });

  it('scavenges when exactly one fenced block parses, ignoring the rest', () => {
    const result = extractStructured(
      subjectOutput({
        text: 'Working:\n```\nnot json\n```\nAnswer:\n```json\n{"ok":true}\n```',
      }),
    );

    expect(result).toEqual({ data: { ok: true }, via: 'scavenged' });
  });

  it('refuses to guess when several fenced blocks parse as JSON', () => {
    const result = extractStructured(
      subjectOutput({
        text: 'First attempt:\n```json\n{"n":1}\n```\nActually:\n```json\n{"n":2}\n```',
      }),
    );

    /* First-wins scores the scratch work, last-wins scores a trailing
       example. Both rules are arbitrary, and an arbitrary rule applied
       silently produces a confident number derived from a coin flip. */
    expect(result).toEqual({
      via: 'ambiguous',
      error: expect.stringContaining('ambiguous'),
      fenceCount: 2,
    });
  });

  it('describes an error instead of throwing when the model returned only prose', () => {
    const result = extractStructured(
      subjectOutput({ text: 'Sure! The customer is asking for a refund on order 48812.' }),
    );

    /* A prose response is a scoring result, not a crash. */
    /* `unreadable`, not `ambiguous`: the model produced nothing parseable, which
       is a fact about the model and gets scored. */
    expect(result).toEqual({ via: 'unreadable', error: expect.stringContaining('no parseable JSON') });
    expect('error' in result && result.error).toContain('Sure!');
  });

  it('reports an empty response', () => {
    const result = extractStructured(subjectOutput({}));

    expect(result).toEqual({ via: 'unreadable', error: expect.stringContaining('no text') });
  });

  it('treats a literal JSON null as data, not as absence', () => {
    const result = extractStructured(subjectOutput({ text: 'null' }));

    expect(result).toEqual({ data: null, via: 'json' });
  });
});
