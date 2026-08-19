/**
 * Reporting the numbers nobody measured.
 *
 * A harness like this fills up with constants that look like findings and are
 * guesses: a pass threshold, a disagreement cutoff, a sample count. Each is
 * defensible alone; stacked, they produce a score that reads as authoritative
 * and is not. The honest response is not to remove them — a harness needs
 * defaults — but to refuse to let them disappear, so a report can end with
 * "this run used 4 uncalibrated constants" and list them.
 *
 * WHY THIS IS NOT A REGISTRY
 * --------------------------
 * The first version of this file kept a module-level `Map` that constants
 * registered themselves into at import time, plus a `resetUncalibratedRegistry`
 * export so tests could clear it between cases. That reset export was the
 * design telling on itself: state that has to be cleared to be tested is state
 * that lives in the wrong place. It also meant the count depended on which
 * modules had been imported rather than on which scorers were actually
 * registered, so merely importing the judge added its guesses to a run that
 * never used it.
 *
 * Constants now belong to the scorer that guesses them, declared on
 * {@link Scorer.uncalibrated}, and the runner collects them from the scorers it
 * was handed. No global state, no reset, and the count describes the run.
 */

import type { Scorer, UncalibratedConstant } from './types.js';

/** Every constant declared by the given scorers, sorted for a stable report. */
export function collectUncalibrated(
  scorers: readonly Scorer[],
): readonly UncalibratedConstant[] {
  return scorers
    .flatMap((scorer) => scorer.uncalibrated ?? [])
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Renders the report footer. Kept here so the wording stays with the idea. */
export function formatUncalibratedReport(
  constants: readonly UncalibratedConstant[],
): string {
  if (constants.length === 0) return 'This run used no uncalibrated constants.';

  const lines = constants.map((c) => `  ${c.id} = ${c.value} — ${c.note}`);
  return (
    `This run used ${constants.length} uncalibrated constant` +
    `${constants.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
  );
}
