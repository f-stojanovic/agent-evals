import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baselineFrom,
  compareToBaseline,
  describeBaselineChange,
  readBaseline,
  standardError,
  writeBaseline,
} from './baseline.js';
import type { Baseline } from './baseline.js';
import type { LockedModel } from './models-lock.js';
import type { CaseResult, SuiteResult } from './types.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MODELS: Record<string, LockedModel> = {
  embedding: { modelId: 'enc', revision: 'rev-1', dtype: 'fp32' },
};

function caseResult(overrides: Partial<CaseResult> & { caseId: string }): CaseResult {
  return {
    status: 'scored',
    vias: ['json'],
    weight: 1,
    scores: [],
    passed: true,
    value: 1,
    samples: 1,
    sampleValues: [1],
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function suite(results: CaseResult[]): SuiteResult {
  return {
    suiteId: 'test',
    startedAt: '2026-08-19T00:00:00.000Z',
    durationMs: 0,
    results,
    totals: {
      cases: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: 0,
      errored: results.filter((r) => r.status === 'errored').length,
      weightedScore: 1,
    },
    usage: { inputTokens: 0, outputTokens: 0 },
    latency: { p50Ms: 0, p95Ms: 0, maxMs: 0, totalMs: 0 },
    passed: true,
  };
}

function baseline(cases: Baseline['cases'], models = MODELS): Baseline {
  return {
    version: 1,
    recordedAt: '2026-08-01T00:00:00.000Z',
    models,
    cases,
    totals: { cases: Object.keys(cases).length, weightedScore: 1 },
  };
}

describe('the derived tolerance', () => {
  it('gives a noisy case a wide allowance and a stable one almost none', () => {
    const noisy = standardError({ mean: 0.6, stdDev: 0.35, n: 5, scorers: {} }, caseResult({ caseId: 'n', stdDev: 0.35, samples: 5 }));
    const stable = standardError({ mean: 0.95, stdDev: 0.01, n: 5, scorers: {} }, caseResult({ caseId: 's', stdDev: 0.01, samples: 5 }));

    /* The point of deriving rather than picking: one fixed number cannot be
       right for both of these. */
    expect(noisy).toBeGreaterThan(stable * 10);
  });

  it('flags a drop on a stable case that a noisy one would absorb', () => {
    const result = suite([caseResult({ caseId: 'stable', value: 0.88, stdDev: 0.01, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ stable: { mean: 0.95, stdDev: 0.01, n: 5, scorers: {} } }),
      MODELS,
    );

    expect(comparison.regressions.map((r) => r.caseId)).toEqual(['stable']);
    expect(comparison.ok).toBe(false);
  });

  it('allows the same drop on a noisy case', () => {
    const result = suite([caseResult({ caseId: 'noisy', value: 0.55, stdDev: 0.35, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ noisy: { mean: 0.6, stdDev: 0.35, n: 5, scorers: {} } }),
      MODELS,
    );

    expect(comparison.regressions).toEqual([]);
    expect(comparison.comparisons[0]?.status).toBe('unchanged');
  });

  it('falls back to the absolute floor when neither side has a spread', () => {
    const result = suite([caseResult({ caseId: 'once', value: 0.97, samples: 1 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ once: { mean: 1, n: 1, scorers: {} } }),
      MODELS,
    );

    /* se collapses to 0 with no measured variance, so only the floor is left —
       the degenerate case the doc block calls out. */
    /* The floor is the primary term; with no measured spread it is the only
       one left. */
    expect(comparison.comparisons[0]?.tolerance).toBeCloseTo(0.05);
    expect(comparison.regressions).toEqual([]);
  });

  it('honours a custom z', () => {
    const result = suite([caseResult({ caseId: 'c', value: 0.8, stdDev: 0.1, samples: 4 })]);
    const recorded = baseline({ c: { mean: 0.95, stdDev: 0.1, n: 4, scorers: {} } });

    expect(compareToBaseline(result, recorded, MODELS, { z: 1 }).regressions).toHaveLength(1);
    expect(compareToBaseline(result, recorded, MODELS, { z: 4 }).regressions).toHaveLength(0);
  });

  it('reports an improvement without failing the run', () => {
    const result = suite([caseResult({ caseId: 'c', value: 0.95, stdDev: 0.01, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 0.7, stdDev: 0.01, n: 5, scorers: {} } }),
      MODELS,
    );

    expect(comparison.comparisons[0]?.status).toBe('improved');
    expect(comparison.ok).toBe(true);
  });
});

describe('compareToBaseline', () => {
  it('treats a model change as a hard failure, not a warning', () => {
    const result = suite([caseResult({ caseId: 'c' })]);

    const comparison = compareToBaseline(result, baseline({ c: { mean: 1, n: 1, scorers: {} } }), {
      embedding: { modelId: 'enc', revision: 'rev-2', dtype: 'fp32' },
    });

    /* Scores are not comparable across revisions, so this is not a weaker
       comparison — it is a meaningless one. */
    expect(comparison.ok).toBe(false);
    expect(comparison.modelMismatches[0]).toContain('not comparable across model revisions');
  });

  it('reports a new case without calling it a regression', () => {
    const result = suite([caseResult({ caseId: 'fresh', value: 0.4 })]);

    const comparison = compareToBaseline(result, baseline({}), MODELS);

    expect(comparison.newCases.map((c) => c.caseId)).toEqual(['fresh']);
    expect(comparison.regressions).toEqual([]);
    /* Still requires an explicit baseline update to be recorded. */
    expect(comparison.ok).toBe(true);
  });

  it('fails when a baselined case has vanished from the suite', () => {
    const result = suite([caseResult({ caseId: 'kept' })]);

    const comparison = compareToBaseline(
      result,
      baseline({ kept: { mean: 1, n: 1, scorers: {} }, deleted: { mean: 0.2, n: 1, scorers: {} } }),
      MODELS,
    );

    /* Deleting a failing case is the cheapest way to make a gate green. */
    expect(comparison.missingCases).toEqual(['deleted']);
    expect(comparison.ok).toBe(false);
  });

  it('fails on an errored case and never compares it', () => {
    const result = suite([caseResult({ caseId: 'c', status: 'errored', value: 0 })]);

    const comparison = compareToBaseline(result, baseline({ c: { mean: 1, n: 1, scorers: {} } }), MODELS);

    expect(comparison.erroredCases).toEqual(['c']);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.ok).toBe(false);
  });

  it('treats every case as new when there is no baseline yet', () => {
    const comparison = compareToBaseline(suite([caseResult({ caseId: 'c' })]), undefined, MODELS);

    expect(comparison.newCases).toHaveLength(1);
    expect(comparison.ok).toBe(true);
  });
});

describe('baselineFrom', () => {
  it('records only mean, stdDev, n and per-scorer means', () => {
    const result = suite([
      caseResult({
        caseId: 'c',
        value: 0.75,
        stdDev: 0.1,
        samples: 3,
        sampleValues: [0.6, 0.8, 0.85],
        scores: [{ scorer: 'exact-fields', value: 0.75, passed: false }],
        output: { raw: { secret: 'customer email' }, model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 },
      }),
    ]);

    const recorded = baselineFrom(result, MODELS);

    expect(recorded.cases['c']).toEqual({
      mean: 0.75,
      stdDev: 0.1,
      n: 3,
      scorers: { 'exact-fields': 0.75 },
    });
    /* No raw output, no per-sample values, no transcripts (ADR 003). */
    expect(JSON.stringify(recorded)).not.toContain('customer email');
    expect(JSON.stringify(recorded)).not.toContain('0.85');
  });

  it('refuses to record a baseline when a case errored', () => {
    const result = suite([caseResult({ caseId: 'broken', status: 'errored' })]);

    expect(() => baselineFrom(result, MODELS)).toThrow(/Refusing to record a baseline/);
  });

  it('round-trips through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-evals-baseline-'));
    created.push(dir);
    const path = join(dir, 'baseline.json');
    const recorded = baselineFrom(suite([caseResult({ caseId: 'c', value: 0.5 })]), MODELS);

    await writeBaseline(recorded, path);

    await expect(readBaseline(path)).resolves.toEqual(recorded);
  });

  it('returns undefined for a baseline that does not exist yet', async () => {
    await expect(readBaseline(join(tmpdir(), 'nope-agent-evals.json'))).resolves.toBeUndefined();
  });
});

describe('describeBaselineChange', () => {
  it('summarises what moved so the commit message writes itself', () => {
    const before = baseline({
      up: { mean: 0.5, n: 1, scorers: {} },
      gone: { mean: 0.5, n: 1, scorers: {} },
    });
    const after = baseline({
      up: { mean: 0.9, n: 1, scorers: {} },
      fresh: { mean: 1, n: 1, scorers: {} },
    });

    const summary = describeBaselineChange(before, after);

    expect(summary).toContain('↑ up: 0.500 → 0.900');
    expect(summary).toContain('+ fresh: 1.000 (new)');
    expect(summary).toContain('- gone: removed');
  });

  it('describes a first recording', () => {
    expect(describeBaselineChange(undefined, baseline({ a: { mean: 1, n: 1, scorers: {} } })))
      .toContain('Recorded a new baseline: 1 cases');
  });
});
