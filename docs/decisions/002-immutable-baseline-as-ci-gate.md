# 002 — An immutable baseline as a CI gate, and what it may not contain

**Status:** accepted (baseline file not yet implemented)

## Context

Eval results usually live in a dashboard. Dashboards are read when someone
remembers to look, which in practice means after an incident. A regression that
lands on a Tuesday is discovered on the following Thursday, by which point four
other things have changed and nobody can attribute it.

Static analysis solved this problem years ago with a baseline file: a committed
record of known findings, checked in CI, where anything new fails the build and
anything fixed requires committing an updated baseline. The mechanism works
because it is in the pull request rather than in a tool someone has to open.

## Decision

Runs are recorded to a committed baseline file, keyed by `EvalCase.id`.
Subsequent runs are compared against it and a regression beyond tolerance fails
the build. Improving a score requires committing a new baseline, so the change
appears in the diff and gets reviewed.

**The baseline records, per case:** the mean `value`, `stdDev`, the sample count
`n`, per-scorer values, and the model identities the run used.

**The baseline must NOT contain:** `SubjectOutput.raw`, individual
`sampleValues`, full model responses, or judge transcripts. Those live in
memory during the run and in `.artifacts/` afterwards.

## Consequences

- Regressions surface in the pull request that caused them, attributable to one
  diff. This is the entire point.
- The baseline file must stay reviewable. A diff a human skims is a control; a
  diff a human scrolls past is a rubber stamp, and a rubber stamp is worse than
  no gate because it looks like one. This is why raw outputs and per-sample
  values are excluded — five numbers per case per run would bury the two that
  matter.
- Because a fixed tolerance is a guess about noise, the baseline carries
  `stdDev` and `n` so the gate can derive a tolerance per case instead.
- The baseline is only as good as its comparability. If the embedding or judge
  model changes, the numbers are not comparable at all — see ADR 005, and the
  `models.lock.json` mechanism that enforces it.
- Recording a baseline requires the response cache to be off. A baseline built
  from replayed responses records the cache's contents, not the model's
  behaviour, and would stay green across a model upgrade.

## Alternatives rejected

**Hosted dashboard (Braintrust, Langfuse).** Better at exploration, tracing,
and team review. Rejected as the primary mechanism because it does not block a
merge, and an eval nobody is forced to look at is an eval nobody looks at. The
two are complementary; this project only builds the gate.

**Threshold-only gating ("fail if any case scores below 0.8").** Rejected
because it cannot distinguish a case that was always at 0.75 from one that fell
there yesterday. Absolute thresholds catch bad cases; a baseline catches
changes, and changes are what a CI gate is for.

**Storing everything in the baseline for completeness.** Rejected: see the
reviewability point above. Completeness belongs in the artifacts directory,
where nobody has to read it to approve a merge.
