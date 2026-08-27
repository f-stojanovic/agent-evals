/**
 * The stable contract of the harness.
 *
 * Everything else in this repo is replaceable: scorers, runners, reporters,
 * providers. These types are not. They are what a baseline file is written
 * against, so changing them retroactively invalidates recorded history.
 *
 * Convention: `type` for plain data (structural, no inheritance, cheap to
 * union), `interface` only where something is meant to be implemented or
 * merged into. TypeScript makes the two nearly interchangeable; the split is
 * a signal to the reader about intent, not a technical necessity.
 */

/**
 * Token accounting for a single subject invocation.
 *
 * Kept separate from cost on purpose: tokens are an observed fact reported by
 * the provider, while cost is derived from a price table that changes over
 * time. Storing tokens means an old run can be re-priced later; storing only
 * dollars would freeze a stale price into the record.
 *
 * The cache fields are optional because not every provider (or every request)
 * reports them.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/**
 * A single tool invocation the subject attempted.
 *
 * `input` is `unknown` rather than a generic: tool arguments are provider
 * JSON, and the harness has no business assuming a shape it did not define.
 * Scorers that care about a specific tool narrow it themselves, at the point
 * where they actually know the schema.
 *
 * `id` is optional because not every provider or transcript format emits one.
 */
export type ToolCall = {
  name: string;
  input: unknown;
  id?: string;
};

/**
 * The observable result of running the thing under test, once.
 *
 * `raw` is deliberately preserved and deliberately `unknown`. Scorers written
 * a year from now will want fields nobody thought to normalise today (stop
 * reason, thinking blocks, citations, refusal signals). Throwing the provider
 * response away at the boundary makes those scorers impossible to write
 * retroactively; keeping it makes them a same-day change.
 *
 * `text` and `toolCalls` are optional because an agent turn may legitimately
 * produce neither, one, or both. An absent field means "the subject did not
 * produce this", never "the harness failed to look".
 *
 * `model` and `latencyMs` live here rather than on the result wrapper because
 * they describe this specific invocation. A retried case may hit a different
 * model version; the per-invocation record is what makes that visible.
 */
export type SubjectOutput = {
  text?: string;
  toolCalls?: ToolCall[];
  raw: unknown;
  model: string;
  usage: Usage;
  latencyMs: number;
};

/**
 * Ambient information a subject needs but that is not part of its input.
 *
 * `signal` is mandatory, not optional. A harness that cannot cancel in-flight
 * work turns one hung request into a hung CI job, and per-case timeouts are
 * the runner's job to enforce — which it can only do if every subject accepts
 * a signal.
 *
 * `caseId` is here purely for correlation: logs, traces, and provider
 * metadata. Subjects must not branch on it — a subject that behaves
 * differently per case is not the thing being measured.
 */
export type SubjectContext = {
  signal: AbortSignal;
  caseId: string;
  /**
   * 0-based retry counter, incremented by the runner on each re-attempt of the
   * same case.
   *
   * THE RULE
   * --------
   * The request sent to the model must be byte-identical across attempts:
   * same prompt, same parameters, same tool definitions. Everything outside
   * that request is free to differ — transport, timeouts, connection pooling,
   * logging, tracing, and cache behaviour.
   *
   * The line is drawn at the request rather than at "behaviour" because that
   * is the boundary a baseline actually describes. A subject that switches to
   * a stricter prompt on attempt 1 records a score for a system the deployed
   * one does not match, which is the one thing an eval must never do. A
   * subject that skips its HTTP cache on attempt 1 records a score for exactly
   * the same system, sampled again.
   *
   * TWO CONSEQUENCES — POLICY, NOT IMPLEMENTATION DETAIL
   * ----------------------------------------------------
   * 1. `attempt > 0` always bypasses the cache. A retry exists to re-roll the
   *    sample from a stochastic system; serving the cached response would
   *    return the identical failure and make the retry a no-op that costs
   *    wall-clock and proves nothing.
   *
   * 2. Baseline recording and CI runs disable the cache entirely, including on
   *    attempt 0. A baseline assembled from replayed responses is a record of
   *    the cache's contents, not of the model's behaviour: it would stay green
   *    across a model upgrade, a prompt change, and a provider incident alike,
   *    which is precisely the regression the gate is supposed to catch.
   */
  attempt: number;
};

