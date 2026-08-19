import { describe, expect, it } from 'vitest';
import { formatCompliance } from './format.js';
import { evalCase, subjectOutput } from '../testing.js';
import type { Score, SubjectOutput } from '../types.js';

const scoreOf = (output: SubjectOutput): Promise<Score> =>
  formatCompliance().score({ case: evalCase(), output });

describe('formatCompliance', () => {
  it('scores 1 for a tool call', async () => {
    const result = await scoreOf(
      subjectOutput({ toolCalls: [{ name: 'record', input: { intent: 'refund' } }] }),
    );

    expect(result.value).toBe(1);
    expect(result.meta?.['via']).toBe('tool-call');
  });

  it('scores 1 for a response that is entirely JSON', async () => {
    const result = await scoreOf(subjectOutput({ text: '{"intent":"refund"}' }));

    expect(result.value).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('scores the configurable partial for a clean fenced block', async () => {
    const result = await scoreOf(subjectOutput({ text: '```json\n{"intent":"refund"}\n```' }));

    expect(result.value).toBe(0.5);
    expect(result.passed).toBe(false);
    expect(result.meta?.['via']).toBe('fenced');
  });

  it('honours a custom fenced score', async () => {
    const result = await formatCompliance({ fencedScore: 0.9 }).score({
      case: evalCase(),
      output: subjectOutput({ text: '```\n{"a":1}\n```' }),
    });

    expect(result.value).toBe(0.9);
  });

  it('scores 0 when the payload had to be scavenged out of prose', async () => {
    const result = await scoreOf(
      subjectOutput({ text: 'Sure, here you go:\n```json\n{"intent":"refund"}\n```' }),
    );

    /* This is the preamble discipline that extractStructured deliberately
       tolerates so that it can be measured here instead. */
    expect(result.value).toBe(0);
    expect(result.meta?.['via']).toBe('scavenged');
  });

  it('scores 0 when there was no payload at all', async () => {
    const result = await scoreOf(subjectOutput({ text: 'I am not sure what you want.' }));

    expect(result.value).toBe(0);
    expect(result.meta?.['via']).toBeNull();
    expect(result.reason).toContain('no structured payload');
  });

  it('claims `format` as optional, so it applies to every case', () => {
    expect(formatCompliance().claims).toEqual([{ key: 'format', required: false }]);
  });

  it('takes a name override', () => {
    expect(formatCompliance({ name: 'strict-format' }).name).toBe('strict-format');
  });
});
