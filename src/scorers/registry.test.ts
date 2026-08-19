import { describe, expect, it } from 'vitest';
import { ExpectationError, applicableScorers, validateExpectations } from './registry.js';
import { callsTool, exactFields, matchesSchema } from './exact.js';
import { evalCase } from '../testing.js';
import type { ExpectationClaim, Score, Scorer } from '../types.js';

/** A scorer that claims whatever the test needs and never runs. */
function stubScorer(name: string, claims: readonly ExpectationClaim[]): Scorer {
  return {
    name,
    claims,
    score: (): Promise<Score> => Promise.resolve({ scorer: name, value: 1, passed: true }),
  };
}

const required = (key: string): ExpectationClaim => ({ key, required: true });
const optional = (key: string): ExpectationClaim => ({ key, required: false });

function problemsFrom(fn: () => void): readonly string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpectationError);
    return (error as ExpectationError).problems;
  }
  throw new Error('expected validateExpectations to throw');
}

describe('applicableScorers', () => {
  it('skips a scorer whose required key the case does not declare', () => {
    const applicable = applicableScorers(evalCase({ expect: { fields: { a: 1 } } }), [
      exactFields(),
      matchesSchema(),
    ]);

    /* Skipped, not failed: a schema check against a case that declares no
       schema has no opinion to record. */
    expect(applicable.map((s) => s.name)).toEqual(['exact-fields']);
  });

  it('runs a scorer with only optional claims against any case', () => {
    const applicable = applicableScorers(evalCase({ expect: { fields: { a: 1 } } }), [
      stubScorer('advisory', [optional('hint')]),
    ]);

    expect(applicable.map((s) => s.name)).toEqual(['advisory']);
  });
});