/**
 * The thing under test, reduced to a function.
 *
 * Not a class and not an interface: anything that can turn an input into a
 * `SubjectOutput` qualifies — a raw API call, a full agent loop, a shell
 * command wrapper, or a stub in a test. Keeping this a bare function type is
 * what lets the entire harness be exercised without a network.
 */
export type Subject = (input: unknown, ctx: SubjectContext) => Promise<SubjectOutput>;

/** Applied when a case omits `weight`. Kept as a named constant so the
 *  default is visible in scoring code instead of being a bare `?? 1`. */
export const DEFAULT_CASE_WEIGHT = 1;

/**
 * How the structured payload was recovered, most to least compliant.
 *
 *   - `tool-call`  — the model used the tool it was given.
 *   - `json`       — the whole response was JSON.
 *   - `fenced`     — the whole response was a single markdown code fence.
 *   - `scavenged`  — one fenced block had to be dug out of surrounding prose.
 */
export type ExtractionRoute = 'tool-call' | 'json' | 'fenced' | 'scavenged';

/**
 * Every way a sample's payload can turn out, including the two failures.
 *
 * THE TWO FAILURES ARE DIFFERENT FINDINGS AND MUST NOT COLLAPSE.
 *
 *   - `unreadable` — the response contained no parseable JSON at all. The model
 *     demonstrably failed to produce the requested output. That is a fact about
 *     the model, it scores 0.0 with a reason, and it belongs in the baseline so
 *     a format collapse shows up as a score drop on the day it starts.
 *   - `ambiguous` — several fenced blocks each parsed, and there is no
 *     principled way to choose between them. Nothing about the model was
 *     established; the harness declined to decide. That is a fact about the
 *     harness, it errors the case, and it stays out of the baseline.
 *
 * "The model was wrong" and "we cannot tell" are the two ends of the axis this
 * repository exists to measure. An earlier version mapped both onto a single
 * `none`, which made a total format collapse indistinguishable from a parser
 * that could not pick a code block — and, worse, kept both out of the
 * baseline, so the collapse left no trace in the recorded history.
 */
export type ExtractionOutcome = ExtractionRoute | 'unreadable' | 'ambiguous';

/**
 * The result of reading structured data out of a response — computed once per
 * SAMPLE by the runner, then handed to every scorer scoring that sample.
 *
 * It is not a per-scorer concern. Three scorers each re-parsing the same
 * response would store the same `via` three times, cost three parses, and
 * leave open the possibility of two scorers disagreeing about what the model
 * produced. One extraction per sample, one answer, and the routes recorded on
 * {@link CaseResult.vias}.
 *
 * The two failure arms are distinct on purpose. See {@link ExtractionOutcome}.
 */
export type Extraction =
  | { via: ExtractionRoute; data: unknown }
  /** No parseable JSON anywhere. A fact about the model: scored 0, recorded. */
  | { via: 'unreadable'; error: string }
  /** Several parseable candidates. A fact about the harness: case errored. */
  | { via: 'ambiguous'; error: string; fenceCount: number };

/** What a scorer is handed. A named object so adding a field later does not
 *  break every implementor. */
export type ScoreArgs = {
  case: EvalCase;
  output: SubjectOutput;
  /** Shared, already computed. Scorers that do not need it ignore it. */
  extraction: Extraction;
};

