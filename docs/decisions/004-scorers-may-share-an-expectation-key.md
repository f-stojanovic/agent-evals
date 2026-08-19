# 004. Scorers may share an expectation key

Date: 2026-08-19
Status: Accepted. Supersedes the earlier one-owner-per-key rule, which was wrong.

## Context

`EvalCase.expect` is an open record and each scorer declares the keys it reads.
An earlier version of `validateExpectations` rejected two scorers claiming the
same key. The rule shipped with a written justification:

> ownership must be unambiguous, since otherwise which scorer reads it depends on
> registration order

That justification was false. Nothing in this harness dispatches by key. The
runner does not look at `expect.fields` and select a scorer for it; it runs every
applicable scorer against the case, and each one writes its own `Score` under its
own name into its own baseline column. Two scorers reading `expect.fields` is not
a conflict — they both read it, both produce a result, and both results are
recorded separately. There was no ambiguity to prevent.

The rule came from static analysis, where a rule genuinely does own its error
identifier: exactly one rule emits `no-unused-vars`, and two rules sharing that
name is a real collision. ADR 002 borrows the baseline mechanism from that world
correctly. This rule was borrowed along with it and did not survive the change of
dispatch model.

<!-- FILIP: add the concrete experience here — what you saw, where, what it cost -->

It also blocked the use case it was supposed to enable. The `name` override on the
scorer factories exists so a suite can register `exactFields` twice — strict on
one configuration, whitespace-tolerant on another — and both instances
necessarily claim `fields`. The rule rejected them however they were named.

It was caught by writing the test for that use case. The test asserted the
registration would succeed; it failed; the failure was correct and the rule was
not. The written rationale had made the rule look reasoned rather than assumed,
which is why it survived one review round.

## Decision

We allow any number of scorers to claim the same expectation key. The
duplicate-claimed-key check is deleted.

We keep the duplicate scorer **name** check. A name is a baseline column, and two
scorers sharing one silently merge two different measurements into a single
history — which is the failure the ownership rule was gesturing at and never
actually caught.

## Consequences

Two configurations of one scorer can measure the same expectation and be recorded
as two columns. `exact-fields` and `exact-fields-lenient` over the same
`expect.fields` is now the supported way to ask how much of a failure is
whitespace.

The cost is one guard fewer. Registering the same scorer twice by accident is now
caught only by the name check, and only if the names actually collide — two
instances given different names but identical configuration will both run, both
cost money, and both write near-identical columns, and nothing will complain. We
judged that cheaper than blocking a real use case to prevent a mistake that was
never being prevented anyway.

## Alternatives rejected

**Keep the rule and drop the `name` override.** Rejected: the override solves a
real problem and the rule defends against a mechanism that does not exist.

**Narrow the rule to "same factory, identical configuration".** This would catch
accidental double registration precisely. Rejected because `Scorer` carries no
factory identity, and adding one to the public contract for a check the name rule
already mostly covers is not worth the change.

**Keep the rule and document the limitation.** Rejected. A wrong rule with a
comment explaining that it is wrong is still a wrong rule, and the comment makes
it harder to delete later because it reads as considered.
