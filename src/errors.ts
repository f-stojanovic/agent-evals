/**
 * Errors that report a batch of problems rather than the first one.
 *
 * Both places that validate human-authored input — the YAML loader and the
 * expectation-key check — are used the same way: a person edits a pile of
 * files, then runs the suite. Fail-fast turns twelve mistakes into twelve
 * edit-run cycles. Every problem found in one pass is the whole point, so the
 * behaviour lives in a base class instead of being reimplemented per site.
 */

/**
 * Abstract because it is never the right thing to throw directly: callers
 * catch `CaseLoadError` or `ExpectationError` to tell a malformed file from a
 * misrouted expectation, and a bare instance of this would defeat that.
 */
export abstract class ProblemListError extends Error {
  /** Every problem found, one per entry, in discovery order. Exposed
   *  separately from `message` so a reporter can render them structurally
   *  instead of parsing the joined string back apart. */
  readonly problems: readonly string[];

  protected constructor(headline: string, problems: readonly string[]) {
    super(formatProblems(headline, problems));
    this.problems = problems;
  }
}

function formatProblems(headline: string, problems: readonly string[]): string {
  if (problems.length === 1) return `${headline}: ${problems[0]}`;
  return (
    `${headline} (${problems.length} problems):\n` + problems.map((p) => `  - ${p}`).join('\n')
  );
}
