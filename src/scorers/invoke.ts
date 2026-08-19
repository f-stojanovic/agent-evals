/**
 * The single call path from the harness to a scorer.
 *
 * Every scorer invocation goes through here so that the contract in
 * {@link Score} is enforced at runtime, not merely documented. Scorers are the
 * part of this system most likely to be written by someone else, in a hurry,
 * against a fuzzy mental model of what a "score" is.
 */

import type { Score, ScoreArgs, Scorer } from '../types.js';

/** A scorer violated the {@link Score} contract. Always a bug in the scorer,
 *  never a property of the model being evaluated — which is why it throws
 *  rather than resolving to a failing score. */
export class InvalidScoreError extends Error {
  override readonly name = 'InvalidScoreError';

  constructor(scorerName: string, problems: readonly string[]) {
    super(`Scorer "${scorerName}" returned an invalid Score: ${problems.join('; ')}`);
  }
}

/**
 * Calls `scorer.score(args)` and validates what comes back.
 *
 * Deliberately does NOT retry, time out, or catch exceptions from the scorer.
 * Those are the runner's concerns; folding them in here would mean every
 * caller inherits a retry policy it did not choose, and a scorer that throws
 * would be indistinguishable from one that scored zero.
 *
 * @throws {InvalidScoreError} if the returned score is outside 0..1, is not
 * finite, or is attributed to the wrong scorer.
 */
export async function invokeScorer(scorer: Scorer, args: ScoreArgs): Promise<Score> {
  const score = await scorer.score(args);

  const problems: string[] = [];

  /* WHY NaN GETS ITS OWN CHECK
     --------------------------
     `Number.isFinite` rather than a bare range test, because NaN passes no
     comparison at all: `NaN >= 0 && NaN <= 1` is false, but so is
     `NaN < 0 || NaN > 1`, so a naive range guard written the other way round
     lets it straight through.

     NaN is not hypothetical here. A cosine similarity over an empty embedding
     vector is 0/0. A ratio scorer whose denominator is the number of expected
     fields is 0/0 when a case expects none. Both produce NaN from perfectly
     reasonable-looking arithmetic.

     And NaN is uniquely destructive downstream: it poisons every mean it
     touches, so one bad case turns a whole suite aggregate into NaN, which
     then serialises into the baseline as `null` and quietly disables the gate
     for that row. Failing loudly at the source is the entire difference
     between a five-minute fix and a baseline nobody trusts.

     Infinity is caught by the same check, for the same reason. */
  if (typeof score.value !== 'number' || !Number.isFinite(score.value)) {
    problems.push(`value must be a finite number, got ${describe(score.value)}`);
  } else if (score.value < 0 || score.value > 1) {
    problems.push(`value must be within 0..1, got ${score.value}`);
  }

  /* Catches a copy-pasted scorer that kept the original's name string. Left
     unchecked, its results would be filed under the wrong baseline column —
     silently, and in a way that looks like the other scorer regressed. */
  if (score.scorer !== scorer.name) {
    problems.push(`scorer field is "${score.scorer}" but the scorer is named "${scorer.name}"`);
  }

  /* `passed` is not validated: TypeScript already guarantees it is a boolean
     for any scorer compiled against this package, and the checks above are
     specifically the ones the type system cannot make — a NaN and an
     out-of-range number are both perfectly good `number`s. */

  if (problems.length > 0) throw new InvalidScoreError(scorer.name, problems);

  return score;
}

function describe(value: unknown): string {
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
  return `${typeof value} (${String(value)})`;
}
