/**
 * Running a suite: sampling, concurrency, retries, timeouts, caching, cost.
 *
 * Everything here is mechanism. The judgement lives in the scorers and in the
 * baseline comparison; this file's job is to produce honest inputs for both,
 * and to keep "the model was wrong" strictly separate from "we could not find
 * out".
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractStructured } from './scorers/extract.js';
import { applicableScorers } from './scorers/registry.js';
import { invokeScorer } from './scorers/invoke.js';
import { addCost, costOf, ZERO_COST } from './pricing.js';
import { collectUncalibrated } from './uncalibrated.js';
import type {
  CaseResult,
  CostBreakdown,
  EvalCase,
  Extraction,
  ExtractionRoute,
  LatencyAggregate,
  Score,
  Scorer,
  Subject,
  SubjectOutput,
  SuiteResult,
  SuiteTotals,
  UncalibratedConstant,
  Usage,
} from './types.js';
import { DEFAULT_CASE_WEIGHT } from './types.js';

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * Where a cached response may be read from, if anywhere.
 *
 * There is no default. Callers must say, because the failure mode of a cache
 * that is quietly on is a baseline recorded from replayed responses — a file
 * that describes the cache's contents rather than the model's behaviour, and
 * that stays green through a model upgrade, a prompt change, and a provider
 * incident alike (ADR 007). A default-on cache would make that mistake the
 * path of least resistance; making the field required makes it a decision
 * somebody typed.
 */
export type CacheMode = { readonly kind: 'off' } | { readonly kind: 'disk'; readonly dir: string };

export const CACHE_OFF: CacheMode = { kind: 'off' };
export const DEFAULT_CACHE_DIR = '.cache/subject';

export type RunOptions = {
  readonly cases: readonly EvalCase[];
  readonly subject: Subject;
  /** Identifies the subject in the cache key. Change it when the subject
   *  changes in a way the input does not capture — a prompt edit, say. */
  readonly subjectId: string;
  readonly scorers: readonly Scorer[];
  /** Draws per case. Each is a fresh call to the subject. */
  readonly samples?: number;
  /** Cases in flight at once. */
  readonly concurrency?: number;
  /** Required. See {@link CacheMode}. */
  readonly cache: CacheMode;
  /** Per-case wall clock budget, covering all samples of that case. */
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly suiteId?: string;
  /** Injected in tests so backoff does not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so jitter is deterministic. */
  readonly random?: () => number;
};

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_SAMPLES = 1;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export type RunSummary = SuiteResult & {
  /** Collected from the registered scorers, for the report footer. */
  uncalibrated: readonly UncalibratedConstant[];
  /** Suite-wide distribution of extraction routes.
   *
   *  A METRIC, NOT AN ASSERTION. `formatCompliance` grades one case against
   *  what that case declared; this describes the run and grades nothing. They
   *  were conflated once — a suite-wide format check dressed up as a scorer —
   *  and separating them turned one contested design question into two cheap
   *  ones. Nothing here affects any score or the gate. */
  viaDistribution: Readonly<Record<string, number>>;
  /** Split out because grading is usually the expensive half and a cost that
   *  is not itemised does not get optimised. */
  subjectCost?: CostBreakdown;
  judgeCost?: CostBreakdown;
};

/* ------------------------------------------------------------------ *
 * runSuite
 * ------------------------------------------------------------------ */

export async function runSuite(options: RunOptions): Promise<RunSummary> {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  assertSampleFloor(options.cases, options.scorers, samples);

  const startedAt = new Date();
  const started = Date.now();

  const results = await mapWithConcurrency(options.cases, concurrency, (evalCase) =>
    runCase({
      evalCase,
      subject: options.subject,
      subjectId: options.subjectId,
      scorers: options.scorers,
      samples,
      maxAttempts,
      timeoutMs,
      cache: options.cache,
      sleep,
      random,
      ...(options.signal !== undefined && { signal: options.signal }),
    }),
  );

  return summarise({
    results,
    scorers: options.scorers,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    suiteId: options.suiteId ?? 'default',
  });
}

/**
 * Refuses to start a suite whose sample count is below what a registered
 * scorer needs. Checked up front rather than per case, so the run fails in
 * milliseconds instead of after paying for half a suite.
 */