/**
 * One test case, authored by a human in YAML.
 *
 * WHY `id` MUST BE STABLE
 * -----------------------
 * `id` is the primary key of the baseline. The baseline file records "case
 * `refund-urgent-01` scored 0.83"; the CI gate compares the next run against
 * that row by id and nothing else. So:
 *
 *   - Renaming an id reads as "the old case vanished, a new one appeared".
 *     Its recorded history is orphaned and the gate has no prior to compare
 *     against, so a genuine regression can slip through unnoticed.
 *   - Deriving the id from content (a hash of the input, an array index, a
 *     filename) is worse: fixing a typo in the prompt would silently rotate
 *     the key and wipe the history of a case that did not conceptually change.
 *
 * Hence: human-authored, meaningful, and treated as append-only. Change the
 * input freely; change the id only when the case genuinely became a different
 * question, and accept that you are starting its history over.
 *
 * `input` is `unknown` because the harness does not own the subject's input
 * schema — the subject does, and it validates at its own boundary.
 *
 * `expect` is an open record rather than a fixed shape because each scorer
 * reads its own keys out of it (an exact-match scorer wants `fields`, a judge
 * wants `rubric`). A closed type here would force every new scorer to edit
 * this file, coupling the contract to its consumers.
 */
export type EvalCase = {
  /** Stable, human-authored, globally unique. The baseline key. See above. */
  id: string;
  /** Free-text note on what this case is probing. Read by humans, not code. */
  description?: string;
  /** Passed verbatim to the subject. */
  input: unknown;
  /** Scorer-defined expectations. Each scorer reads the keys it owns. */
  expect: Record<string, unknown>;
  /** For slicing results (`--tag regression`, `--tag ambiguous`). */
  tags?: string[];
  /** Relative importance in the suite aggregate. Defaults to
   *  {@link DEFAULT_CASE_WEIGHT} when absent. */
  weight?: number;
  /**
   * Free-form authoring annotations: `owner`, `ticket`, links to the incident
   * that motivated the case, whatever the team finds useful.
   *
   * The harness never reads this. Nothing in it may influence loading,
   * scoring, aggregation, or the baseline gate — it exists purely so that
   * `expect` can stay strictly scorer-owned. Without it, humans annotate cases
   * by inventing keys inside `expect`, and every such key then looks
   * indistinguishable from an expectation that no scorer got round to
   * consuming. See `validateExpectations` in `src/scorers/registry.ts`.
   */
  meta?: Record<string, unknown>;
};

/**
 * One scorer's verdict on one case.
 *
 * WHY `value` IS CONTINUOUS
 * -------------------------
 * `value` is a number in [0, 1] and never a boolean, because a boolean throws
 * away the only signal that makes an eval suite useful over time:
 *
 *   - Direction. "18/20 passing" is identical before and after a change that
 *     moved every failing case from hopeless to nearly-right. A mean of 0.41
 *     rising to 0.78 is not.
 *   - Sensitivity. Partial credit (4 of 5 extracted fields correct) is the
 *     difference between a prompt tweak that helped and one that did nothing.
 *     Booleans quantise that away and make small real improvements invisible.
 *   - Threshold tuning. With a stored continuous value you can re-ask "what
 *     would the gate have said at 0.7?" against historical runs. With a stored
 *     boolean the threshold is baked in and the question is unanswerable.
 *
 * `passed` is therefore derived — `value >= threshold` — and is a convenience
 * for reporting, not the source of truth. Never persist `passed` without
 * `value`, and never let a scorer emit only 0.0 or 1.0 when a graded answer is
 * available.
 *
 * `reason` matters more than it looks: a failing case with no explanation
 * costs a human the full re-run to understand it. Judge scorers should always
 * populate it; deterministic scorers should populate it on failure.
 */
