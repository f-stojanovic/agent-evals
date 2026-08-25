import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

const SCORERS = ['exact-fields'];

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

function baseline(
  cases: Baseline['cases'],
  models = MODELS,
  scorers: string[] = SCORERS,
): Baseline {
  return {
    version: 1,
    recordedAt: '2026-08-01T00:00:00.000Z',
    models,
    scorers,
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
      SCORERS,
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
      SCORERS,
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
      SCORERS,
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

    expect(compareToBaseline(result, recorded, MODELS, SCORERS, { z: 1 }).regressions).toHaveLength(1);
    expect(compareToBaseline(result, recorded, MODELS, SCORERS, { z: 4 }).regressions).toHaveLength(0);
  });

  it('reports an improvement without failing the run', () => {
    const result = suite([caseResult({ caseId: 'c', value: 0.95, stdDev: 0.01, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 0.7, stdDev: 0.01, n: 5, scorers: {} } }),
      MODELS,
      SCORERS,
    );

    expect(comparison.comparisons[0]?.status).toBe('improved');
    expect(comparison.ok).toBe(true);
  });
});

describe('compareToBaseline', () => {
  it('treats a model change as a hard failure, not a warning', () => {
    const result = suite([caseResult({ caseId: 'c' })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 1, n: 1, scorers: {} } }),
      { embedding: { modelId: 'enc', revision: 'rev-2', dtype: 'fp32' } },
      SCORERS,
    );

    /* Scores are not comparable across revisions, so this is not a weaker
       comparison — it is a meaningless one. */
    expect(comparison.ok).toBe(false);
    expect(comparison.modelMismatches[0]).toContain('not comparable across model revisions');
  });

  it('reports a new case without calling it a regression', () => {
    const result = suite([caseResult({ caseId: 'fresh', value: 0.4 })]);

    const comparison = compareToBaseline(result, baseline({}), MODELS, SCORERS);

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
      SCORERS,
    );

    /* Deleting a failing case is the cheapest way to make a gate green. */
    expect(comparison.missingCases).toEqual(['deleted']);
    expect(comparison.ok).toBe(false);
  });

  it('fails on an errored case and never compares it', () => {
    const result = suite([caseResult({ caseId: 'c', status: 'errored', value: 0 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 1, n: 1, scorers: {} } }),
      MODELS,
      SCORERS,
    );

    expect(comparison.erroredCases).toEqual(['c']);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.ok).toBe(false);
  });

  it('fails when a scorer was ADDED, and does not call it a regression', () => {
    /* This is the exact event that produced a 0.953 -> 0.886 "regression" with
       nothing getting worse: registering semanticSimilarity and
       formatCompliance changed what each case mean averages. */
    const result = suite([caseResult({ caseId: 'c', value: 0.85, stdDev: 0.01, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 1, stdDev: 0.01, n: 5, scorers: {} } }),
      MODELS,
      ['exact-fields', 'semantic-similarity'],
    );

    expect(comparison.ok).toBe(false);
    expect(comparison.scorerSetMismatch[0]).toContain('added semantic-similarity');
    expect(comparison.scorerSetMismatch[0]).toContain('not comparable');
    /* The drop is real arithmetic, not a quality regression, and the gate must
       not report it as one. */
    expect(comparison.regressions).toEqual([]);
  });

  it('fails when a scorer was REMOVED', () => {
    const result = suite([caseResult({ caseId: 'c', value: 1, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 1, n: 5, scorers: {} } }, MODELS, ['exact-fields', 'llm-judge']),
      MODELS,
      ['exact-fields'],
    );

    expect(comparison.ok).toBe(false);
    expect(comparison.scorerSetMismatch[0]).toContain('removed llm-judge');
  });

  it('does not care about the order the scorers were registered in', () => {
    const result = suite([caseResult({ caseId: 'c', value: 1, samples: 5 })]);

    const comparison = compareToBaseline(
      result,
      baseline({ c: { mean: 1, n: 5, scorers: {} } }, MODELS, ['a', 'b']),
      MODELS,
      ['b', 'a'],
    );

    expect(comparison.scorerSetMismatch).toEqual([]);
    expect(comparison.ok).toBe(true);
  });

  it('treats every case as new when there is no baseline yet', () => {
    const comparison = compareToBaseline(
      suite([caseResult({ caseId: 'c' })]),
      undefined,
      MODELS,
      SCORERS,
    );

    expect(comparison.newCases).toHaveLength(1);
    expect(comparison.ok).toBe(true);
  });
});

/**
 * The per-scorer screen, and the regression that motivated it.
 *
 * ADR 022. A case mean averages its scorers, so a drop confined to one arrives
 * at the case screen already divided by the number that ran. The numbers below
 * are the real ones from 2026-08-24: `critical` was removed from the subject's
 * urgency enum, `exactFields` on outage-escalation-01 fell 1.00 → 0.75, and the
 * case mean moved 0.850 → 0.774 against a tolerance of 0.087. It passed.
 */
