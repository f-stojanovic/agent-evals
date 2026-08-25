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
import type { CaseResult, SuiteResult, UncalibratedConstant } from './types.js';

export const BASELINE_PATH = 'evals/baseline.json';
/**
 * Bumped when the recorded SHAPE changes, not when the numbers do.
 *
 * v2 added the scorer set. A v1 file cannot be compared against a v2 run —
 * not because the means are wrong, but because the run cannot tell whether
 * they were produced by the same scorers, which is the whole point of
 * recording them.
 *
 * v3 gave each scorer a spread alongside its mean. A v2 file records the
 * per-scorer means but nothing about how far they move on their own, so a v2
 * file can be screened at the case level and NOT at the scorer level — which
 * is precisely the screen that exists to catch what the case level missed.
 * Rather than run the new gate at half strength against old files and report
 * a pass that covered less than it appeared to, a v2 file is refused. See
 * ADR 022.
 */
export const BASELINE_VERSION = 3;

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
/** An existing baseline predates a change to what a baseline records. */
export class BaselineVersionError extends Error {
  override readonly name = 'BaselineVersionError';
}

/**
 * One scorer's contribution to a case, as the baseline records it.
 *
 * v3 replaced a bare number with this. The number was always recorded and
 * never compared, which is how a regression confined to one scorer passed the
 * gate: `exact-fields` fell 1.00 → 0.75 on a case whose mean moved 0.077
 * against a tolerance of 0.087. The mean is a summary, and a screen on a
 * summary cannot see a change inside it. See ADR 022.
 */
export type BaselineScorer = {
  mean: number;
  /** Absent when n === 1, and for the same reason as {@link BaselineCase}. */
  stdDev?: number;
};

export type BaselineCase = {
  mean: number;
  /** Absent when n === 1: spread is not meaningful for a single draw, and 0
   *  would claim stability the run never demonstrated. */
  stdDev?: number;
  n: number;
  scorers: Record<string, BaselineScorer>;
};