export type Score = {
  /** Scorer name, matching {@link Scorer.name}. Identifies the column. */
  scorer: string;
  /** Continuous, 0..1 inclusive. Never a coerced boolean. See above. */
  value: number;
  /** Derived from a threshold. Reporting convenience, not ground truth. */
  passed: boolean;
  /** Human-readable justification. Populate at least on failure. */
  reason?: string;
  /** Scorer-specific detail (per-field diffs, rubric split). Free-form, and
   *  deliberately not the place for anything the harness itself reads. */
  meta?: Record<string, unknown>;
  /**
   * Tokens this scorer spent grading, if it called a model of its own.
   *
   * Typed rather than tucked into `meta` under an agreed key. The runner needs
   * this to separate what grading cost from what the subject cost, and a
   * convention that the runner reads `meta.judgeUsage` is a contract with no
   * compiler behind it: any scorer that happened to use the same key name got
   * counted as judge spend, and any that renamed it silently stopped being
   * counted at all.
   */
  judgeUsage?: Usage;
  /** Model id that produced {@link Score.judgeUsage}, for pricing it against
   *  the right rate rather than the subject's. */
  judgeModel?: string;
};

/**
 * An interface, not a type alias, because it is meant to be implemented —
 * both by objects in this repo and by users writing their own scorers.
 *
 * Scoring is async even for purely deterministic scorers so that swapping a
 * string comparison for an LLM judge is not a breaking signature change for
 * every caller.
 *
 * The argument is a single named object rather than positional parameters:
 * `score({ case, output })` reads unambiguously at every call site, and
 * adding a future field (a logger, a signal) does not break implementors.
 */
/**
 * One expectation key a scorer reads, and whether it can work without it.
 *
 * The `required` flag is what lets the runner tell "this check does not apply
 * to this case" apart from "this case is misconfigured" — two situations that
 * look identical from the outside and call for opposite responses.
 *
 *   - `required: true` — the scorer cannot run without the key. A case that
 *     omits it causes the scorer to be SKIPPED for that case. Not a failure
 *     and not a zero: a schema check against a case that specifies no schema
 *     has no opinion, and recording 0.0 would drag down a suite aggregate with
 *     a number that means nothing. Recording 1.0 would be worse.
 *   - `required: false` — the key refines behaviour when present. The scorer
 *     runs either way.
 *
 * Without the flag, a runner seeing `expect` with no `schema` key cannot know
 * whether `matchesSchema` should be skipped or whether someone deleted a line
 * by accident. With it, skipping is a declared, checkable outcome — and
 * `validateExpectations` can then reject the one case that must never exist:
 * a case where every scorer skips, which would run, cost money, and measure
 * nothing.
 */
export type ExpectationClaim = {
  key: string;
  required: boolean;
};

export interface Scorer {
  /** Stable identifier. Becomes {@link Score.scorer} and a baseline column,
   *  so it carries the same stability obligation as {@link EvalCase.id}. */
  readonly name: string;
  /**
   * The keys of {@link EvalCase.expect} this scorer reads.
   *
   * Declaring them turns the suite's most dangerous failure mode into a
   * startup error. Expectations are a loose bag of scorer-owned keys, so a
   * case that says `field:` where it meant `fields:` is structurally valid,
   * loads without complaint, and is then simply not read by anyone. The case
   * runs, scores 1.0 for having nothing to check, and the suite reports green
   * while measuring nothing. A green eval that measures nothing is strictly
   * worse than a red one: it actively buys confidence that is not there.
   *
   * With `claims` declared, the union of all scorers' claims can be checked
   * against the keys actually present across all cases before a single API
   * call is made. Anything unclaimed is a typo or a scorer someone forgot to
   * register, and both are loud. It also makes ownership explicit: two scorers
   * claiming the same key is an ambiguity worth failing on rather than
   * resolving by registration order.
   *
   * Non-authoritative annotations belong in {@link EvalCase.meta}, which no
   * scorer claims — and which is rejected outright if it collides with a
   * claimed key, since `meta.fields` is never anything but a mistake.
   *
   * See {@link ExpectationClaim} for why each claim carries a `required` flag
   * rather than being a bare key.
   */
  readonly claims: readonly ExpectationClaim[];
  /**
   * Whether this scorer reads {@link ScoreArgs.extraction}.
   *
   * Extraction runs once per sample and can fail — no parseable payload, or
   * several that each parse and no principled way to choose. When it does, the
   * scorers that depend on it have nothing to work with and are marked
   * errored. Scorers that read `output.text` directly are unaffected and still
   * produce a score.
   *
   * Declared per instance rather than per factory, because it can depend on
   * configuration: `semanticSimilarity` reads the response text by default and
   * the extracted payload only when `compare` names a path into it.
   */
  readonly consumesExtraction: boolean;
  /**
   * Smallest number of samples per case under which this scorer's output is
   * not worth recording. The runner refuses to start a suite that violates it.
   *
   * Exists for the judge. A single verdict from a probabilistic grader is an
   * anecdote, and there is no longer a `temperature` parameter to suppress the
   * variance with, so the only honest response is to sample and measure. A
   * scorer that is deterministic leaves this unset.
   */
  readonly minSamples?: number;
  /**
   * Constants this scorer uses that are not derived from data.
   *
   * Collected by the runner and printed in the report footer, so a reader can
   * see how much of the number in front of them is convention. Declared per
   * scorer rather than in a global registry: the constants belong to the
   * scorer that guesses them, and their lifetime is its lifetime.
   */
  readonly uncalibrated?: readonly UncalibratedConstant[];
  score(args: ScoreArgs): Promise<Score>;
}

