/**
 * The baseline file and the gate that reads it.
 *
 * The baseline is a committed record of what the suite scored, compared
 * against on every run, where a regression fails the build and an improvement
 * requires committing the new numbers. The mechanic is a static analysis
 * baseline applied to eval scores (ADR 002); this file is that mechanic.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { LockedModel } from './models-lock.js';
import type { CaseResult, SuiteResult } from './types.js';

export const BASELINE_PATH = 'evals/baseline.json';
export const BASELINE_VERSION = 1;

/**
 * What a baseline records, and nothing else.
 *
 * No raw provider responses, no per-sample values, no model output, no judge
 * transcripts (ADR 003). Three reasons, each ruling out something different:
 * a diff a human scrolls past is a rubber stamp rather than a control; real
 * eval inputs are customer emails and provider responses quote them back, so
 * committing output copies personal data into git history; and full
 * transcripts across a few hundred cases make the file grow faster than
 * anybody notices it stopped being readable.
 */
export type BaselineCase = {
  mean: number;
  /** Absent when n === 1: spread is not meaningful for a single draw, and 0
   *  would claim stability the run never demonstrated. */
  stdDev?: number;
  n: number;
  scorers: Record<string, number>;
};

export type Baseline = {
  version: number;
  recordedAt: string;
  /** Which models produced these numbers. A mismatch is a hard failure — see
   *  {@link compareToBaseline}. */
  models: Record<string, LockedModel>;
  cases: Record<string, BaselineCase>;
  totals: { cases: number; weightedScore: number };
};

const lockedModelSchema = z.strictObject({
  modelId: z.string(),
  revision: z.string().nullable(),
  dtype: z.string(),
});

const baselineSchema = z.strictObject({
  version: z.number().int(),
  recordedAt: z.string(),
  models: z.record(z.string(), lockedModelSchema),
  cases: z.record(
    z.string(),
    z.strictObject({
      mean: z.number(),
      stdDev: z.number().optional(),
      n: z.number().int().positive(),
      scorers: z.record(z.string(), z.number()),
    }),
  ),
  totals: z.strictObject({ cases: z.number().int(), weightedScore: z.number() }),
});

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

/**
 * Builds a baseline from a run.
 *
 * @throws when any case errored. A baseline missing the cases that failed to
 * evaluate would silently shrink the suite, and the next run would compare
 * against a file that quietly stopped covering them.
 */
export function baselineFrom(result: SuiteResult, models: Record<string, LockedModel>): Baseline {
  const errored = result.results.filter((r) => r.status === 'errored');
  if (errored.length > 0) {
    throw new Error(
      `Refusing to record a baseline: ${errored.length} case(s) errored ` +
        `(${errored.map((r) => r.caseId).join(', ')}). Fix them or remove them — a ` +
        `baseline that omits the cases which failed to evaluate silently shrinks ` +
        `what the suite covers.`,
    );
  }

  const cases: Record<string, BaselineCase> = {};
  for (const caseResult of result.results) {
    cases[caseResult.caseId] = {
      mean: round(caseResult.value),
      ...(caseResult.stdDev !== undefined && { stdDev: round(caseResult.stdDev) }),
      n: caseResult.samples,
      scorers: Object.fromEntries(
        caseResult.scores.map((score) => [score.scorer, round(score.value)]),
      ),
    };
  }

  return {
    version: BASELINE_VERSION,
    recordedAt: result.startedAt,
    models,
    cases,
    totals: { cases: result.results.length, weightedScore: round(result.totals.weightedScore) },
  };
}

