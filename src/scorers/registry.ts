/**
 * Wiring checks between the cases and the scorers that will run against them.
 *
 * This runs before the first API call. Everything it catches is a mistake that
 * would otherwise surface as a *passing* run — which is why it is a hard error
 * rather than a warning.
 */

import { ProblemListError } from '../errors.js';
import type { EvalCase, Scorer } from '../types.js';

/** Scorers and cases disagree about who owns which expectation key. */
export class ExpectationError extends ProblemListError {
  override readonly name = 'ExpectationError';

  constructor(problems: readonly string[]) {
    super('Invalid expectation wiring', problems);
  }
}

/**
 * Asserts that every expectation key in every case is claimed by exactly one
 * registered scorer.
 *
 * THE FAILURE MODE THIS EXISTS TO PREVENT
 * ---------------------------------------
 * `EvalCase.expect` is an open record, because each scorer owns its own keys
 * and a closed type would couple the case contract to its consumers. The cost
 * of that openness is that a typo is invisible:
 *
 *     expect:
 *       field:            # meant `fields:`
 *         intent: refund
 *
 * The file is valid YAML, satisfies the case schema, and loads without
 * complaint. `exactFields` looks for `fields`, does not find it, and has
 * nothing to score. The case runs, costs money, and contributes a perfect
 * score for having checked nothing. The suite is green and measures less than
 * it did yesterday, with no signal anywhere that this happened.
 *
 * That is strictly worse than a red suite: a red suite is investigated, and a
 * green one buys confidence that was never earned. So an unclaimed key fails
 * the run, and the error prints the claimed keys next to the unclaimed one —
 * the correct spelling is almost always sitting right there in the list.
 *
 * Annotations that are genuinely not expectations belong in
 * {@link EvalCase.meta}, which is outside `expect` entirely and is never
 * checked here.
 *
 * @throws {ExpectationError} listing every problem found, in one pass.
 */
export function validateExpectations(
  cases: readonly EvalCase[],
  scorers: readonly Scorer[],
): void {
  const problems: string[] = [];

  /* Scorer-side problems first: if the registry itself is inconsistent, the
     case-side report below is built on a claim set that cannot be trusted, and
     leading with fifty downstream symptoms would bury the cause. */
  const seenNames = new Set<string>();
  const owners = new Map<string, string>();

  for (const scorer of scorers) {
    if (seenNames.has(scorer.name)) {
      problems.push(
        `duplicate scorer name "${scorer.name}": names become baseline columns, ` +
          `so two scorers sharing one would overwrite each other's history`,
      );
      continue;
    }
    seenNames.add(scorer.name);

    for (const key of scorer.claims) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        problems.push(
          `expectation key "${key}" is claimed by both "${owner}" and "${scorer.name}": ` +
            `ownership must be unambiguous, since otherwise which scorer reads it ` +
            `depends on registration order`,
        );
        continue;
      }
      owners.set(key, scorer.name);
    }
  }

  const claimed = [...owners.keys()].sort();
  const claimedList =
    claimed.length > 0
      ? claimed.map((key) => `"${key}"`).join(', ')
      : '(none — no registered scorer claims any expectation key)';

  for (const evalCase of cases) {
    /* Sorted so the report does not depend on YAML key order. An empty
       `expect` is legal: a scorer may need no expectations at all. */
    for (const key of Object.keys(evalCase.expect).sort()) {
      if (owners.has(key)) continue;
      problems.push(
        `case "${evalCase.id}": expectation key "${key}" is not claimed by any scorer, ` +
          `so nothing would read it and the case would score as if it had no ` +
          `expectations. Claimed keys are: ${claimedList}. ` +
          `If this is an annotation rather than an expectation, move it to \`meta\``,
      );
    }
  }

  if (problems.length > 0) throw new ExpectationError(problems);
}