/** A constant nobody measured. See {@link Scorer.uncalibrated}. */
export type UncalibratedConstant = {
  /** Stable identifier, unique within a scorer. */
  readonly id: string;
  readonly value: number;
  /** What the number does, and what would have to be measured to justify it. */
  readonly note: string;
};

/**
 * Cost in USD, derived from {@link Usage} and a price table.
 *
 * Broken out per token class rather than kept as a single number because the
 * interesting optimisation question is almost always "which class dominates" —
 * a suite whose spend is 90% cache writes has a very different fix than one
 * that is 90% output tokens.
 */
export type CostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd?: number;
  cacheWriteUsd?: number;
  totalUsd: number;
};

/**
 * Why some part of a cost is not known.
 *
 * Two reasons, kept apart for the same reason {@link ExtractionOutcome} keeps
 * `unreadable` apart from `ambiguous`: they are different findings with
 * different responses.
 *
 *   - `unpriced` — the run happened and the tokens are known; this build has no
 *     price for that model. A fact about `PRICES`, fixed by adding a row.
 *   - `uncomputable` — the tokens themselves are not known. A fact about what
 *     arrived, and it means a number somewhere upstream is missing rather than
 *     zero.
 *
 * Collapsing them would tell a reader "not priced (no price table entry)" when
 * the truth was that the accounting never arrived, which is a report asserting
 * something it did not establish.
 */
export type CostGap =
  | { kind: 'unpriced'; model: string }
  | { kind: 'uncomputable'; detail: string };

/**
 * A cost, or an account of why there isn't one.
 *
 * WHY THIS IS A UNION AND NOT `CostBreakdown | undefined`
 * ------------------------------------------------------
 * It used to be the latter, and `undefined` had to carry two meanings that
 * behave differently. Worse, the arithmetic had a third state nobody named: a
 * missing token count made `inputUsd` `NaN` while `outputUsd` stayed a real
 * number, so `costOf` returned an object where one field was a measurement and
 * another was not. Serialised, `NaN` becomes `null`, and a null cost in a run
 * artifact is indistinguishable from a free one.
 *
 * THE RULE THIS TYPE EXISTS TO ENFORCE: an unknown cost must never be
 * representable as a number. There is no arm here that holds a partially
 * computed breakdown as if it were the answer. `unknown` may carry
 * `pricedPortion` — the part that IS known — but it is a separate field with a
 * name that cannot be mistaken for a total, and the renderer prints the word
 * before it prints any figure.
 *
 * `undefined` still means something, and something narrower than before: no
 * cost component existed at all, because nothing ran.
 *
 * See ADR 026.
 */
