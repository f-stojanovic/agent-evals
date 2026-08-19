# 003 — Scorers may share an expectation key

**Status:** accepted — reverses an earlier decision in this repo

## Context

`EvalCase.expect` is an open record and each scorer declares the keys it reads.
An earlier version of `validateExpectations` rejected two scorers claiming the
same key, on the stated grounds that ownership must be unambiguous, "since
otherwise which scorer reads it depends on registration order".

That justification was false, and it took writing a test to notice.

**Nothing dispatches by key.** The runner does not look at a key and choose a
scorer for it. It runs *every* applicable scorer against the case, and each
writes its own `Score` under its own name into its own baseline column. Two
scorers reading `expect.fields` is not a conflict — they both read it, both
produce a result, and both results are recorded separately.

The rule came from an intuition imported from static analysis, where a rule
really does own its identifier: exactly one rule emits `no-unused-vars`, and
two rules sharing that name would be a genuine collision. The relationship here
is many-to-many by design, and the analogy did not survive contact with it.

The rule also blocked a real use case it was supposed to permit. The `name`
override on the scorer factories exists so a suite can register `exactFields`
twice — strict on one configuration, whitespace-tolerant on another — and both
instances necessarily claim `fields`. The ownership rule rejected them however
they were named, which made the override useful only for scorers reading
different keys, which is not the case it was added for.

## Decision

Remove the duplicate-claimed-key check. Any number of scorers may claim the
same expectation key.

Keep the duplicate scorer **name** check. A name is a baseline column, and two
scorers sharing one would silently merge two different measurements into a
single history — which is the failure the ownership rule was reaching for and
never actually caught.

## Consequences

- Two configurations of one scorer can measure the same expectation and be
  recorded as two columns. `exact-fields` and `exact-fields-lenient` against
  the same `expect.fields` is now the supported way to ask "how much of this
  failure is whitespace?"
- One guard fewer. A genuine mistake — registering the same scorer twice by
  accident — is still caught, but by the name check rather than by this one.
- The two remaining wiring guards (unclaimed key, fully-skipped case) are
  unaffected: both operate on the union of claims, and a union does not care
  how many scorers contributed a key.

## Alternatives rejected

**Keep the rule and drop the `name` override.** Rejected: the override solves a
real problem and the rule was defending against a mechanism that does not
exist.

**Narrow the rule to "same factory, identical configuration".** This would
catch accidental double registration precisely. Rejected for now because
`Scorer` carries no factory identity and adding one for a check the name rule
already covers is not worth the contract change.

## Lesson

The specific error is worth naming: a mechanism was borrowed from a familiar
tool (static analysis baselines) along with a rule that only made sense given
that tool's dispatch model. Borrowing the mechanism was right — ADR 002 is
built on it. Borrowing the rule with it was not, and the rationale written down
at the time made the mistake look reasoned rather than assumed.
