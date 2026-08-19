# 002. The baseline is immutable and enforced as a CI gate

Date: 2026-08-19
Status: Accepted

## Context

Eval results usually live in a dashboard. A dashboard is read when someone
remembers to open it, which in practice means after an incident. A regression
that lands on a Tuesday is found the following Thursday, by which point four
other things have changed and nobody can attribute it to a diff.

Static analysis solved this a decade ago. PHPStan and Psalm freeze the current
set of findings into a committed baseline file. New findings fail the build.
Fixed findings require regenerating the baseline, so the improvement lands in the
diff where a reviewer sees it. The mechanism works not because the analysis is
good but because the artefact is in the pull request instead of in a tool.

Eval scores have the same shape as static analysis findings: per-item, stable
keys, monotonic expectations.

<!-- FILIP: add the concrete experience here — what you saw, where, what it cost -->

## Decision

We record each run to a committed baseline file keyed by `EvalCase.id`, and we
compare every subsequent run against it. A score that regresses beyond tolerance
fails the build. Raising a score requires committing the new baseline in the same
pull request as the change that raised it.

The mechanic is deliberately identical to a static analysis baseline: freeze the
current state, permit improvement, block regression, and make every edit to the
frozen file visible in a diff.

## Consequences

A regression surfaces in the pull request that caused it, attributable to one
diff by one author. That is the whole point.

Because `EvalCase.id` is the join key, ids become permanent. Renaming one reads as
"the old case vanished, a new one appeared", which orphans its history and lets a
genuine regression through unnoticed. This constraint is documented on the type
and is now load-bearing.

The cost is friction on every legitimate improvement. A prompt change that helps
nine cases fails CI until the author regenerates the baseline and commits a diff
full of numbers. That is a real tax on every change, paid in every pull request,
and it is the price of the guarantee. It also creates a standing temptation to
regenerate the baseline without reading it — which is why ADR 003 constrains what
the file may contain.

The gate is only as trustworthy as the comparability of the numbers in it, which
forces ADR 007 (no cache when recording) and ADR 009 (locked model revisions).

## Alternatives rejected

**A hosted dashboard (Braintrust, Langfuse).** Better at tracing, exploration,
and team review, and this project does not try to compete there. Rejected as the
primary mechanism because it cannot block a merge. An eval nobody is forced to
look at is an eval nobody looks at.

**A report run manually before release.** Same failure with an extra step: it
depends on a human remembering, and the human who most needs to remember is the
one shipping under time pressure.

**A fixed absolute threshold ("fail if any case scores below 0.8").** Cannot
distinguish a case that has always scored 0.75 from one that fell there
yesterday. Absolute thresholds catch bad cases; a baseline catches changes, and
changes are what a CI gate is for.