/** Six decimals: enough that a real change shows, few enough that floating
 *  point noise does not produce a diff on every run. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export async function writeBaseline(baseline: Baseline, path = BASELINE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export async function readBaseline(path = BASELINE_PATH): Promise<Baseline | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const parsed = baselineSchema.safeParse(JSON.parse(contents) as unknown);
  if (!parsed.success) {
    throw new Error(
      `${path} is not a valid baseline: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }
  /* Rebuilt so an absent stdDev stays absent rather than becoming
     present-and-undefined, which exactOptionalPropertyTypes treats as a
     different type. Same conversion the case loader performs. */
  return {
    ...parsed.data,
    cases: Object.fromEntries(
      Object.entries(parsed.data.cases).map(([id, entry]) => [
        id,
        {
          mean: entry.mean,
          n: entry.n,
          scorers: entry.scorers,
          ...(entry.stdDev !== undefined && { stdDev: entry.stdDev }),
        },
      ]),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * The comparison
 * ------------------------------------------------------------------ */

export type CaseComparison = {
  caseId: string;
  status: 'regressed' | 'improved' | 'unchanged' | 'new' | 'errored';
  currentMean: number;
  baselineMean?: number;
  delta?: number;
  /** The derived allowance for this case on this run. */
  tolerance?: number;
};

export type BaselineComparison = {
  ok: boolean;
  comparisons: CaseComparison[];
  regressions: CaseComparison[];
  newCases: CaseComparison[];
  /** Cases the baseline records that the suite no longer contains. */
  missingCases: string[];
  erroredCases: string[];
  modelMismatches: string[];
};

export type CompareOptions = {
  /** How many standard errors below the baseline mean counts as a regression.
   *  2 is roughly a 95% one-sided screen under a normal approximation. */
  readonly z?: number;
  /** Absolute allowance added to the derived one, so a case whose samples all
   *  landed on exactly the same value does not fail on floating-point dust. */
  readonly floor?: number;
};

export const DEFAULT_Z = 2;
export const DEFAULT_FLOOR = 0.01;

/**
 * Compares a run against the baseline.
 *
 * WHY THE TOLERANCE IS DERIVED RATHER THAN PICKED
 * -----------------------------------------------
 * The obvious gate is "fail if a case drops more than 0.05". That number is a
 * guess about how much a case moves on its own, applied uniformly to cases
 * whose real variance differs by an order of magnitude. Set it loose enough
 * for the noisiest case in the suite and it stops catching regressions on the
 * stable ones; set it tight and the noisy cases flap until somebody turns the
 * gate off. Either way the threshold is doing the work that measurement should.
 *
 * Both sides of this comparison are estimates of a mean, each with its own
 * spread and sample count, so the honest question is not "did it drop more
 * than X" but "is this drop larger than the noise I already measured". The
 * standard error of the difference of two means answers exactly that:
 *
 *     se = sqrt(baseline.stdDev² / baseline.n + current.stdDev² / current.n)
 *
 * and a case regresses when
 *
 *     current.mean < baseline.mean − z·se − floor
 *
 * A case that scores 0.6 ± 0.35 gets a wide allowance because it has earned
 * one; a case that scores 0.95 ± 0.01 gets almost none, and a drop to 0.90
 * fails it — which is the right answer and the one a fixed 0.05 threshold
 * would have missed.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a hypothesis test and it should not be described as one. It
 * assumes per-case scores are roughly normal, which for a bounded 0..1 score
 * that often piles up at the ends is not true. It uses a normal quantile at
 * sample sizes of three or five where a t-distribution would be the textbook
 * choice. It applies no correction for testing every case in the suite at
 * once, so across a hundred cases a few will trip on noise alone. And when a
 * case has never been sampled more than once, `stdDev` is absent, `se`
 * collapses to zero, and the whole thing degenerates to the fixed floor.
 *
 * It is a pragmatic screen that scales its allowance to measured variance
 * instead of guessing one number for the whole suite. That is a real
 * improvement over a constant and it is not rigour. Saying so here is cheaper
 * than having someone discover it from the code and conclude the numbers meant
 * more than they did.
 */
export function compareToBaseline(
  result: SuiteResult,
  baseline: Baseline | undefined,
  models: Record<string, LockedModel>,
  options: CompareOptions = {},
): BaselineComparison {
  const z = options.z ?? DEFAULT_Z;
  const floor = options.floor ?? DEFAULT_FLOOR;

  const erroredCases = result.results.filter((r) => r.status === 'errored').map((r) => r.caseId);

  if (baseline === undefined) {
    const comparisons = result.results.map(toNewOrErrored);
    return {
      ok: erroredCases.length === 0,
      comparisons,
      regressions: [],
      newCases: comparisons.filter((c) => c.status === 'new'),
      missingCases: [],
      erroredCases,
      modelMismatches: [],
    };
  }

  /* Model identity first. A different encoder or judge shifts every score in
     the suite at once, in exactly the shape of the subject regressing, so
     comparing across one is not a weaker comparison — it is a meaningless
     one (ADR 009). Hard failure, never a warning. */
  const modelMismatches = compareModels(baseline.models, models);

  const comparisons: CaseComparison[] = [];
  const regressions: CaseComparison[] = [];
  const newCases: CaseComparison[] = [];

  for (const caseResult of result.results) {
    if (caseResult.status === 'errored') {
      comparisons.push(toNewOrErrored(caseResult));
      continue;
    }

    const recorded = baseline.cases[caseResult.caseId];
    if (recorded === undefined) {
      /* Not a regression — a case with no history cannot have regressed. It
         still has to be recorded deliberately, so the gate reports it and the
         baseline update is an explicit commit. */
      const comparison: CaseComparison = {
        caseId: caseResult.caseId,
        status: 'new',
        currentMean: caseResult.value,
      };
      comparisons.push(comparison);
      newCases.push(comparison);
      continue;
    }

    const tolerance = z * standardError(recorded, caseResult) + floor;
    const delta = caseResult.value - recorded.mean;
    const status =
      delta < -tolerance ? 'regressed' : delta > tolerance ? 'improved' : 'unchanged';

    const comparison: CaseComparison = {
      caseId: caseResult.caseId,
      status,
      currentMean: caseResult.value,
      baselineMean: recorded.mean,
      delta,
      tolerance,
    };
    comparisons.push(comparison);
    if (status === 'regressed') regressions.push(comparison);
  }

  /* A case in the baseline that the suite no longer contains means somebody
     deleted a test. That must not pass silently: deleting a failing case is
     the cheapest possible way to make a gate green. */
  const present = new Set(result.results.map((r) => r.caseId));
  const missingCases = Object.keys(baseline.cases)
    .filter((id) => !present.has(id))
    .sort();

  return {
    ok:
      regressions.length === 0 &&
      missingCases.length === 0 &&
      erroredCases.length === 0 &&
      modelMismatches.length === 0,
    comparisons,
    regressions,
    newCases,
    missingCases,
    erroredCases,
    modelMismatches,
  };
}

/** Standard error of the difference of two means. */
export function standardError(recorded: BaselineCase, current: CaseResult): number {
  const baselineVariance = (recorded.stdDev ?? 0) ** 2 / Math.max(1, recorded.n);
  const currentVariance = (current.stdDev ?? 0) ** 2 / Math.max(1, current.samples);
  return Math.sqrt(baselineVariance + currentVariance);
}

function compareModels(
  recorded: Record<string, LockedModel>,
  current: Record<string, LockedModel>,
): string[] {
  const mismatches: string[] = [];
  for (const [slot, entry] of Object.entries(recorded)) {
    const now = current[slot];
    if (now === undefined) {
      mismatches.push(`baseline was recorded with a ${slot} model (${entry.modelId}); this run used none`);
      continue;
    }
    if (now.modelId !== entry.modelId || now.revision !== entry.revision || now.dtype !== entry.dtype) {
      mismatches.push(
        `${slot} model changed: baseline ${describe(entry)}, run ${describe(now)}. ` +
          `Scores are not comparable across model revisions — re-record the baseline ` +
          `in the same commit as the model change.`,
      );
    }
  }
  return mismatches;
}

function describe(model: LockedModel): string {
  return `${model.modelId}@${model.revision ?? 'unpinned'} (${model.dtype})`;
}

function toNewOrErrored(caseResult: CaseResult): CaseComparison {
  return {
    caseId: caseResult.caseId,
    status: caseResult.status === 'errored' ? 'errored' : 'new',
    currentMean: caseResult.value,
  };
}

/** Summarises a baseline rewrite so the commit message writes itself. */
export function describeBaselineChange(
  previous: Baseline | undefined,
  next: Baseline,
): string {
  if (previous === undefined) {
    return `Recorded a new baseline: ${Object.keys(next.cases).length} cases, weighted score ${next.totals.weightedScore.toFixed(3)}.`;
  }

  const lines: string[] = [];
  for (const [id, entry] of Object.entries(next.cases)) {
    const before = previous.cases[id];
    if (before === undefined) {
      lines.push(`  + ${id}: ${entry.mean.toFixed(3)} (new)`);
      continue;
    }
    const delta = entry.mean - before.mean;
    if (Math.abs(delta) < 1e-9) continue;
    lines.push(
      `  ${delta > 0 ? '↑' : '↓'} ${id}: ${before.mean.toFixed(3)} → ${entry.mean.toFixed(3)} (${delta > 0 ? '+' : ''}${delta.toFixed(3)})`,
    );
  }
  for (const id of Object.keys(previous.cases)) {
    if (next.cases[id] === undefined) lines.push(`  - ${id}: removed`);
  }

  const weighted = next.totals.weightedScore - previous.totals.weightedScore;
  return [
    `Updated baseline: weighted score ${previous.totals.weightedScore.toFixed(3)} → ` +
      `${next.totals.weightedScore.toFixed(3)} (${weighted >= 0 ? '+' : ''}${weighted.toFixed(3)}).`,
    ...(lines.length > 0 ? ['', ...lines] : ['', '  no per-case changes']),
  ].join('\n');
}
