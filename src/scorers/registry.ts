/**
 * Wiring checks between the cases and the scorers that will run against them.
 *
 * This runs before the first API call. Everything it catches is a mistake that
 * would otherwise surface as a *passing* run — which is why every one of them
 * is a hard error and none of them is a flag.
 */

import { ProblemListError } from '../errors.js';
import type { EvalCase, ExpectationClaim, Scorer } from '../types.js';

/** A case carries an expectation nothing reads, a case is measured by nothing,
 *  a `meta` key shadows a claimed one, or two scorers share a name. */
export class ExpectationError extends ProblemListError {
  override readonly name = 'ExpectationError';

  constructor(problems: readonly string[]) {
    super('Invalid expectation wiring', problems);
  }
}

/** How many case ids to name before summarising the rest. */
const MAX_LISTED_IDS = 5;

/**
 * Whether a scorer can run against a case, and what is missing if not.
 *
 * `applies` is about capability: every required claim is present, so the
 * scorer has what it needs. `measures` is a stricter question — does this case
 * actually ask this scorer for anything? A scorer with no required claims
 * (`formatCompliance`) applies to every case in the suite, which is correct
 * for running it but would neutralise the fully-skipped-case guard below if it
 * also counted as measurement. So a scorer measures a case only when at least
 * one of its claimed keys is actually present in that case's `expect`.
 */
export type Applicability = {
  scorer: Scorer;
  applies: boolean;
  measures: boolean;
  missingRequired: readonly string[];
};

/** Which of `scorers` can run against `evalCase`. This is the check the runner
 *  performs per case; a scorer that does not apply is skipped, not failed. */
export function applicableScorers(
  evalCase: EvalCase,
  scorers: readonly Scorer[],
): readonly Scorer[] {
  return scorers.filter((scorer) => assess(evalCase, scorer).applies);
}

function assess(evalCase: EvalCase, scorer: Scorer): Applicability {
  const missingRequired = scorer.claims
    .filter((claim: ExpectationClaim) => claim.required && !(claim.key in evalCase.expect))
    .map((claim) => claim.key);
  const present = scorer.claims.filter((claim) => claim.key in evalCase.expect);

  const applies = missingRequired.length === 0;
  return { scorer, applies, measures: applies && present.length > 0, missingRequired };
}

/**
 * Asserts that the suite and its scorers are wired such that every case is
 * actually measured by something.
 *
 * TWO HALVES OF ONE GUARANTEE
 * ---------------------------
 * `EvalCase.expect` is an open record, because each scorer owns its own keys
 * and a closed type would couple the case contract to its consumers. The cost
 * of that openness is that silence is ambiguous, and it fails in two
 * directions:
 *
 *   1. A key nobody reads. Write `field:` where you meant `fields:` and the
 *      file is valid YAML, satisfies the case schema, and loads without
 *      complaint — then is read by nobody. The expectation exists and is
 *      enforced by nothing.
 *
 *   2. A case nobody measures. Every scorer skips it, correctly and
 *      individually: no `fields`, no `schema`, no `toolCalls`. Each skip is a
 *      reasonable local decision; together they mean the case runs, costs
 *      money, and produces a result with no checks in it.
 *
 * Either one produces a green suite that measures less than it did yesterday,
 * with no signal that it happened. That is strictly worse than a red suite: a
 * red suite gets investigated, and a green one sells confidence nobody earned.
 * So both are hard errors, and a case that nothing measures is impossible to
 * commit.
 *
 * Annotations that are genuinely not expectations belong in
 * {@link EvalCase.meta} — but see the collision check below, because `meta` is
 * a place to put things that are not expectations, not a second place to put
 * things that are.
 *
 * @throws {ExpectationError} listing every problem found, in one pass.
 */
