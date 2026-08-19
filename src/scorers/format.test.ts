import { describe, expect, it } from 'vitest';
import { formatCompliance } from './format.js';
import { evalCase, scoreArgs, subjectOutput } from '../testing.js';
import type { Score, SubjectOutput } from '../types.js';

const scoreWith = (declared: unknown, output: SubjectOutput): Promise<Score> =>
  formatCompliance().score(
    scoreArgs({ case: evalCase({ expect: { format: declared } }), output }),
  );

const toolOutput = subjectOutput({ toolCalls: [{ name: 'record', input: { a: 1 } }] });
const jsonOutput = subjectOutput({ text: '{"a":1}' });
const fencedOutput = subjectOutput({ text: '```json\n{"a":1}\n```' });
const scavengedOutput = subjectOutput({ text: 'Sure:\n```json\n{"a":1}\n```' });
const proseOutput = subjectOutput({ text: 'I am not sure what you want.' });

describe('formatCompliance', () => {
  it('scores 1 when the observed route matches the declared format', async () => {
    expect((await scoreWith('tool-call', toolOutput)).value).toBe(1);
    expect((await scoreWith('json', jsonOutput)).value).toBe(1);
    expect((await scoreWith('fenced', fencedOutput)).value).toBe(1);
  });

  it('scores 0 when the route is less compliant than declared', async () => {
    const score = await scoreWith('json', fencedOutput);

    /* No invented partial credit for a fence. Whether an envelope is
       acceptable is a question the case author answers, not the harness. */
    expect(score.value).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.reason).toContain('declares format "json"');
  });

  it('accepts a route that is more compliant than declared', async () => {
    /* `fenced` means "a fence is acceptable", not "a fence is required" —
       failing a model for skipping the envelope would be perverse. */
    expect((await scoreWith('fenced', jsonOutput)).value).toBe(1);
    expect((await scoreWith('json', toolOutput)).value).toBe(1);
  });

  it('requires a tool call when the case declares tool-call', async () => {
    expect((await scoreWith('tool-call', jsonOutput)).value).toBe(0);
  });

  it('never accepts a scavenged payload except under `any`', async () => {
    expect((await scoreWith('fenced', scavengedOutput)).value).toBe(0);
    expect((await scoreWith('json', scavengedOutput)).value).toBe(0);
    expect((await scoreWith('any', scavengedOutput)).value).toBe(1);
  });

  it('treats `any` as a positive statement, satisfied by every route', async () => {
    for (const output of [toolOutput, jsonOutput, fencedOutput, scavengedOutput]) {
      expect((await scoreWith('any', output)).value).toBe(1);
    }
  });

  it('scores 0 when no payload could be found, even under `any`', async () => {
    const score = await scoreWith('any', proseOutput);

    expect(score.value).toBe(0);
    expect(score.meta?.['via']).toBe('none');
    expect(score.reason).toContain('no structured payload');
  });

  it('records what was declared alongside what happened', async () => {
    const score = await scoreWith('json', fencedOutput);

    expect(score.meta).toMatchObject({ declared: 'json', via: 'fenced' });
  });

  it('claims `format` as required, so a case without it is skipped', () => {
    expect(formatCompliance().claims).toEqual([{ key: 'format', required: true }]);
  });

  it('throws on a case that declares no format', async () => {
    await expect(
      formatCompliance().score(scoreArgs({ case: evalCase({ expect: {} }), output: jsonOutput })),
    ).rejects.toThrow(/declares no `expect.format`/);
  });

  it('throws on an unrecognised format value', async () => {
    await expect(scoreWith('yaml', jsonOutput)).rejects.toThrow(/expected one of/);
  });

  it('takes a name override', () => {
    expect(formatCompliance({ name: 'strict-format' }).name).toBe('strict-format');
  });
});