describe('the per-scorer screen', () => {
  const outageBaseline: Baseline = {
    version: 3,
    recordedAt: '2026-08-24T14:27:27.795Z',
    models: MODELS,
    scorers: ['exact-fields', 'format-compliance', 'semantic-similarity'],
    cases: {
      'outage-escalation-01': {
        mean: 0.850447,
        stdDev: 0.027443,
        n: 5,
        scorers: {
          'exact-fields': { mean: 1, stdDev: 0 },
          'semantic-similarity': { mean: 0.55134, stdDev: 0.008 },
          'format-compliance': { mean: 1, stdDev: 0 },
        },
      },
    },
    totals: { cases: 1, weightedScore: 0.850447 },
  };

  const withEnumDefect = suite([
    caseResult({
      caseId: 'outage-escalation-01',
      value: 0.7733,
      stdDev: 0.031,
      samples: 5,
      sampleValues: [0.77, 0.77, 0.78, 0.77, 0.77],
      scores: [
        { scorer: 'exact-fields', value: 0.75, passed: false },
        { scorer: 'semantic-similarity', value: 0.57, passed: false },
        { scorer: 'format-compliance', value: 1, passed: true },
      ],
      scorerStdDev: { 'exact-fields': 0, 'semantic-similarity': 0.01, 'format-compliance': 0 },
    }),
  ]);

  it('catches the single-field regression the case mean averaged away', () => {
    const comparison = compareToBaseline(withEnumDefect, outageBaseline, MODELS, outageBaseline.scorers);

    expect(comparison.ok).toBe(false);
    const [regressed] = comparison.regressions;
    expect(regressed?.caseId).toBe('outage-escalation-01');
    expect(regressed?.scorerRegressions?.map((s) => s.scorer)).toEqual(['exact-fields']);
  });

  it('flags it even though the case mean is inside its own tolerance', () => {
    const comparison = compareToBaseline(withEnumDefect, outageBaseline, MODELS, outageBaseline.scorers);
    const [regressed] = comparison.regressions;

    /* The whole point. 0.0771 against 0.087 — the case screen looked at this
       and said "unchanged", correctly by its own rule. One wrong field of four
       is 0.25 on one scorer and 0.25/3 = 0.083 on the mean, so on this case NO
       single-field regression is detectable at the case level at all. */
    expect(Math.abs(regressed?.delta ?? 0)).toBeLessThan(regressed?.tolerance ?? 0);
    expect(regressed?.scorerRegressions?.[0]?.delta).toBeCloseTo(-0.25, 3);
  });

  it('leaves a healthy run alone', () => {
    const healthy = suite([
      caseResult({
        caseId: 'outage-escalation-01',
        value: 0.86,
        stdDev: 0.028,
        samples: 5,
        scores: [
          { scorer: 'exact-fields', value: 1, passed: true },
          { scorer: 'semantic-similarity', value: 0.58, passed: true },
          { scorer: 'format-compliance', value: 1, passed: true },
        ],
        scorerStdDev: { 'exact-fields': 0, 'semantic-similarity': 0.012, 'format-compliance': 0 },
      }),
    ]);

    const comparison = compareToBaseline(healthy, outageBaseline, MODELS, outageBaseline.scorers);

    expect(comparison.ok).toBe(true);
    expect(comparison.regressions).toEqual([]);
  });

  it('does not let two scorers moving opposite ways cancel out', () => {
    /* The case mean is unchanged because one scorer rose as far as another
       fell. Reporting that as green is the same defect as the miss above,
       wearing a different disguise. */
    const cancelling = suite([
      caseResult({
        caseId: 'outage-escalation-01',
        value: 0.850447,
        stdDev: 0.03,
        samples: 5,
        scores: [
          { scorer: 'exact-fields', value: 0.75, passed: false },
          { scorer: 'semantic-similarity', value: 0.8, passed: true },
          { scorer: 'format-compliance', value: 1, passed: true },
        ],
        scorerStdDev: { 'exact-fields': 0, 'semantic-similarity': 0.01, 'format-compliance': 0 },
      }),
    ]);

    const comparison = compareToBaseline(cancelling, outageBaseline, MODELS, outageBaseline.scorers);

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions[0]?.delta).toBeCloseTo(0, 3);
    expect(comparison.regressions[0]?.scorerRegressions?.[0]?.scorer).toBe('exact-fields');
  });

  it('grants a noisy scorer more room than a deterministic one', () => {
    /* Same 0.12 drop on two scorers. `exact-fields` never moves, so it gets the
       floor and nothing else and is flagged. `semantic-similarity` has a
       measured spread, earns z·se on top, and is not. That asymmetry is the
       reason the spread is recorded rather than one flat allowance used. */
    const noisyBaseline: Baseline = {
      ...outageBaseline,
      cases: {
        'outage-escalation-01': {
          ...outageBaseline.cases['outage-escalation-01']!,
          scorers: {
            'exact-fields': { mean: 1, stdDev: 0 },
            'semantic-similarity': { mean: 0.7, stdDev: 0.15 },
            'format-compliance': { mean: 1, stdDev: 0 },
          },
        },
      },
    };

    const dropped = suite([
      caseResult({
        caseId: 'outage-escalation-01',
        value: 0.8,
        stdDev: 0.03,
        samples: 5,
        scores: [
          { scorer: 'exact-fields', value: 0.88, passed: false },
          { scorer: 'semantic-similarity', value: 0.58, passed: false },
          { scorer: 'format-compliance', value: 1, passed: true },
        ],
        scorerStdDev: { 'exact-fields': 0, 'semantic-similarity': 0.15, 'format-compliance': 0 },
      }),
    ]);

    const flagged = compareToBaseline(dropped, noisyBaseline, MODELS, noisyBaseline.scorers)
      .regressions[0]?.scorerRegressions?.map((s) => s.scorer);

    expect(flagged).toEqual(['exact-fields']);
  });

  it('declares its floor as a guess, like every other constant in the screen', () => {
    const comparison = compareToBaseline(withEnumDefect, outageBaseline, MODELS, outageBaseline.scorers);

    expect(comparison.uncalibrated.map((c) => c.id)).toContain('baseline.scorerFloor');
  });
});