export type Cost =
  | { kind: 'known'; breakdown: CostBreakdown }
  | {
      kind: 'unknown';
      gaps: CostGap[];
      /** What could be priced, when some components could and others could not.
       *  Never a total. Never rendered without the word "unknown" first. */
      pricedPortion?: CostBreakdown;
    };

/**
 * Latency distribution across a suite.
 *
 * Percentiles rather than a mean: agent latency is heavy-tailed, and the mean
 * hides exactly the slow-tail behaviour worth acting on.
 *
 * Aggregation is deliberately not implemented yet — this is the shape the
 * runner will fill in.
 */
export type LatencyAggregate = {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
};

/** Case-level tallies. Split out so a reporter can render a summary line
 *  without walking every result. */
export type SuiteTotals = {
  cases: number;
  passed: number;
  failed: number;
  /** Cases that threw before producing output. Counted apart from `failed`:
   *  a crashed subject is an infrastructure problem, not a quality signal,
   *  and conflating the two makes a broken API key look like a regression. */
  errored: number;
  /** Weighted mean of case scores, 0..1. */
  weightedScore: number;
};

/**
 * The outcome of one case: what the subject did, and what each scorer made
 * of it.
 *
 * `output` and `error` are both optional and mutually exclusive in practice —
 * a case either produced output or blew up. They are not modelled as a
 * discriminated union because a case can also produce output *and* have a
 * scorer throw, and a union would force that middle state to be discarded.
 *
 * `error` stores a flattened message/stack rather than an `Error` instance
 * because results must survive `JSON.stringify` to reach a baseline file.
 */
