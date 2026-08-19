# 001 — `Score.value` is continuous, not boolean

**Status:** accepted

## Context

Every score in the suite has to answer "how good was this response". The
obvious encoding is a boolean: the case passed or it did not, which is what a
test runner records and what most people expect from a suite of checks.

The subject, though, is not deterministic and its failures are not binary. An
extraction that gets four of five fields right is not the same event as one
that gets none. A prompt change that moves ten cases from hopeless to
nearly-right is real progress. A boolean cannot express either.

## Decision

`Score.value` is a number in [0, 1], and scorers must use the range rather than
emitting only 0.0 and 1.0 when a graded answer is available. `Score.passed` is
derived — `value >= threshold` — and is a reporting convenience, never the
source of truth. Persisting `passed` without `value` is forbidden.

Scorers award partial credit wherever partial credit is meaningful:
`exactFields` scores the fraction of expected fields that matched, `callsTool`
the fraction of expected calls that were made.

## Consequences

- The suite mean moves when quality moves, so a change that helps without
  crossing any threshold is still visible. This is the main benefit.
- Thresholds become a reporting decision rather than a measurement one. Because
  the continuous value is stored, "what would the gate have said at 0.7?" can
  be re-asked against historical runs. A stored boolean bakes the threshold in
  and makes the question unanswerable forever.
- NaN becomes a real hazard — a ratio scorer with an empty denominator produces
  0/0, and NaN poisons every mean it reaches. `invokeScorer` rejects
  non-finite values at the boundary for this reason.
- Reading a single number is harder than reading pass/fail. The reports carry
  `reason` on every score to compensate.

## Alternatives rejected

**Boolean pass/fail.** Rejected because "18/20 passing" is identical before and
after a change that improved every failing case, which is precisely the change
a suite exists to detect.

**Discrete grades (A–F, or 0/0.5/1).** Rejected as a boolean with more
buckets. The bucket edges are arbitrary and inherit the same problem in
smaller form: movement within a bucket is invisible.

**Continuous value plus a stored `passed` as ground truth.** Rejected because
two sources of truth diverge the moment a threshold changes, and the stored
boolean is the one that would be wrong.

## Exception

`matchesSchema` is binary, and deliberately so — a document either satisfies a
schema or it does not. Counting satisfied subschemas would produce a number
that moves when the schema is refactored without changing meaning, and a
number that moves for reasons unrelated to quality is worse than no number.
The exception is documented at the scorer, not hidden.