describe('baselineFrom', () => {
  it('records only mean, stdDev, n and per-scorer mean and spread', () => {
    const result = suite([
      caseResult({
        caseId: 'c',
        value: 0.75,
        stdDev: 0.1,
        samples: 3,
        sampleValues: [0.6, 0.8, 0.85],
        scores: [{ scorer: 'exact-fields', value: 0.75, passed: false }],
        scorerStdDev: { 'exact-fields': 0.02 },
        output: { raw: { secret: 'customer email' }, model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 },
      }),
    ]);

    const recorded = baselineFrom(result, MODELS, ['b-scorer', 'a-scorer']);

    /* Sorted, so registration order cannot produce a spurious diff. */
    expect(recorded.scorers).toEqual(['a-scorer', 'b-scorer']);
    /* v3: each scorer carries its own spread as well as its own mean. The
       mean alone was recorded from v2 and never compared, which is how a
       single-scorer regression passed the gate (ADR 022). A spread is what
       lets it be screened rather than merely stored. */
    expect(recorded.cases['c']).toEqual({
      mean: 0.75,
      stdDev: 0.1,
      n: 3,
      scorers: { 'exact-fields': { mean: 0.75, stdDev: 0.02 } },
    });
    /* No raw output, no per-sample values, no transcripts (ADR 003). */
    expect(JSON.stringify(recorded)).not.toContain('customer email');
    expect(JSON.stringify(recorded)).not.toContain('0.85');
  });

  it('refuses to record a baseline when a case errored', () => {
    const result = suite([caseResult({ caseId: 'broken', status: 'errored' })]);

    expect(() => baselineFrom(result, MODELS, SCORERS)).toThrow(/Refusing to record a baseline/);
  });

  it('round-trips through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-evals-baseline-'));
    created.push(dir);
    const path = join(dir, 'baseline.json');
    const recorded = baselineFrom(suite([caseResult({ caseId: 'c', value: 0.5 })]), MODELS, SCORERS);

    await writeBaseline(recorded, path);

    await expect(readBaseline(path)).resolves.toEqual(recorded);
  });

  it('returns undefined for a baseline that does not exist yet', async () => {
    await expect(readBaseline(join(tmpdir(), 'nope-agent-evals.json'))).resolves.toBeUndefined();
  });
});

/**
 * The archives exist to anchor figures the README quotes, not to gate anything.
 * Their `_archived` key is the mechanism: `strictObject` rejects it, so a
 * mistyped `--baseline` path fails loudly instead of comparing a live run
 * against a snapshot from three subject versions ago.
 *
 * Asserting it means the protection cannot be removed by someone tidying the
 * key away — which would leave the files looking exactly like usable baselines.
 */
describe('archived baselines', () => {
  const archives = [
    { file: 'evals/baseline.freetext.json', anchors: '0.751, the free-text baseline' },
    { file: 'evals/baseline.enums-prescorer.json', anchors: '0.953, the post-enum baseline' },
  ];

  it('are rejected by the strict loader, so nothing can gate against them', async () => {
    expect(archives.length).toBeGreaterThan(0);

    for (const { file, anchors } of archives) {
      const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
      await expect(readBaseline(path), `${file} (${anchors})`).rejects.toThrow();
    }
  });

  it('each carries the _archived key that does the rejecting', async () => {
    for (const { file } of archives) {
      const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

      expect(raw['_archived'], `${file} has no _archived key`).toBeDefined();
      /* The header has to SAY it is not a gate, because the file is otherwise
         indistinguishable from one. Stringified rather than read field-by-field
         because the two archives were written at different times and one is a
         sentence where the other is a structured note — the requirement is that
         the warning is present, not that it has a particular shape. */
      expect(JSON.stringify(raw['_archived'])).toMatch(/not a gate|archive|nothing (compares|can accidentally)/i);
    }
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