describe('validateExpectations', () => {
  it('accepts cases whose expectation keys are all claimed and measured', () => {
    expect(() =>
      validateExpectations(
        [
          evalCase({ id: 'a', expect: { fields: { intent: 'refund' } } }),
          evalCase({ id: 'b', expect: { schema: {}, toolCalls: [] } }),
        ],
        [exactFields(), matchesSchema(), callsTool()],
      ),
    ).not.toThrow();
  });

  it('rejects an unclaimed key and suggests the intended spelling', () => {
    /* The failure this check exists for: `field` instead of `fields` loads
       fine, is read by nobody, and would report green. */
    const problems = problemsFrom(() =>
      validateExpectations(
        [evalCase({ id: 'refund-01', expect: { field: { intent: 'refund' }, schema: {} } })],
        [exactFields(), matchesSchema()],
      ),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unclaimed key "field" in 1 case');
    expect(problems[0]).toContain('did you mean "fields"?');
    expect(problems[0]).toContain('refund-01');
  });

  it('groups an unclaimed key across cases and caps the id list at five', () => {
    const cases = Array.from({ length: 8 }, (_, i) =>
      evalCase({ id: `case-${i}`, expect: { field: {}, fields: { a: 1 } } }),
    );

    const problems = problemsFrom(() => validateExpectations(cases, [exactFields()]));

    /* One mistake copy-pasted eight times is one problem, not eight. */
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('in 8 cases');
    expect(problems[0]).toContain('case-0, case-1, case-2, case-3, case-4, ... (+3 more)');
  });

  it('lists the claimed keys when nothing is close enough to suggest', () => {
    const problems = problemsFrom(() =>
      validateExpectations(
        [evalCase({ id: 'a', expect: { rubric: 'be nice', fields: { x: 1 } } })],
        [exactFields(), matchesSchema()],
      ),
    );

    expect(problems[0]).toContain('claimed keys are "fields", "schema"');
  });

  it('rejects a case that every scorer skips, naming the missing keys', () => {
    /* Each skip is individually correct; together they mean the case runs,
       costs money, and checks nothing. */
    const problems = problemsFrom(() =>
      validateExpectations([evalCase({ id: 'unmeasured-01', expect: {} })], [
        exactFields(),
        matchesSchema(),
      ]),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('case "unmeasured-01" is measured by no scorer');
    expect(problems[0]).toContain('"exact-fields" skipped (missing required "fields")');
    expect(problems[0]).toContain('"matches-schema" skipped (missing required "schema")');
  });

  it('does not count a scorer that applies but reads none of the case keys', () => {
    /* A scorer with no required claims applies everywhere. If that counted as
       measurement it would silently disable this guard for every suite that
       registers one. */
    const problems = problemsFrom(() =>
      validateExpectations(
        [evalCase({ id: 'thin-01', expect: {} })],
        [stubScorer('advisory', [optional('hint')])],
      ),
    );

    expect(problems[0]).toContain('is measured by no scorer');
    expect(problems[0]).toContain('reads none of this case\'s expectation keys');
  });

  it('accepts a case measured only by an optional-claim scorer that it opts into', () => {
    expect(() =>
      validateExpectations(
        [evalCase({ expect: { hint: 'be terse' } })],
        [stubScorer('advisory', [optional('hint')])],
      ),
    ).not.toThrow();
  });

  it('says so plainly when no scorers are registered at all', () => {
    const problems = problemsFrom(() =>
      validateExpectations([evalCase({ id: 'a', expect: { fields: {} } })], []),
    );

    expect(problems.some((p) => p.includes('no scorers are registered'))).toBe(true);
    expect(problems.some((p) => p.includes('no registered scorer claims any'))).toBe(true);
  });

  it('rejects a meta key that collides with a claimed key, with no opt-out', () => {
    /* `meta` exists for things that are not expectations. An expectation
       parked there is silently unenforced, and no suite ever wants that. */
    const problems = problemsFrom(() =>
      validateExpectations(
        [
          evalCase({
            id: 'sneaky-01',
            expect: { schema: {} },
            meta: { fields: { intent: 'refund' }, owner: 'filip' },
          }),
        ],
        [exactFields(), matchesSchema()],
      ),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`meta.fields` collides');
    expect(problems[0]).toContain('exact-fields');
    expect(problems[0]).toContain('move it into `expect`');
  });

  it('leaves non-colliding meta keys alone', () => {
    expect(() =>
      validateExpectations(
        [evalCase({ expect: { fields: { a: 1 } }, meta: { owner: 'filip', ticket: 'EVAL-12' } })],
        [exactFields()],
      ),
    ).not.toThrow();
  });

  it('allows two scorers to claim the same key', () => {
    /* Nothing dispatches by key: the runner runs every applicable scorer and
       each writes its own column, so two scorers reading `fields` is not
       ambiguous. An earlier version rejected this, importing an intuition from
       static analysis where a rule really does own its identifier. ADR 003. */
    expect(() =>
      validateExpectations(
        [evalCase({ id: 'a', expect: { fields: { x: 1 } } })],
        [exactFields(), exactFields({ name: 'exact-fields-lenient' })],
      ),
    ).not.toThrow();
  });

  it('rejects a duplicate scorer name and points at the `name` option', () => {
    const problems = problemsFrom(() =>
      validateExpectations([], [exactFields(), exactFields({ threshold: 0.5 })]),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('duplicate scorer name');
    expect(problems[0]).toContain('`name` option');
  });

  it('records both configurations of one factory under distinct names', async () => {
    const strict = exactFields();
    const lenient = exactFields({ name: 'exact-fields-lenient' });

    /* The `name` override and shared keys are what make this work: two
       measurements of the same expectation, two baseline columns. */
    expect(() =>
      validateExpectations([evalCase({ expect: { fields: { a: 1 } } })], [strict, lenient]),
    ).not.toThrow();
    expect([strict.name, lenient.name]).toEqual(['exact-fields', 'exact-fields-lenient']);
    await Promise.resolve();
  });

  it('accepts differently-named scorers that read different keys', () => {
    expect(() =>
      validateExpectations(
        [evalCase({ expect: { fields: { a: 1 }, tone: 'formal' } })],
        [exactFields(), stubScorer('tone-check', [optional('tone')])],
      ),
    ).not.toThrow();
  });

  it('reports every problem in one pass, scorer-side problems first', () => {
    const problems = problemsFrom(() =>
      validateExpectations(
        [
          evalCase({ id: 'a', expect: { field: {}, tools: [] } }),
          evalCase({ id: 'b', expect: {} }),
        ],
        [exactFields(), stubScorer('shadow', [required('fields')])],
      ),
    );

    expect(problems.some((p) => p.includes('case "a" is measured by no scorer'))).toBe(true);
    expect(problems.some((p) => p.includes('case "b" is measured by no scorer'))).toBe(true);
    expect(problems.some((p) => p.includes('unclaimed key "field"'))).toBe(true);
    expect(problems.some((p) => p.includes('unclaimed key "tools"'))).toBe(true);
  });

  it('reports unclaimed keys in a deterministic order', () => {
    const problems = problemsFrom(() =>
      validateExpectations(
        [evalCase({ id: 'a', expect: { zeta: 1, alpha: 2, fields: { x: 1 } } })],
        [exactFields()],
      ),
    );

    expect(problems.map((p) => p.match(/unclaimed key "(\w+)"/)?.[1]).filter(Boolean)).toEqual([
      'alpha',
      'zeta',
    ]);
  });
});