function assertSampleFloor(
  cases: readonly EvalCase[],
  scorers: readonly Scorer[],
  samples: number,
): void {
  const problems: string[] = [];

  for (const evalCase of cases) {
    for (const scorer of applicableScorers(evalCase, scorers)) {
      const floor = scorer.minSamples;
      if (floor !== undefined && samples < floor) {
        problems.push(
          `case "${evalCase.id}" is scored by "${scorer.name}", which requires at ` +
            `least ${floor} samples per case; this run requested ${samples}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Sample count too low for the registered scorers:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nA probabilistic scorer sampled once produces an anecdote, not an ` +
        `estimate, and there is no temperature control left to suppress the ` +
        `variance with. Raise --samples.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * One case
 * ------------------------------------------------------------------ */

type CaseArgs = {
  evalCase: EvalCase;
  subject: Subject;
  subjectId: string;
  scorers: readonly Scorer[];
  samples: number;
  maxAttempts: number;
  timeoutMs: number;
  cache: CacheMode;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  signal?: AbortSignal;
};

async function runCase(args: CaseArgs): Promise<CaseResult> {
  const { evalCase } = args;
  const weight = evalCase.weight ?? DEFAULT_CASE_WEIGHT;
  const started = Date.now();

  const scorers = applicableScorers(evalCase, args.scorers);

  /* One timeout for the whole case, covering every sample and every scorer.
     Per-request timeouts let a case with five slow samples run five times the
     budget, which is exactly the shape of a hung CI job. */
  const timer = withTimeout(args.timeoutMs, args.signal);

  const sampleValues: number[] = [];
  const vias: (ExtractionRoute | 'none')[] = [];
  const scoresBySample: Score[][] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let subjectCost: CostBreakdown | undefined;
  let judgeCost: CostBreakdown | undefined;
  let lastOutput: SubjectOutput | undefined;
  let lastExtraction: Extraction = { via: 'none', error: 'the case did not run' };
  let failure: { message: string; stack?: string } | undefined;

  try {
    for (let sample = 0; sample < args.samples; sample += 1) {
      const output = await callSubject(args, timer.signal);
      lastOutput = output;
      usage = addUsage(usage, output.usage);
      subjectCost = mergeCost(subjectCost, costOf(output.usage, output.model));

      /* Once per SAMPLE, not once per case: each sample is a different
         response and deserves its own reading. Within a sample every scorer
         shares it, so three scorers cannot disagree about what was produced. */
      const extraction = extractStructured(output);
      lastExtraction = extraction;
      vias.push(extraction.via);

      const scores: Score[] = [];
      for (const scorer of scorers) {
        if (extraction.via === 'none' && scorer.consumesExtraction) {
          /* NOT a zero. Zero asserts the model produced a wrong answer, and
             we did not establish that — we could not read one. The case is
             errored, which keeps it out of the baseline entirely. Scorers
             that do not read the extraction are unaffected and still run:
             an unparseable payload says nothing about whether the model
             called the right tool. */
          throw new ExtractionUnavailable(scorer.name, extraction.error);
        }
        const score = await invokeScorer(scorer, { case: evalCase, output, extraction });
        scores.push(score);
        judgeCost = mergeCost(judgeCost, judgeCostOf(score));
      }

      scoresBySample.push(scores);
      sampleValues.push(aggregate(scores));
    }
  } catch (error) {
    failure = flatten(error);
  } finally {
    timer.dispose();
  }

  const latencyMs = Date.now() - started;

  if (failure !== undefined) {
    return {
      caseId: evalCase.id,
      status: 'errored',
      extraction: lastExtraction,
      vias,
      weight,
      ...(lastOutput !== undefined && { output: lastOutput }),
      error: failure,
      scores: scoresBySample.at(-1) ?? [],
      passed: false,
      value: 0,
      samples: sampleValues.length,
      sampleValues,
      latencyMs,
      usage,
      ...(subjectCost !== undefined && { cost: subjectCost }),
    };
  }

  const value = mean(sampleValues);
  const lastScores = scoresBySample.at(-1) ?? [];

  return {
    caseId: evalCase.id,
    status: 'scored',
    extraction: lastExtraction,
    vias,
    weight,
    ...(lastOutput !== undefined && { output: lastOutput }),
    scores: meanScores(scoresBySample),
    passed: lastScores.every((score) => score.passed),
    value,
    samples: sampleValues.length,
    ...(sampleValues.length > 1 && { stdDev: populationStdDev(sampleValues) }),
    sampleValues,
    latencyMs,
    usage,
    ...(subjectCost !== undefined && {
      cost: judgeCost === undefined ? subjectCost : addCost(subjectCost, judgeCost),
    }),
  };
}

/** Signals that a scorer had no payload to read. Carried as an exception
 *  because it must abort the case rather than contribute a number. */
class ExtractionUnavailable extends Error {
  override readonly name = 'ExtractionUnavailable';
  constructor(scorerName: string, reason: string) {
    super(
      `scorer "${scorerName}" needs the extracted payload, which could not be read: ` +
        `${reason}. The case is errored rather than scored 0 — we declined to decide, ` +
        `which is not the same as deciding the model was wrong.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Subject invocation: cache, retry, timeout
 * ------------------------------------------------------------------ */

async function callSubject(args: CaseArgs, signal: AbortSignal): Promise<SubjectOutput> {
  let lastError: unknown;

  for (let attempt = 0; attempt < args.maxAttempts; attempt += 1) {
    /* attempt > 0 bypasses the cache unconditionally. A retry exists to
       re-roll the sample; serving the cached response would return the
       identical failure and make the retry a no-op that costs wall clock and
       proves nothing (ADR 007). */
    const cacheable = attempt === 0 && args.cache.kind === 'disk';
    const key = cacheable
      ? cacheKey({ subjectId: args.subjectId, input: args.evalCase.input })
      : undefined;

    if (key !== undefined && args.cache.kind === 'disk') {
      const hit = await readCache(args.cache.dir, key);
      if (hit !== undefined) return hit;
    }

    try {
      const output = await args.subject(args.evalCase.input, {
        signal,
        caseId: args.evalCase.id,
        attempt,
      });
      if (key !== undefined && args.cache.kind === 'disk') {
        await writeCache(args.cache.dir, key, output);
      }
      return output;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === args.maxAttempts - 1) throw error;
      await args.sleep(backoffMs(attempt, args.random));
    }
  }

  throw lastError;
}

/**
 * Retry transient failures only.
 *
 * A 4xx other than 429 is never retried: a malformed request will be malformed
 * again, and retrying it three times turns one clear error into the same error
 * arriving slowly. 429 and 5xx and transport errors are the ones where the
 * request was fine and the world was not.
 */
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || status >= 500;

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    error instanceof TypeError /* undici surfaces network faults as TypeError */
  );
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Exponential backoff with full jitter: 2^attempt seconds, randomised across
 *  the whole interval so a suite that rate-limits does not retry in lockstep
 *  and rate-limit itself again. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.floor(random() * ceiling);
}

function withTimeout(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`case timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onParentAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Disk cache
 * ------------------------------------------------------------------ */

/** Keyed on everything that can change the response. The model and parameters
 *  are the subject's business, so they enter through `subjectId` — a subject
 *  that changes model without changing its id is lying to the cache. */
export function cacheKey(args: { subjectId: string; input: unknown }): string {
  return createHash('sha256')
    .update(JSON.stringify({ subjectId: args.subjectId, input: args.input }))
    .digest('hex')
    .slice(0, 32);
}

async function readCache(dir: string, key: string): Promise<SubjectOutput | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')) as SubjectOutput;
  } catch {
    return undefined;
  }
}

async function writeCache(dir: string, key: string, output: SubjectOutput): Promise<void> {
  const path = join(dir, `${key}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(output));
}

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/**
 * Bounded parallel map, preserving input order in the output.
 *
 * Hand-rolled rather than a dependency: it is fifteen lines, and a library
 * whose entire surface is this function is a supply-chain entry in exchange
 * for nothing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function summarise(args: {
  results: CaseResult[];
  scorers: readonly Scorer[];
  startedAt: string;
  durationMs: number;
  suiteId: string;
}): RunSummary {
  const { results } = args;
  const scored = results.filter((r) => r.status === 'scored');

  const totals: SuiteTotals = {
    cases: results.length,
    passed: scored.filter((r) => r.passed).length,
    failed: scored.filter((r) => !r.passed).length,
    /* Counted apart from `failed` throughout: a case the harness could not
       evaluate is an infrastructure fact, and letting it look like a quality
       result is how a broken API key comes to resemble a regression. */
    errored: results.filter((r) => r.status === 'errored').length,
    weightedScore: weightedMean(scored),
  };

  const usage = results.reduce<Usage>((total, r) => addUsage(total, r.usage), {
    inputTokens: 0,
    outputTokens: 0,
  });
  const cost = results.reduce<CostBreakdown | undefined>(
    (total, r) => mergeCost(total, r.cost),
    undefined,
  );

  const viaDistribution: Record<string, number> = {};
  for (const result of results) {
    for (const via of result.vias) viaDistribution[via] = (viaDistribution[via] ?? 0) + 1;
  }

  const judgeCost = results.reduce<CostBreakdown | undefined>(
    (total, r) => r.scores.reduce<CostBreakdown | undefined>((c, s) => mergeCost(c, judgeCostOf(s)), total),
    undefined,
  );
  const subjectCost =
    cost === undefined
      ? undefined
      : judgeCost === undefined
        ? cost
        : {
            inputUsd: cost.inputUsd - judgeCost.inputUsd,
            outputUsd: cost.outputUsd - judgeCost.outputUsd,
            totalUsd: cost.totalUsd - judgeCost.totalUsd,
          };

  return {
    suiteId: args.suiteId,
    startedAt: args.startedAt,
    durationMs: args.durationMs,
    results,
    totals,
    usage,
    ...(cost !== undefined && { cost }),
    latency: latencyAggregate(results),
    /* The gate's answer is set by the baseline comparison; a run with no
       errored cases and no failures is the most this file can claim. */
    passed: totals.errored === 0 && totals.failed === 0,
    uncalibrated: collectUncalibrated(args.scorers),
    viaDistribution,
    ...(subjectCost !== undefined && { subjectCost }),
    ...(judgeCost !== undefined && { judgeCost }),
  };
}

