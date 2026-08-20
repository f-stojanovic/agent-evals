# 001. Scores are continuous, not boolean

Date: 2026-08-19
Status: Accepted
Evidence: Supported by the first live run, 2026-08-19. Every one of the three
          cases scored 0.75 or below on `exact-fields` and would have been a
          single red "FAIL" under a boolean. The continuous value showed
          instead that all three lose exactly ONE field of four, and the same
          field in every case — which is a specific, actionable finding a
          boolean would have flattened into "the suite is broken".
          Still unobserved: a change that improves cases without crossing a
          threshold, which is the strongest form of the argument.

## Context

A unit test asserts. An eval grades. The subject is a stochastic system whose
failures come in degrees: an extraction that gets four of five fields right is
not the same event as one that gets none, and a prompt change that moves ten
cases from hopeless to nearly-right is real progress that no assertion can
express.

The tension is that everything downstream wants a boolean. CI needs to decide
whether to fail the build. Reports want a green tick. The pressure is to record
the boolean and throw away the number that produced it.

## Decision

We record `Score.value` as a number in [0, 1]. Scorers use the range: `exactFields`
scores the fraction of expected fields that matched, `callsTool` the fraction of
expected calls made.

`Score.passed` is derived from a threshold and is a reporting convenience. We never
persist `passed` without `value`.

`matchesSchema` is the exception and returns 0 or 1, because a document either
satisfies a schema or it does not. Counting satisfied subschemas would produce a
number that moves when the schema is refactored without its meaning changing.

## Consequences

The suite mean moves when quality moves, so improvement that crosses no threshold
is still visible.

Thresholds become a reporting decision rather than a measurement one. Because the
continuous value is stored, "what would the gate have said at 0.7?" can be asked
of runs already recorded. A stored boolean bakes the threshold in permanently.

The cost is NaN. A ratio scorer with an empty denominator produces 0/0, which
passes every naive range guard and poisons every mean it reaches, ending up in a
baseline as `null`. `invokeScorer` exists mostly to reject non-finite values at
the boundary, and `exactFields` has to special-case an empty expectation map
rather than divide. Booleans have no such failure mode.

Reading one number is also harder than reading pass/fail, which is why every score
carries a `reason`.

## Alternatives rejected

**Pass/fail booleans.** "18 of 20 passing" is identical before and after a change
that improved every failing case. That change is exactly what a suite exists to
detect, and a boolean cannot detect it.

**A fixed set of grade buckets (A–F, or 0/0.5/1).** A boolean with more edges.
The bucket boundaries are arbitrary, and movement inside a bucket is invisible —
the same blindness, at finer grain, with the added cost of pretending the
boundaries mean something.
