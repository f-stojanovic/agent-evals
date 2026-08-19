import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calibrate, formatCalibrationReport, loadCalibrationCases } from './calibrate.js';
import { subjectOutput } from './testing.js';
import type { CalibrationCase } from './calibrate.js';
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

const calibrationCase = (id: string, humanScore: number): CalibrationCase => ({
  id,
  provenance: { kind: 'hand-authored', author: 'test' },
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

  it('gives every case a frozen output, so calibration measures only the judge', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration', import.meta.url));

    const cases = await loadCalibrationCases(dir);

    expect(
      cases.every((c) => c.output.text !== undefined || (c.output.toolCalls?.length ?? 0) > 0),
    ).toBe(true);
  });
});
