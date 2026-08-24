import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calibrate, formatCalibrationReport, loadCalibrationCases } from './calibrate.js';
import { subjectOutput } from './testing.js';
import type { CalibrationCase, LabelKind } from './calibrate.js';
import type { Score, ScoreArgs, Scorer } from './types.js';

/** A scorer with hardcoded answers per case id, so the MAE arithmetic is
 *  checked against numbers the test states outright. */
function fixedScorer(scores: Record<string, number>): Scorer {
  return {
    name: 'fixed',
    claims: [{ key: 'rubric', required: true }],
    consumesExtraction: false,
    score: ({ case: evalCase }: ScoreArgs): Promise<Score> =>
      Promise.resolve({
        scorer: 'fixed',
        value: scores[evalCase.id] ?? 0,
        passed: true,
        reason: `fixed ${scores[evalCase.id] ?? 0}`,
        meta: { judgeDisagreement: 0.1 },
      }),
  };
}

const calibrationCase = (
  id: string,
  humanScore: number,
  labelKind: LabelKind = 'ground-truth',
): CalibrationCase => ({
  id,
  provenance: { kind: 'hand-authored', author: 'test' },
  labelKind,
  humanScore,
  expect: { rubric: 'anything' },
  output: subjectOutput({ text: 'output' }),
});

describe('calibrate', () => {
  it('computes mean absolute error against the human labels', async () => {
    const report = await calibrate({
      cases: [
        calibrationCase('a', 1.0),
        calibrationCase('b', 0.0),
        calibrationCase('c', 0.5),
      ],
      scorer: fixedScorer({ a: 0.9, b: 0.2, c: 0.5 }),
    });

    /* Errors are 0.1, 0.2, 0.0 → MAE 0.1. */
    expect(report.meanAbsoluteError).toBeCloseTo(0.1);
  });

  it('reports signed error separately, because bias and noise need different fixes', async () => {
    const generous = await calibrate({
      cases: [calibrationCase('a', 0.5), calibrationCase('b', 0.5)],
      scorer: fixedScorer({ a: 0.7, b: 0.7 }),
    });
    const noisy = await calibrate({
      cases: [calibrationCase('a', 0.5), calibrationCase('b', 0.5)],
      scorer: fixedScorer({ a: 0.7, b: 0.3 }),
    });

    /* Same MAE, completely different problems: one judge is uniformly too
       generous and can be corrected by moving a threshold, the other is
       random and cannot. */
    expect(generous.meanAbsoluteError).toBeCloseTo(noisy.meanAbsoluteError);
    expect(generous.meanSignedError).toBeCloseTo(0.2);
    expect(noisy.meanSignedError).toBeCloseTo(0);
  });

  it('ranks the largest divergences first', async () => {
    const report = await calibrate({
      cases: [
        calibrationCase('close', 1.0),
        calibrationCase('far', 1.0),
        calibrationCase('middling', 1.0),
      ],
      scorer: fixedScorer({ close: 0.95, far: 0.1, middling: 0.6 }),
    });

    expect(report.worst.map((r) => r.caseId)).toEqual(['far', 'middling', 'close']);
  });

  it('records per-case judge disagreement alongside the error', async () => {
    const report = await calibrate({
      cases: [calibrationCase('a', 1)],
      scorer: fixedScorer({ a: 1 }),
    });

    expect(report.results[0]?.disagreement).toBeCloseTo(0.1);
  });

  it('refuses to report on an empty set', async () => {
    await expect(calibrate({ cases: [], scorer: fixedScorer({}) })).rejects.toThrow(
      /no calibration cases/,
    );
  });

  it('renders a table with both error figures', async () => {
    const report = await calibrate({
      cases: [calibrationCase('a', 1.0), calibrationCase('b', 0.0)],
      scorer: fixedScorer({ a: 0.9, b: 0.2 }),
    });

    const rendered = formatCalibrationReport(report);

    expect(rendered).toContain('mean absolute error');
    expect(rendered).toContain('mean signed error');
    expect(rendered).toContain('Largest divergences');
    expect(rendered).toContain('0.150');
  });

  /* A contested label is one annotator's line through a genuine ambiguity. The
     judge disagreeing with it is not evidence the judge is wrong, so an MAE
     that mixes it in reports disagreement about the world as inaccuracy in the
     instrument. Both figures are published; neither replaces the other. */
  it('separates error against contested labels from error against ground truth', async () => {
    const report = await calibrate({
      cases: [
        calibrationCase('solid', 1.0),
        calibrationCase('ambiguous', 0.4, 'contested'),
      ],
      scorer: fixedScorer({ solid: 0.9, ambiguous: 0.8 }),
    });

    /* Errors are 0.1 and 0.4 → headline 0.25, ground-truth-only 0.1. */
    expect(report.meanAbsoluteError).toBeCloseTo(0.25);
    expect(report.meanAbsoluteErrorGroundTruth).toBeCloseTo(0.1);

    const rendered = formatCalibrationReport(report);
    expect(rendered).toContain('ground-truth only');
    expect(rendered).toContain('ambiguous');
  });

  /* Excluding every case would leave `mean(...)` returning 0, which renders as
     0.000 and reads as perfect agreement. It has to fall back instead. */
  it('does not report a ground-truth MAE of zero when nothing is ground truth', async () => {
    const report = await calibrate({
      cases: [calibrationCase('a', 0.4, 'contested'), calibrationCase('b', 0.6, 'contested')],
      scorer: fixedScorer({ a: 0.8, b: 0.2 }),
    });

    expect(report.meanAbsoluteErrorGroundTruth).toBeCloseTo(report.meanAbsoluteError);
    expect(report.meanAbsoluteErrorGroundTruth).toBeGreaterThan(0);
  });
});

