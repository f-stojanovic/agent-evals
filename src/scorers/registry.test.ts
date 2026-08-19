import { describe, expect, it } from 'vitest';
import { ExpectationError, validateExpectations } from './registry.js';
import { callsTool, exactFields, matchesSchema } from './exact.js';
import { evalCase } from '../testing.js';
import type { Score, Scorer } from '../types.js';

/** A scorer that claims whatever the test needs and never runs. */
function stubScorer(name: string, claims: readonly string[]): Scorer {
  return {
    name,
    claims,
    score: (): Promise<Score> =>
      Promise.resolve({ scorer: name, value: 1, passed: true }),
  };
}

function problemsFrom(fn: () => void): readonly string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpectationError);
    return (error as ExpectationError).problems;
  }
  throw new Error('expected validateExpectations to throw');
}

describe('validateExpectations', () => {
  it('accepts cases whose expectation keys are all claimed', () => {
    expect(() =>
      validateExpectations(
        [
          evalCase({ id: 'a', expect: { fields: {} } }),
          evalCase({ id: 'b', expect: { schema: {}, toolCalls: [] } }),
        ],
        [exactFields(), matchesSchema(), callsTool()],
      ),
    ).not.toThrow();
  });

  it('accepts an empty `expect`, since a scorer may need no expectations', () => {
    expect(() => validateExpectations([evalCase({ expect: {} })], [exactFields()])).not.toThrow();
  });

  it('ignores `meta`, which is outside `expect` and never scored', () => {
    expect(() =>
      validateExpectations(
        [evalCase({ expect: { fields: {} }, meta: { owner: 'filip', ticket: 'EVAL-12' } })],
        [exactFields()],
      ),
    ).not.toThrow();
  });

  it('rejects an unclaimed key and shows the correct spelling', () => {
    /* The failure this whole check exists for: `field` instead of `fields`
       loads fine, is read by nobody, and would report green. */
    const problems = problemsFrom(() =>
      validateExpectations(
        [evalCase({ id: 'refund-01', expect: { field: { intent: 'refund' } } })],
        [exactFields(), matchesSchema()],
      ),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('refund-01');
    expect(problems[0]).toContain('"field"');
    expect(problems[0]).toContain('"fields"');
    expect(problems[0]).toContain('"schema"');
    expect(problems[0]).toContain('meta');
  });

  it('rejects two scorers claiming the same key', () => {
    const problems = problemsFrom(() =>
      validateExpectations([], [exactFields(), stubScorer('other-fields', ['fields'])]),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"fields"');
    expect(problems[0]).toContain('exact-fields');
    expect(problems[0]).toContain('other-fields');
  });

  it('rejects a duplicate scorer name', () => {
    const problems = problemsFrom(() =>
      validateExpectations([], [exactFields(), exactFields({ threshold: 0.5 })]),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('duplicate scorer name');
    expect(problems[0]).toContain('exact-fields');
  });

  it('reports every problem in one pass', () => {
    const problems = problemsFrom(() =>
      validateExpectations(
        [
          evalCase({ id: 'a', expect: { field: {}, tools: [] } }),
          evalCase({ id: 'b', expect: { shcema: {} } }),
        ],
        [exactFields(), stubScorer('shadow', ['fields'])],
      ),
    );

    /* One ownership clash plus three unclaimed keys. */
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('claimed by both');
    expect(problems.filter((p) => p.includes('case "a"'))).toHaveLength(2);
    expect(problems.filter((p) => p.includes('case "b"'))).toHaveLength(1);
  });

  it('says so plainly when no scorer claims anything', () => {
    const problems = problemsFrom(() =>
      validateExpectations([evalCase({ expect: { fields: {} } })], []),
    );

    expect(problems[0]).toContain('no registered scorer claims any expectation key');
  });

  it('reports unclaimed keys in a deterministic order', () => {
    const first = problemsFrom(() =>
      validateExpectations([evalCase({ id: 'a', expect: { zeta: 1, alpha: 2 } })], []),
    );

    expect(first.map((p) => p.match(/key "(\w+)"/)?.[1])).toEqual(['alpha', 'zeta']);
  });
});
