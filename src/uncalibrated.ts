/**
 * Counting the numbers nobody measured.
 *
 * An eval harness is full of constants that look like findings but are
 * guesses: a pass threshold of 0.8, a judge-disagreement cutoff of 0.25, a
 * default of three self-consistency samples. Each is defensible in isolation
 * and none is derived from data. Stacked together they produce a score that
 * reads as authoritative and is not.
 *
 * The honest response is not to remove them — a harness needs defaults — but
 * to refuse to let them disappear. Every such constant is declared through
 * {@link uncalibrated}, which returns the value unchanged and records it. The
 * report can then end with "this run used 7 uncalibrated constants" and list
 * them, so the assumptions are counted rather than absorbed.
 *
 * The rule for using it: if you cannot say which measurement produced a
 * number, it goes through here. A value derived from a calibration run does
 * not — that is the whole point of calibrating it.
 */

export type UncalibratedConstant = {
  /** Stable identifier, unique per constant. Also the dedup key. */
  readonly id: string;
  readonly value: number;
  /** What the number does, and what would have to be measured to justify it. */
  readonly note: string;
};

/* Module-level and deliberately global for the process. Constants are declared
   at import time and inside factories, so a per-instance registry would report
   a different count depending on which scorers happened to be constructed. */
const registry = new Map<string, UncalibratedConstant>();

/**
 * Records a constant that is not derived from data and returns it unchanged,
 * so it can wrap a value in place:
 *
 *     const threshold = uncalibrated(0.8, 'semantic-threshold', '...');
 *
 * Re-declaring the same id is a no-op rather than a duplicate: a factory
 * called five times declares the same assumption five times, and reporting it
 * five times would overstate how many there are. The first note wins; a
 * conflicting value for an existing id throws, because two different numbers
 * under one id means the report would be lying about at least one of them.
 */
export function uncalibrated(value: number, id: string, note: string): number {
  const existing = registry.get(id);
  if (existing === undefined) {
    registry.set(id, { id, value, note });
    return value;
  }
  if (existing.value !== value) {
    throw new Error(
      `uncalibrated constant "${id}" was declared as ${existing.value} and again as ` +
        `${value}. Use a distinct id per constant, or the report cannot describe ` +
        `either honestly.`,
    );
  }
  return value;
}

/** Every constant declared so far, sorted by id for a stable report. */
export function uncalibratedConstants(): readonly UncalibratedConstant[] {
  return [...registry.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Renders the report footer. Kept here so the wording stays with the idea. */
export function formatUncalibratedReport(): string {
  const constants = uncalibratedConstants();
  if (constants.length === 0) return 'This run used no uncalibrated constants.';

  const lines = constants.map((c) => `  ${c.id} = ${c.value} — ${c.note}`);
  return (
    `This run used ${constants.length} uncalibrated constant` +
    `${constants.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
  );
}

/** Test-only: clears the registry. Exported rather than hidden because the
 *  alternative is per-test module resetting, which is worse. */
export function resetUncalibratedRegistry(): void {
  registry.clear();
}
