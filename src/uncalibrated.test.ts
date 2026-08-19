import { describe, expect, it } from 'vitest';
import { collectUncalibrated, formatUncalibratedReport } from './uncalibrated.js';
import { llmJudge } from './scorers/judge.js';
import { exactFields } from './scorers/exact.js';
import type { Score, ScoreArgs, Scorer, UncalibratedConstant } from './types.js';

function scorerWith(name: string, uncalibrated: UncalibratedConstant[]): Scorer {
  return {
    name,
    claims: [],
    consumesExtraction: false,
    uncalibrated,
    score: (_args: ScoreArgs): Promise<Score> =>
      Promise.resolve({ scorer: name, value: 1, passed: true }),
  };
}

const stubJudgeClient = {
  model: 'stub',
  locked: () => Promise.resolve({ modelId: 'stub', revision: null, dtype: 'hosted' }),
  evaluate: () =>
    Promise.resolve({
      verdict: { score: 1, reason: 'r', confidence: 1 },
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'stub',
    }),
};

describe('collectUncalibrated', () => {
  it('gathers constants from the registered scorers', () => {
    const constants = collectUncalibrated([
      scorerWith('a', [{ id: 'a.t', value: 0.5, note: 'a guess' }]),
      scorerWith('b', [{ id: 'b.t', value: 0.9, note: 'another' }]),
    ]);

    expect(constants.map((c) => c.id)).toEqual(['a.t', 'b.t']);
  });

  it('sorts by id so the report is stable across runs', () => {
    const constants = collectUncalibrated([
      scorerWith('z', [{ id: 'zulu', value: 1, note: 'z' }]),
      scorerWith('a', [{ id: 'alpha', value: 2, note: 'a' }]),
    ]);

    expect(constants.map((c) => c.id)).toEqual(['alpha', 'zulu']);
  });

  it('ignores scorers that guess nothing', () => {
    /* exactFields' threshold of 1 is definitional — exact means exact — not a
       guess, so it declares none. */
    expect(collectUncalibrated([exactFields()])).toEqual([]);
  });

  it('describes only the run it was given, not every module imported', () => {
    /* The old global registry counted a constant as soon as its module was
       imported, so merely importing the judge inflated the count for a run
       that never used it. */
    const withoutJudge = collectUncalibrated([exactFields()]);
    const withJudge = collectUncalibrated([exactFields(), llmJudge({ judge: stubJudgeClient })]);

    expect(withoutJudge).toHaveLength(0);
    expect(withJudge.length).toBeGreaterThan(0);
  });

  it('does not report a constant the caller supplied', () => {
    const configured = llmJudge({
      judge: stubJudgeClient,
      samples: 5,
      threshold: 0.6,
      disagreementThreshold: 0.4,
    });

    /* A threshold the caller chose is the caller's business; reporting it as
       this scorer's guess would be a lie about who assumed what. */
    expect(collectUncalibrated([configured])).toEqual([]);
  });

  it('reports the judge defaults that were left unset', () => {
    const ids = collectUncalibrated([llmJudge({ judge: stubJudgeClient })]).map((c) => c.id);

    expect(ids).toEqual([
      'llm-judge.disagreementThreshold',
      'llm-judge.samples',
      'llm-judge.threshold',
    ]);
  });
});

describe('formatUncalibratedReport', () => {
  it('says plainly when nothing was guessed', () => {
    expect(formatUncalibratedReport([])).toBe('This run used no uncalibrated constants.');
  });

  it('counts and lists the assumptions', () => {
    const rendered = formatUncalibratedReport([
      { id: 'semantic.threshold', value: 0.8, note: 'cosine cutoff, not measured' },
      { id: 'judge.samples', value: 3, note: 'verdicts per case' },
    ]);

    expect(rendered).toContain('2 uncalibrated constants');
    expect(rendered).toContain('semantic.threshold = 0.8');
    expect(rendered).toContain('cosine cutoff, not measured');
  });

  it('uses the singular for one', () => {
    expect(formatUncalibratedReport([{ id: 'only', value: 1, note: 'one' }])).toContain(
      '1 uncalibrated constant:',
    );
  });
});