export type Baseline = {
  version: number;
  recordedAt: string;
  /** Which models produced these numbers. A mismatch is a hard failure — see
   *  {@link compareToBaseline}. */
  models: Record<string, LockedModel>;
  /**
   * The scorer names that produced these means, sorted.
   *
   * Recorded for the same reason the models are: a case mean is an average
   * over the scorers that ran, so adding or removing one changes what the
   * number is an average OF. Comparing across that change is not a weaker
   * comparison, it is a meaningless one — and it does not look meaningless,
   * it looks like a regression. See {@link compareToBaseline}.
   */
  scorers: string[];
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
  scorers: z.array(z.string()),
  cases: z.record(
    z.string(),
    z.strictObject({
      mean: z.number(),
      stdDev: z.number().optional(),
      n: z.number().int().positive(),
      scorers: z.record(
        z.string(),
        z.strictObject({ mean: z.number(), stdDev: z.number().optional() }),
      ),
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
export function baselineFrom(
  result: SuiteResult,
  models: Record<string, LockedModel>,
  scorers: readonly string[],
): Baseline {
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
        caseResult.scores.map((score) => [
          score.scorer,
          {
            mean: round(score.value),
            ...(caseResult.scorerStdDev?.[score.scorer] !== undefined && {
              stdDev: round(caseResult.scorerStdDev[score.scorer] as number),
            }),
          },
        ]),
      ),
    };
  }

  return {
    version: BASELINE_VERSION,
    recordedAt: result.startedAt,
    models,
    scorers: [...scorers].sort(),
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

  const raw: unknown = JSON.parse(contents);

  /* Version first, so an older file produces a sentence a human can act on
     rather than a schema dump about a field they have never heard of. */
  const version = (raw as { version?: unknown }).version;
  if (typeof version === 'number' && version !== BASELINE_VERSION) {
    throw new BaselineVersionError(
      `${path} was recorded in baseline format v${version}; this build writes ` +
        `v${BASELINE_VERSION}. The formats differ in what they record alongside ` +
        `the means — v2 added the scorer set, v3 added a spread for each scorer — ` +
        `so a v${version} file cannot support the checks this run performs: whether ` +
        `its numbers came from the same scorers, and whether any single scorer ` +
        `regressed. ` +
        `Re-record it: npm run eval -- --update-baseline`,
    );
  }

  const parsed = baselineSchema.safeParse(raw);
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
          /* Rebuilt key-by-key so an absent stdDev stays absent rather than
             becoming present-and-undefined, which `exactOptionalPropertyTypes`
             treats as a different type — the same conversion the case and
             fixture loaders perform. */
          scorers: Object.fromEntries(
            Object.entries(entry.scorers).map(([name, scorer]) => [
              name,
              {
                mean: scorer.mean,
                ...(scorer.stdDev !== undefined && { stdDev: scorer.stdDev }),
              },
            ]),
          ),
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
  status: 'regressed' | 'improved' | 'unchanged' | 'new' | 'errored' | 'incomparable';
  currentMean: number;
  baselineMean?: number;
  delta?: number;
  /** The derived allowance for this case on this run. */
  tolerance?: number;
  /**
   * Scorers that regressed on their own, whatever the case mean did.
   *
   * Empty on a healthy case, and empty is the normal state — this is populated
   * only when a scorer moved further than its own allowance. A case can appear
   * here with `status: 'unchanged'`: that combination is the entire reason the
   * field exists, and it is what a single-field regression looks like once the
   * mean has averaged it away with two scorers that did not move.
   */
  scorerRegressions?: ScorerRegression[];
};

export type ScorerRegression = {
  scorer: string;
  baselineMean: number;
  currentMean: number;
  delta: number;
  tolerance: number;
};

export type BaselineComparison = {
  ok: boolean;
  /** The screen's own guesses, for the report footer (ADR 010). */
  uncalibrated: readonly UncalibratedConstant[];
  comparisons: CaseComparison[];
  regressions: CaseComparison[];
  newCases: CaseComparison[];
  /** Cases the baseline records that the suite no longer contains. */
  missingCases: string[];
  erroredCases: string[];
  modelMismatches: string[];
  /** Populated when the registered scorer set differs from the recorded one.
   *  Kept separate from `modelMismatches` so the report can say which of the
   *  two incomparabilities occurred. */
  scorerSetMismatch: string[];
};

export type CompareOptions = {
  /** How many standard errors below the baseline mean counts as a regression.
   *  2 is roughly a 95% one-sided screen under a normal approximation. */
  readonly z?: number;
  /** Absolute allowance added to the derived one, so a case whose samples all
   *  landed on exactly the same value does not fail on floating-point dust. */
  readonly floor?: number;
  /** The same, for the per-scorer screen. See {@link DEFAULT_SCORER_FLOOR}. */
  readonly scorerFloor?: number;
};

/** How many standard errors of extra allowance a noisy case earns. */
export const DEFAULT_Z = 2;
/**
 * The primary allowance, in absolute score.
 *
 * PRIMARY, not a fallback. At the sample counts this suite actually runs, a
 * stdDev computed from five draws is a weak estimate of spread, and the
 * statistical term built on it is a weak signal. The floor is the number doing
 * most of the deciding; `z·se` widens it for cases that have demonstrably
 * earned a wider allowance.
 */
export const DEFAULT_FLOOR = 0.05;

/**
 * The same allowance, for a single scorer rather than a case mean.
 *
 * IT IS A GUESS AND IT IS DECLARED AS ONE. Nothing measured says 0.10 is the
 * right number. What can be said is why it is not 0.05 and not 0.15.
 *
 * A case mean divides each scorer's contribution by the number of scorers that
 * ran — three on the case this screen was built for. So the case-level floor
 * of 0.05 demands a per-scorer drop of about 0.15 before it will look at
 * anything, and a screen that only fires above 0.15 per scorer would add
 * nothing the case screen does not already have. The new screen has to be
 * meaningfully tighter than that or it is decoration.
 *
 * The other end is quantisation. `exactFields` on a four-field case moves in
 * steps of 0.25 per sample, so at n=5 its mean moves in steps of 0.05. A floor
 * at 0.05 would fire on one field wrong in one sample out of five, which at
 * these sample counts is as likely to be the model being stochastic as
 * anything having regressed — the cheap direction to be wrong in is the other
 * one.
 *
 * 0.10 sits between them: half the case screen's effective per-scorer
 * sensitivity, twice the smallest move a deterministic scorer can make. Both
 * bounds are arguments about arithmetic rather than measurements of anything,
 * which is why this is reported in the uncalibrated list with the other
 * guesses. `z·se` still widens it for a scorer that has earned the room.
 */
export const DEFAULT_SCORER_FLOOR = 0.1;

/** Declared so the report can count them. They are guesses (ADR 010): 2 and
 *  0.05 are conventions, not measurements. */
export function screenConstants(options: CompareOptions = {}): UncalibratedConstant[] {
  return [
    ...(options.floor === undefined
      ? [
          {
            id: 'baseline.floor',
            value: DEFAULT_FLOOR,
            note:
              'absolute score drop tolerated before a case is flagged. The primary ' +
              'allowance in the screen, and a convention — nothing measured says a ' +
              '0.05 drop is acceptable and 0.06 is not.',
          },
        ]
      : []),
    ...(options.scorerFloor === undefined
      ? [
          {
            id: 'baseline.scorerFloor',
            value: DEFAULT_SCORER_FLOOR,
            note:
              'absolute drop tolerated in a SINGLE scorer before it is flagged, ' +
              'independently of the case mean. Bounded by argument rather than ' +
              'measurement: below ~0.15 or it adds nothing the case screen has, ' +
              'above 0.05 or it fires on one field in one sample of five.',
          },
        ]
      : []),
    ...(options.z === undefined
      ? [
          {
            id: 'baseline.z',
            value: DEFAULT_Z,
            note:
              'standard errors of extra allowance granted to a noisy case. Borrowed ' +
              'from a normal approximation that the underlying data does not satisfy ' +
              'at n=5; treat it as a widening factor, not a confidence level.',
          },
        ]
      : []),
  ];
}

/**
 * Compares a run against the baseline.
 *
 * A SCREEN, NOT A TEST. The word is chosen and used consistently: nothing here
 * is a hypothesis test, produces a p-value, or supports a claim of
 * significance. It is a filter that decides which drops are worth a human's
 * attention, and it is tuned to be wrong in the cheap direction.
 *
 * WHY THE ALLOWANCE IS DERIVED RATHER THAN PICKED
 * ----------------------------------------------
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
 * and a case is flagged when
 *
 *     current.mean < baseline.mean − floor − z·se
 *
 * The floor is the primary term and the statistical one is secondary. A case
 * that scores 0.6 ± 0.35 earns extra room on top of the floor; a case that
 * scores 0.95 ± 0.01 gets the floor and almost nothing more.
 *
 * WHAT THIS IS NOT
 * ----------------
 * At n=5, `stdDev` is estimated from five numbers. That is enough to tell a
 * case that swings wildly from one that does not, and nowhere near enough to
 * support a distributional claim. So `z·se` is treated as a secondary signal
 * — a widening factor for demonstrably noisy cases — and never as a
 * confidence interval.
 *
 * Specifically: it assumes per-case scores are roughly normal, which for a
 * bounded 0..1 score that piles up at the ends is false. It uses a normal
 * quantile where a t would be the textbook choice. It applies no correction
 * for screening every case in the suite at once, so across a hundred cases a
 * few will trip on noise alone. And with a single sample there is no spread at
 * all, so only the floor is left.
 *
 * It is a screen that scales its allowance to measured variance instead of
 * guessing one number for the whole suite. That is a real improvement over a
 * constant and it is not rigour. Saying so here is cheaper than having
 * somebody infer rigour from the square root.
 */
export function compareToBaseline(
  result: SuiteResult,
  baseline: Baseline | undefined,
  models: Record<string, LockedModel>,
  scorers: readonly string[],
  options: CompareOptions = {},
): BaselineComparison {
  const z = options.z ?? DEFAULT_Z;
  const floor = options.floor ?? DEFAULT_FLOOR;
  const scorerFloor = options.scorerFloor ?? DEFAULT_SCORER_FLOOR;

  const erroredCases = result.results.filter((r) => r.status === 'errored').map((r) => r.caseId);

  if (baseline === undefined) {
    const comparisons = result.results.map(toNewOrErrored);
    return {
      ok: erroredCases.length === 0,
      uncalibrated: screenConstants(options),
      comparisons,
      regressions: [],
      newCases: comparisons.filter((c) => c.status === 'new'),
      missingCases: [],
      erroredCases,
      modelMismatches: [],
      scorerSetMismatch: [],
    };
  }

  /* Model identity first. A different encoder or judge shifts every score in
     the suite at once, in exactly the shape of the subject regressing, so
     comparing across one is not a weaker comparison — it is a meaningless
     one (ADR 009). Hard failure, never a warning. */
  const modelMismatches = compareModels(baseline.models, models);

  /* Exactly the model mechanic, applied one axis over. A case mean averages
     the scorers that ran; change the set and every mean shifts at once, in the
     shape of a regression. Registering `semanticSimilarity` and
     `formatCompliance` once moved this suite 0.953 -> 0.886 with nothing
     getting worse, and it took a human to notice the drop was arithmetic. */
  const scorerSetMismatch = compareScorerSets(baseline.scorers, scorers);

  /* If either identity changed, the per-case deltas are arithmetic noise, so
     none are computed. Reporting "regressed" beside "these numbers are not
     comparable" would be inviting somebody to read the deltas anyway — and a
     fake regression is worse than no number, because it looks actionable. */
  if (modelMismatches.length > 0 || scorerSetMismatch.length > 0) {
    return {
      ok: false,
      uncalibrated: screenConstants(options),
      comparisons: result.results.map((caseResult) => ({
        caseId: caseResult.caseId,
        status: caseResult.status === 'errored' ? ('errored' as const) : ('incomparable' as const),
        currentMean: caseResult.value,
      })),
      regressions: [],
      newCases: [],
      missingCases: [],
      erroredCases,
      modelMismatches,
      scorerSetMismatch,
    };
  }

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

    /* Floor first: it is the term doing most of the deciding. */
    const tolerance = floor + z * standardError(recorded, caseResult);
    const delta = caseResult.value - recorded.mean;
    const meanStatus =
      delta < -tolerance ? 'regressed' : delta > tolerance ? 'improved' : 'unchanged';

    /* The second screen, on the parts rather than the summary. A case mean
       averages its scorers, so a drop confined to one of them arrives here
       already divided by the number that ran. See ADR 022. */
    const scorerRegressions = screenScorers(recorded, caseResult, scorerFloor, z);

    /* A scorer regression is a regression, even where the mean is unchanged or
       improved — the improvement can be another scorer moving the other way,
       and reporting the case as green because two numbers cancelled is the
       failure this screen was added for. */
    const status = scorerRegressions.length > 0 ? 'regressed' : meanStatus;

    const comparison: CaseComparison = {
      caseId: caseResult.caseId,
      status,
      currentMean: caseResult.value,
      baselineMean: recorded.mean,
      delta,
      tolerance,
      ...(scorerRegressions.length > 0 && { scorerRegressions }),
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
    uncalibrated: screenConstants(options),
    ok:
      regressions.length === 0 &&
      missingCases.length === 0 &&
      erroredCases.length === 0 &&
      modelMismatches.length === 0 &&
      scorerSetMismatch.length === 0,
    comparisons,
    regressions,
    newCases,
    missingCases,
    erroredCases,
    modelMismatches,
    scorerSetMismatch,
  };
}

/**
 * Compares the registered scorer names against the recorded ones.
 *
 * A hard failure with its own message, never a regression and never a silent
 * pass. The wording says what the reader has to do, because the honest
 * response to "these numbers are not comparable" is to re-record, not to
 * squint at a delta.
 */
function compareScorerSets(recorded: readonly string[], current: readonly string[]): string[] {
  const before = [...recorded].sort();
  const after = [...current].sort();
  if (before.join('\u0000') === after.join('\u0000')) return [];

  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));

  const changes = [
    ...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
  ];

  return [
    `the scorer set changed (${changes.join('; ')}), so these means are not ` +
      `comparable — a case mean averages the scorers that ran, and changing the set ` +
      `moves every case at once without anything getting worse. Re-record the ` +
      `baseline in the same commit as the scorer change.`,
  ];
}