export function validateExpectations(cases: readonly EvalCase[], scorers: readonly Scorer[]): void {
  const problems: string[] = [];

  /* Scorer-side problems first: if the registry itself is inconsistent, the
     case-side report is built on a claim set that cannot be trusted, and
     leading with fifty downstream symptoms would bury the cause. */
  const owners = new Map<string, string>();
  const seenNames = new Set<string>();

  for (const scorer of scorers) {
    if (seenNames.has(scorer.name)) {
      problems.push(
        `duplicate scorer name "${scorer.name}": names become baseline columns, ` +
          `so two scorers sharing one would overwrite each other's history. ` +
          `Pass a \`name\` option to distinguish them`,
      );
      continue;
    }
    seenNames.add(scorer.name);

    /* SHARED KEYS ARE FINE. An earlier version of this file rejected two
       scorers claiming the same key as "ambiguous ownership". That was wrong:
       nothing dispatches by key. The runner runs every applicable scorer and
       each writes its own column, so `exactFields` and a lenient second
       instance both reading `fields` is not ambiguous — they both read it, and
       both results are recorded separately.

       The mistake was importing an intuition from static analysis, where a
       rule really does own its identifier because exactly one rule reports a
       given diagnostic. Here the relationship is many-to-many by design.
       ADR 003 records this. Duplicate scorer NAMES are still rejected above,
       because a name is a baseline column and a collision there silently
       merges two different measurements into one history. */
    for (const claim of scorer.claims) {
      if (!owners.has(claim.key)) owners.set(claim.key, scorer.name);
    }
  }

  const claimedKeys = [...owners.keys()].sort();

  /* Grouped by key rather than by case: one mistyped key copy-pasted across
     fifty cases is one mistake, and fifty near-identical lines would bury the
     other problems in the same report. */
  const unclaimed = new Map<string, string[]>();

  for (const evalCase of cases) {
    for (const key of Object.keys(evalCase.expect).sort()) {
      if (owners.has(key)) continue;
      const ids = unclaimed.get(key);
      if (ids === undefined) unclaimed.set(key, [evalCase.id]);
      else ids.push(evalCase.id);
    }

    /* `meta` is for things that are not expectations. A key there that a
       scorer claims is never a deliberate choice — it is an expectation that
       was moved out of harm's way and is now silently unenforced. No opt-in
       switch: a control nobody enables is not a control. */
    for (const key of Object.keys(evalCase.meta ?? {}).sort()) {
      const owner = owners.get(key);
      if (owner === undefined) continue;
      problems.push(
        `case "${evalCase.id}": \`meta.${key}\` collides with an expectation key ` +
          `claimed by "${owner}". \`meta\` is never scored, so an expectation placed ` +
          `there is silently ignored — move it into \`expect\``,
      );
    }

    const assessments = scorers.map((scorer) => assess(evalCase, scorer));
    if (!assessments.some((a) => a.measures)) {
      problems.push(`case "${evalCase.id}" is measured by no scorer: ${explainSkips(assessments)}`);
    }
  }

  for (const [key, ids] of [...unclaimed.entries()].sort(([a], [b]) => compare(a, b))) {
    problems.push(
      `unclaimed key "${key}" in ${ids.length} ${ids.length === 1 ? 'case' : 'cases'} ` +
        `(${explainUnclaimed(key, claimedKeys)}): ${listIds(ids)}`,
    );
  }

  if (problems.length > 0) throw new ExpectationError(problems);
}

/** Says, per scorer, exactly why it will not measure this case — the author
 *  needs the missing key name, not the fact that something was skipped. */
function explainSkips(assessments: readonly Applicability[]): string {
  if (assessments.length === 0) return 'no scorers are registered';
  return assessments
    .map(({ scorer, applies, missingRequired }) =>
      applies
        ? `"${scorer.name}" reads none of this case's expectation keys`
        : `"${scorer.name}" skipped (missing required ${missingRequired
            .map((key) => `"${key}"`)
            .join(', ')})`,
    )
    .join('; ');
}

function explainUnclaimed(key: string, claimedKeys: readonly string[]): string {
  const suggestion = nearest(key, claimedKeys);
  if (suggestion !== undefined) return `no scorer claims it; did you mean "${suggestion}"?`;
  if (claimedKeys.length === 0) return 'no registered scorer claims any expectation key';
  return `no scorer claims it; claimed keys are ${claimedKeys.map((k) => `"${k}"`).join(', ')}`;
}

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED_IDS).join(', ');
  const remaining = ids.length - Math.min(ids.length, MAX_LISTED_IDS);
  return remaining > 0 ? `${shown}, ... (+${remaining} more)` : shown;
}

/** Closest claimed key within a distance that scales with length, so `field`
 *  suggests `fields` but `notes` does not suggest `tools`. */
function nearest(key: string, candidates: readonly string[]): string | undefined {
  const budget = Math.max(1, Math.floor(key.length / 3));
  let best: { key: string; distance: number } | undefined;

  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance > budget) continue;
    if (best === undefined || distance < best.distance) best = { key: candidate, distance };
  }
  return best?.key;
}

/** Levenshtein, single-row. Inlined rather than pulled from a dependency:
 *  it is fifteen lines and only ever runs on a failure path. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