/** Unweighted mean of a sample's scores. Every scorer counts equally within a
 *  case; case importance is expressed by `weight`, one level up. */
function aggregate(scores: readonly Score[]): number {
  if (scores.length === 0) return 1;
  return mean(scores.map((s) => s.value));
}

/** Per-scorer mean across samples, so the reported column is the same kind of
 *  number as the case value. */
function meanScores(scoresBySample: readonly Score[][]): Score[] {
  const first = scoresBySample[0];
  if (first === undefined) return [];

  return first.map((template, index) => {
    const across = scoresBySample.map((scores) => scores[index]).filter(isScore);
    const value = mean(across.map((s) => s.value));
    return {
      scorer: template.scorer,
      value,
      passed: across.every((s) => s.passed),
      ...(template.reason !== undefined && { reason: template.reason }),
      ...(template.meta !== undefined && { meta: template.meta }),
    };
  });
}

function isScore(score: Score | undefined): score is Score {
  return score !== undefined;
}

function weightedMean(results: readonly CaseResult[]): number {
  const totalWeight = results.reduce((total, r) => total + r.weight, 0);
  if (totalWeight === 0) return 0;
  return results.reduce((total, r) => total + r.value * r.weight, 0) / totalWeight;
}

function latencyAggregate(results: readonly CaseResult[]): LatencyAggregate {
  const sorted = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
    totalMs: sorted.reduce((total, ms) => total + ms, 0),
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function populationStdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function addUsage(a: Usage, b: Usage): Usage {
  const cacheReadTokens = sumOptional(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWriteTokens = sumOptional(a.cacheWriteTokens, b.cacheWriteTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
  };
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function mergeCost(
  a: CostBreakdown | undefined,
  b: CostBreakdown | undefined,
): CostBreakdown | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return addCost(a, b);
}

/** Judge usage rides in `Score.meta.judgeUsage`, priced against the judge's
 *  own model rather than the subject's. */
function judgeCostOf(score: Score): CostBreakdown | undefined {
  const usage = score.meta?.['judgeUsage'];
  const model = score.meta?.['judgeModel'];
  if (!isUsage(usage)) return undefined;
  const modelId =
    typeof model === 'string'
      ? model
      : typeof (model as { modelId?: unknown } | undefined)?.modelId === 'string'
        ? (model as { modelId: string }).modelId
        : undefined;
  return modelId === undefined ? ZERO_COST : costOf(usage, modelId);
}

function isUsage(value: unknown): value is Usage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Usage).inputTokens === 'number' &&
    typeof (value as Usage).outputTokens === 'number'
  );
}

function flatten(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack !== undefined && { stack: error.stack }) };
  }
  return { message: String(error) };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
