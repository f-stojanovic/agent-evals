import { describe, expect, it } from 'vitest';
import { exitCode, formatReport } from './report.js';
import type { BaselineComparison } from './baseline.js';
import type { RunSummary } from './runner.js';
import type { CaseResult, Cost } from './types.js';

function caseResult(overrides: Partial<CaseResult> & { caseId: string }): CaseResult {
  return {
    status: 'scored',
    vias: ['json'],
    weight: 1,
    scores: [{ scorer: 'exact-fields', value: 1, passed: true }],
    passed: true,
    value: 1,
    samples: 1,
    sampleValues: [1],
    latencyMs: 12,
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  const results = overrides.results ?? [caseResult({ caseId: 'a' })];
  return {
    suiteId: 'test',
    startedAt: '2026-08-19T00:00:00.000Z',
    durationMs: 1200,
    results,
    totals: { cases: results.length, passed: 1, failed: 0, errored: 0, weightedScore: 1 },
    usage: { inputTokens: 10, outputTokens: 5 },
    latency: { p50Ms: 12, p95Ms: 12, maxMs: 12, totalMs: 12 },
    passed: true,
    uncalibrated: [],
    viaDistribution: { json: 1 },
    ...overrides,
  };
}

const clean: BaselineComparison = {
  ok: true,
  uncalibrated: [],
  comparisons: [{ caseId: 'a', status: 'unchanged', currentMean: 1, baselineMean: 1, delta: 0, tolerance: 0.01 }],
  regressions: [],
  newCases: [],
  missingCases: [],
  erroredCases: [],
  modelMismatches: [],
  scorerSetMismatch: [],
};

describe('formatReport', () => {
  it('shows the derived tolerance beside every delta', () => {
    const rendered = formatReport({ run: run(), comparison: clean, models: {} });

    /* The allowance is per case and derived, so printing it is the difference
       between "this passed" and "this passed by this much". */
    expect(rendered).toContain('+0.000 (±0.010)');
  });

  it('reports the suite-wide via distribution as a metric', () => {
    const rendered = formatReport({
      run: run({ viaDistribution: { json: 6, scavenged: 3, none: 1 } }),
      comparison: clean,
      models: {},
    });

    /* Describes the run; grades nothing. formatCompliance is the scorer that
       grades, per case, against what that case declared. */
    expect(rendered).toContain('- json: 6 (60%)');
    expect(rendered).toContain('- scavenged: 3 (30%)');
  });

  it('separates errored cases from failures and explains why', () => {
    const errored = run({
      results: [caseResult({ caseId: 'e', status: 'errored', value: 0, error: { message: 'no payload' } })],
      totals: { cases: 1, passed: 0, failed: 0, errored: 1, weightedScore: 0 },
    });

    const rendered = formatReport({
      run: errored,
      comparison: { ...clean, ok: false, erroredCases: ['e'] },
      models: {},
    });

    expect(rendered).toContain('## Errored');
    expect(rendered).toContain('a score of 0 would assert the model was wrong');
    expect(rendered).toContain('no payload');
  });

  it('splits subject cost from judge cost', () => {
    const rendered = formatReport({
      run: run({
        cost: { kind: 'known', breakdown: { inputUsd: 1, outputUsd: 2, totalUsd: 3 } },
        subjectCost: {
          kind: 'known',
          breakdown: { inputUsd: 0.5, outputUsd: 0.5, totalUsd: 1 },
        },
        judgeCost: { kind: 'known', breakdown: { inputUsd: 0.5, outputUsd: 1.5, totalUsd: 2 } },
      }),
      comparison: clean,
      models: {},
    });

    /* Grading is usually the expensive half, and an unitemised cost does not
       get optimised. */
    expect(rendered).toContain('subject $1.0000, judge $2.0000');
  });

  /**
   * THE DISTINCTION THIS SECTION EXISTS FOR.
   *
   * A report that computes "known" apart from "unknown" and then prints both
   * the same way has not made the distinction — it has only paid for it. These
   * assert the four outcomes are visibly different to a reader:
   *
   *   $0.0000  known, and zero — this really was free
   *   ?        something is not known
   *   —        nothing ran
   *
   * and that an unknown total never appears as a bare figure.
   */
  describe('cost', () => {
    const rendered = (cost?: Cost, caseCost?: Cost): string =>
      formatReport({
        run: run({
          ...(cost !== undefined && { cost }),
          results: [caseResult({ caseId: 'a', ...(caseCost !== undefined && { cost: caseCost }) })],
        }),
        comparison: clean,
        models: {},
      });

    it('distinguishes a genuinely free run from an unknown one', () => {
      const free = rendered({ kind: 'known', breakdown: { inputUsd: 0, outputUsd: 0, totalUsd: 0 } });
      expect(free).toContain('$0.0000');
      expect(free).not.toContain('unknown');
    });

    it('says which model has no price entry, rather than "not priced" for everything', () => {
      const out = rendered({ kind: 'unknown', gaps: [{ kind: 'unpriced', model: 'mystery-1' }] });
      expect(out).toContain('cost: **unknown**');
      expect(out).toContain('no price table entry for "mystery-1"');
    });

    it('reports an uncomputable cost as its own finding, not as a pricing gap', () => {
      const out = rendered({
        kind: 'unknown',
        gaps: [{ kind: 'uncomputable', detail: 'judge: inputTokens is missing' }],
      });
      expect(out).toContain('cost: **unknown**');
      expect(out).toContain('inputTokens is missing');
      /* The old renderer said this, and it would have been a diagnosis nobody
         made: the price table was never the problem here. */
      expect(out).not.toContain('no price table entry');
    });

    it('never prints an unknown total as a figure, even when part was priced', () => {
      const out = rendered({
        kind: 'unknown',
        gaps: [{ kind: 'unpriced', model: 'mystery-1' }],
        pricedPortion: { inputUsd: 0.01, outputUsd: 0.05, totalUsd: 0.06 },
      });
      /* The figure is present — dropping what the run does know would be its own
         dishonesty — but it is labelled a portion and the line leads with the
         word. */
      expect(out).toContain('cost: **unknown**');
      expect(out).toContain('only $0.0600 of it could be priced');
      expect(out).not.toContain('cost: **$0.0600**');
    });

    it('marks an unknown case cost with ? and an absent one with a dash', () => {
      const unknown = rendered(undefined, { kind: 'unknown', gaps: [{ kind: 'unpriced', model: 'm' }] });
      /* The row for case `a`, not the totals block. */
      /* The data row for case `a`, not the totals block. The id column is
         right-padded, so this matches the cell rather than a literal "| a ". */
      const dataRow = (rendered_: string): string =>
        rendered_.split('\n').find((line) => /^\|\s+a\s+\|/.test(line)) ?? '';

      const row = dataRow(unknown);
      expect(row).toContain('?');
      expect(row).not.toContain('$');

      const absentRow = dataRow(rendered(undefined, undefined));
      expect(absentRow).not.toContain('?');
      expect(absentRow).not.toContain('$');
    });

    it('says nothing ran, rather than blaming the price table, when no cost exists', () => {
      const out = rendered(undefined, undefined);
      expect(out).toContain('no priced component ran');
      expect(out).not.toContain('no price table entry');
    });
  });

  it('lists the models and their revisions', () => {
    const rendered = formatReport({
      run: run(),
      comparison: clean,
      models: { embedding: { modelId: 'enc', revision: 'abc123', dtype: 'fp32' } },
    });

    expect(rendered).toContain('embedding: `enc` @ abc123 (fp32)');
  });

  it('counts the assumptions that took part', () => {
    const rendered = formatReport({
      run: run({ uncalibrated: [{ id: 'judge.samples', value: 3, note: 'verdicts per case' }] }),
      comparison: clean,
      models: {},
    });

    expect(rendered).toContain('This run used 1 uncalibrated constant:');
    expect(rendered).toContain('judge.samples = 3');
  });

  it('explains a missing case rather than just listing it', () => {
    const rendered = formatReport({
      run: run(),
      comparison: { ...clean, ok: false, missingCases: ['deleted-01'] },
      models: {},
    });

    expect(rendered).toContain('Deleting a failing case is the cheapest way to make a gate green');
    expect(rendered).toContain('deleted-01');
  });
});

describe('exitCode', () => {
  it('is 0 when the comparison is ok and 1 when it is not', () => {
    expect(exitCode(clean)).toBe(0);
    expect(exitCode({ ...clean, ok: false })).toBe(1);
  });
});

describe('the gate verdict', () => {
  it('states PASS on its own line, above the tally', () => {
    const rendered = formatReport({ run: run(), comparison: clean, models: {} });

    /* "passed 0 · failed 3" above an exit code of 0 read as a broken suite.
       The gate's answer now leads, and the tally is named for what it counts. */
    expect(rendered).toContain('**GATE: PASS** — no regression against the baseline.');
    expect(rendered).toContain('below threshold:');
    expect(rendered).not.toContain('· passed ');
  });

  it('states FAIL and why', () => {
    const rendered = formatReport({
      run: run(),
      comparison: {
        ...clean,
        ok: false,
        regressions: [{ caseId: 'a', status: 'regressed', currentMean: 0.5 }],
        missingCases: ['gone'],
      },
      models: {},
    });

    expect(rendered).toContain('**GATE: FAIL** — 1 regression, 1 missing from the suite.');
  });

  it('reports the extraction route per case, not only suite-wide', () => {
    const mixed = run({
      results: [caseResult({ caseId: 'a', vias: ['fenced', 'fenced', 'fenced', 'fenced', 'json'] })],
    });

    /* The live run fenced 5/5 on one case and 0/5 on another under an
       identical prompt. A suite total averages that finding away. */
    expect(formatReport({ run: mixed, comparison: clean, models: {} })).toContain('fenced 4/5, json 1/5');
  });

  it('collapses a unanimous case to a bare route name', () => {
    const uniform = run({ results: [caseResult({ caseId: 'a', vias: ['tool-call', 'tool-call'] })] });

    expect(formatReport({ run: uniform, comparison: clean, models: {} })).toContain('| tool-call ');
  });
});