export type CaseResult = {
  caseId: string;
  /**
   * `scored` means every applicable scorer produced a number and the case
   * belongs in the baseline. `errored` means at least one did not, and the
   * case is excluded from the baseline entirely.
   *
   * The distinction is not cosmetic. Recording 0.0 for a case the harness
   * could not evaluate asserts that the model was wrong, which is a claim we
   * did not establish — we declined to decide. An invented measurement is
   * worse than a refused one, because it enters the baseline, drags the suite
   * mean, and is indistinguishable six months later from a case the model
   * genuinely failed.
   *
   * An errored case fails the run on its own path, with its own message.
   */
  status: 'scored' | 'errored';
  /**
   * How each sample's payload turned out, in draw order.
   *
   * The only record of extraction on a result. An earlier version also carried
   * a single `extraction` field holding the LAST sample's — accurate, and an
   * invitation to read it as the case's. A field whose correct reading depends
   * on remembering a doc comment is a defect even when the type is right, so
   * it is gone and this list is the answer.
   *
   * Feeds the suite-wide distribution in the report, which is a metric rather
   * than an assertion: it describes the run, it does not grade it.
   */
  vias: ExtractionOutcome[];
  /** Weight actually applied, resolved from the case. Recorded rather than
   *  recomputed so a historical result stays interpretable after the case's
   *  weight is edited. */
  weight: number;
  output?: SubjectOutput;
  error?: { message: string; stack?: string };
  scores: Score[];
  /** True only if every score passed. Derived, like {@link Score.passed}. */
  passed: boolean;
  /**
   * The case's aggregate score, 0..1 — the MEAN across all samples.
   *
   * With `samples === 1` this is just that one sample's aggregate. With more,
   * it is their arithmetic mean, and {@link CaseResult.stdDev} describes how
   * far they scattered.
   */
  value: number;
  /**
   * How many times the case was run.
   *
   * WHY SAMPLING IS IN THE BASELINE CONTRACT FROM THE START
   * ------------------------------------------------------
   * The subject is stochastic. One run of one case is a single draw from a
   * distribution, so `value` is an estimate with an error bar nobody measured.
   * Everything the gate does downstream rests on that estimate:
   *
   *   - A fixed tolerance ("fail if a case drops more than 0.05") is a guess
   *     about that error bar, applied uniformly to cases whose real variance
   *     differs by an order of magnitude. Set it loose enough for the noisiest
   *     case and it stops catching regressions on the stable ones; set it
   *     tight and the noisy cases flap until someone disables the gate.
   *   - Measured per-case variance replaces the guess with a derived number:
   *     a drop is a regression when it is large relative to how much that
   *     specific case moves on its own.
   *
   * And variance is a result in its own right, not just an error term. A case
   * scoring 0.6 ± 0.35 is a different and more urgent problem than one
   * scoring 0.6 ± 0.02 — the first is a coin flip in production. Averaging it
   * to a single number hides exactly the instability worth acting on, which is
   * why `stdDev` is recorded next to `value` rather than consumed and dropped.
   *
   * These fields are part of the contract now, before any baseline file
   * exists, because adding them later would mean every recorded row predates
   * them and no historical comparison could use them.
   *
   * Sampling logic is not implemented — this is the shape the runner fills in.
   */
  samples: number;
  /**
   * Population standard deviation of the per-sample aggregate values.
   *
   * Population rather than sample stddev: these are all the draws that were
   * taken, and the number describes their spread rather than estimating a
   * wider population's. Undefined when `samples === 1`, where spread is not a
   * meaningful quantity — deliberately not 0, which would claim the case is
   * perfectly stable when it has simply never been re-run.
   */
  stdDev?: number;
  /**
   * Every per-sample aggregate value, in the order they were drawn.
   *
   * IN MEMORY AND IN `.artifacts/` ONLY — NEVER IN THE BASELINE. The baseline
   * carries `value`, `stdDev`, and `samples`, and nothing more.
   *
   * The rule is the same one that governs {@link SubjectOutput.raw}: keep
   * everything for re-analysis, persist only what a human can review in a
   * diff. Five raw numbers per case per run would make the baseline diff
   * unreadable and unreviewable, and reviewability is the entire mechanism —
   * a baseline nobody reads is a rubber stamp. Meanwhile the samples are worth
   * keeping in the run artifacts: a bimodal case (three runs at 1.0, two at
   * 0.0) and a genuinely middling one (five runs near 0.6) have the same mean
   * and similar stddev, and only the raw draws tell them apart.
   */
  sampleValues: number[];
  /**
   * Per-scorer population standard deviation across samples, keyed by scorer
   * name. Undefined when `samples === 1`, for the same reason
   * {@link CaseResult.stdDev} is.
   *
   * This exists because {@link CaseResult.stdDev} describes the spread of the
   * case MEAN, and the mean is an average over scorers. A scorer that moved
   * while the others held still is invisible in it — which is exactly the
   * regression the per-scorer screen is for, and it needs a per-scorer noise
   * estimate to set an allowance from. See ADR 022.
   */
  scorerStdDev?: Record<string, number>;
  /** Wall clock for the whole case, including scoring — which is why this is
   *  not simply {@link SubjectOutput.latencyMs}. */
  latencyMs: number;
  usage: Usage;
  /** Subject and judge combined. */
  cost?: Cost;
  /** The subject's share alone, recorded rather than derived by subtracting
   *  the judge's from the total. */
  subjectCost?: Cost;
};

/**
 * The outcome of a whole suite run: the unit that gets compared against the
 * baseline and, eventually, written back as the new one.
 *
 * Timestamps are ISO-8601 strings, not `Date`, so the record round-trips
 * through JSON unchanged.
 *
 * Aggregation logic is not implemented yet; these are the fields the runner
 * will populate.
 */
export type SuiteResult = {
  suiteId: string;
  /** ISO-8601. Identifies the run in the baseline history. */
  startedAt: string;
  durationMs: number;
  results: CaseResult[];
  totals: SuiteTotals;
  /** Suite-wide token sum. Individual usage stays on each case. */
  usage: Usage;
  cost?: Cost;
  latency: LatencyAggregate;
  /** The CI gate's answer. Derived from totals plus the baseline comparison,
   *  never set directly by a scorer. */
  passed: boolean;
};