/**
 * The per-scorer screen.
 *
 * Same shape as the case screen — `floor + z·se`, a drop below it is a
 * regression — applied to each scorer's own mean and its own spread.
 *
 * A scorer the baseline does not record is skipped rather than treated as new
 * or missing: the scorer SET is compared separately and a difference there
 * already makes every number incomparable, so reaching this code with an
 * unrecognised scorer means the sets matched and this case simply did not run
 * it. Flagging that would report a regression on a case where nothing changed.
 */
function screenScorers(
  recorded: BaselineCase,
  current: CaseResult,
  floor: number,
  z: number,
): ScorerRegression[] {
  const regressions: ScorerRegression[] = [];

  for (const score of current.scores) {
    const before = recorded.scorers[score.scorer];
    if (before === undefined) continue;

    const baselineVariance = (before.stdDev ?? 0) ** 2 / Math.max(1, recorded.n);
    const currentVariance =
      (current.scorerStdDev?.[score.scorer] ?? 0) ** 2 / Math.max(1, current.samples);
    const tolerance = floor + z * Math.sqrt(baselineVariance + currentVariance);
    const delta = score.value - before.mean;

    if (delta < -tolerance) {
      regressions.push({
        scorer: score.scorer,
        baselineMean: before.mean,
        currentMean: score.value,
        delta,
        tolerance,
      });
    }
  }

  return regressions.sort((a, b) => a.delta - b.delta);
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