describe('loadCalibrationCases', () => {
  it('loads the committed calibration set, spread across the score range', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration', import.meta.url));

    const cases = await loadCalibrationCases(dir);

    expect(cases.length).toBeGreaterThanOrEqual(6);
    /* A calibration set of only easy cases reports a flattering number that
       says nothing about the cases a judge was needed for. */
    expect(cases.some((c) => c.humanScore === 1)).toBe(true);
    expect(cases.some((c) => c.humanScore === 0)).toBe(true);
    expect(cases.some((c) => c.humanScore > 0 && c.humanScore < 1)).toBe(true);
    expect(cases.every((c) => typeof c.expect['rubric'] === 'string')).toBe(true);
  });

  it('requires every case to declare where its output came from', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration', import.meta.url));

    const cases = await loadCalibrationCases(dir);

    /* Provenance is a required field, so this cannot silently become false by
       somebody adding a case and not thinking about it. */
    expect(cases.every((c) => c.provenance !== undefined)).toBe(true);
    /* Recorded as the truth: these outputs were written by hand, so the MAE is
       agreement about invented outputs. ADR 015. */
    expect(cases.every((c) => c.provenance.kind === 'hand-authored')).toBe(true);
  });

  /**
   * A rubric may state a RULE. It may not state the answer.
   *
   * "Deduct roughly 0.25 per wrong field" applies to any output a subject could
   * produce. "Score it around 0.3" applies only to the one output sitting in
   * front of the judge, and what comes back is then instruction-following
   * wearing the clothes of judgement. It is not a hypothetical failure: two
   * rubrics here carried target scores until 2026-08-24, and on
   * cal-prose-not-json-01 the judge returned 0.30 against a rubric that said
   * "score it around 0.3" — the calibration set was measuring its own
   * instruction. See ADR 021.
   */
  it('states rules in its rubrics and never a target score', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration', import.meta.url));
    const cases = await loadCalibrationCases(dir);

    if (cases.length === 0) {
      throw new Error('This check inspected nothing: no calibration cases loaded.');
    }

    /* "score ... around 0.3", "should score around 0.6". Deliberately not
       "any number in a rubric": the arithmetic rules are numbers too, and a
       check that forbade those would be reworded around within a week. */
    const target = /scor\w*\s+(?:it|this|the output|them)?\s*(?:around|approximately|about|roughly)\s*[01](?:\.\d+)?/i;

    const offenders = cases
      .filter((c) => target.test(String(c.expect['rubric'] ?? '')))
      .map((c) => c.id);

    expect(offenders).toEqual([]);
  });

  it('declares for every label whether a ground truth exists', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration', import.meta.url));
    const cases = await loadCalibrationCases(dir);

    if (cases.length === 0) {
      throw new Error('This check inspected nothing: no calibration cases loaded.');
    }

    /* Required by the schema, so a new case cannot be added without somebody
       deciding which kind its label is. */
    expect(cases.every((c) => c.labelKind === 'ground-truth' || c.labelKind === 'contested')).toBe(
      true,
    );
    /* If everything were contested there would be no judge-error figure at all;
       if nothing were, the set would be claiming the ambiguous case has a right
       answer. Both are findings, and both should fail loudly. */
    expect(cases.some((c) => c.labelKind === 'ground-truth')).toBe(true);
    expect(cases.some((c) => c.labelKind === 'contested')).toBe(true);
  });

  it('gives every case a frozen output, so calibration measures only the judge', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration', import.meta.url));

    const cases = await loadCalibrationCases(dir);

    expect(
      cases.every((c) => c.output.text !== undefined || (c.output.toolCalls?.length ?? 0) > 0),
    ).toBe(true);
  });
});
