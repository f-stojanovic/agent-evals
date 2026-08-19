import { describe, expect, it } from 'vitest';
import { InvalidScoreError, invokeScorer } from './invoke.js';
import { evalCase, subjectOutput } from '../testing.js';
import type { Score, Scorer } from '../types.js';

/** Returns whatever it is handed, so a test can state the exact malformed
 *  score it is about. Cast because the point is to defeat the type system —
 *  these scorers arrive as plain JS, or from a `any`-typed helper. */
function scorerReturning(name: string, score: unknown): Scorer {
  return {
    name,
    claims: ['fields'],
    score: (): Promise<Score> => Promise.resolve(score as Score),
  };
}

const args = { case: evalCase(), output: subjectOutput({ text: '{}' }) };

describe('invokeScorer', () => {
  it('passes a valid score straight through', async () => {
    const score: Score = { scorer: 'ok', value: 0.5, passed: false };

    await expect(invokeScorer(scorerReturning('ok', score), args)).resolves.toBe(score);
  });

  it('accepts the boundary values 0 and 1', async () => {
    for (const value of [0, 1]) {
      const score = { scorer: 'edge', value, passed: value === 1 };
      await expect(invokeScorer(scorerReturning('edge', score), args)).resolves.toEqual(score);
    }
  });

  it('rejects NaN', async () => {
    /* NaN passes every naive range guard and then poisons every mean it
       reaches. This is the check that earns its keep. */
    const scorer = scorerReturning('cosine', { scorer: 'cosine', value: 0 / 0, passed: false });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(InvalidScoreError);
    await expect(invokeScorer(scorer, args)).rejects.toThrow(/finite number, got NaN/);
  });

  it('rejects Infinity', async () => {
    const scorer = scorerReturning('ratio', {
      scorer: 'ratio',
      value: Number.POSITIVE_INFINITY,
      passed: true,
    });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(/finite number/);
  });

  it('rejects a value above 1', async () => {
    const scorer = scorerReturning('percent', { scorer: 'percent', value: 87, passed: true });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(/within 0..1, got 87/);
  });

  it('rejects a negative value', async () => {
    const scorer = scorerReturning('signed', { scorer: 'signed', value: -0.2, passed: false });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(/within 0..1, got -0.2/);
  });

  it('rejects a non-numeric value', async () => {
    const scorer = scorerReturning('stringy', { scorer: 'stringy', value: '1', passed: true });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(/finite number, got string/);
  });

  it('rejects a score attributed to a different scorer', async () => {
    /* The copy-paste failure: results filed under the wrong baseline column
       look exactly like the other scorer regressing. */
    const scorer = scorerReturning('exact-fields', {
      scorer: 'semantic-fields',
      value: 1,
      passed: true,
    });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(
      /"semantic-fields" but the scorer is named "exact-fields"/,
    );
  });

  it('reports every problem in one message', async () => {
    const scorer = scorerReturning('a', { scorer: 'b', value: 5, passed: true });

    await expect(invokeScorer(scorer, args)).rejects.toThrow(/within 0..1.*;.*named "a"/s);
  });

  it('does not catch exceptions from the scorer — that is the runner\'s job', async () => {
    const scorer: Scorer = {
      name: 'explodes',
      claims: ['fields'],
      score: () => Promise.reject(new Error('provider timeout')),
    };

    await expect(invokeScorer(scorer, args)).rejects.toThrow('provider timeout');
  });
});
