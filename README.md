# agent-evals

An evaluation harness for LLM agents, written in TypeScript. You describe cases
in YAML — an input, the expectations, a stable id — point it at a subject (an
API call, an agent loop, anything that returns text and tool calls), and score
the results with deterministic checks or LLM judges. Scores are continuous
rather than pass/fail, so a change that moves a case from hopeless to
nearly-right is visible instead of invisible. Runs record token usage, cost, and
latency alongside quality, because in practice all three constrain what you can
ship.

## Why not promptfoo / Braintrust / Langfuse?

Those tools are good at what this one deliberately isn't: promptfoo at quick
local comparison matrices, Braintrust and Langfuse at hosted tracing,
dashboards, and team review workflows. If you want an observability platform,
use one of those.

The differentiator here is **an immutable baseline enforced as a CI gate**. A
run is recorded to a checked-in baseline file, keyed by case id. Subsequent runs
are compared against it, and a regression beyond the allowed tolerance fails the
build — the same mechanic as a PHPStan or Psalm baseline, applied to eval
scores. Improving a score requires committing the new baseline, which makes the
change reviewable in the diff; letting a score drop requires an explicit,
deliberate edit rather than a dashboard nobody opened this week. That is the
whole idea: evals that behave like static analysis instead of like a report.

## An eval that measures nothing must not report green

`EvalCase.expect` is an open record: each scorer owns its own keys, so adding a
scorer never means editing the case contract. The cost of that openness is that
a typo is invisible. Write `field:` where you meant `fields:` and the file is
valid YAML, satisfies the case schema, loads without complaint — and is then
read by nobody. The case runs, costs money, and contributes a perfect score for
having checked nothing.

That is worse than a failing suite. A red suite gets investigated; a green one
sells confidence that was never earned.

So every scorer declares the keys it consumes, and `validateExpectations` checks
the union of those claims against every key in every case before the first API
call. An unclaimed key fails the run and the error prints the claimed keys
beside it — the correct spelling is almost always right there in the list. Two
scorers claiming the same key fails too, rather than being resolved by
registration order. Annotations that are not expectations (`owner`, `ticket`)
go in `meta`, which no scorer claims and the check ignores.

The same principle drives the rest of the design: `invokeScorer` rejects a NaN
score rather than letting it propagate into a baseline as `null`, and a model
returning prose where JSON was expected scores 0.0 with a reason instead of
throwing — a bad response is a measurement, not a crash.

## Status

- [x] Domain types — the stable contract (`src/types.ts`)
- [x] YAML case loader with actionable errors and stable ordering
- [x] Expectation-key validation across cases and scorers
- [x] Score contract enforcement (`invokeScorer`)
- [x] Structured-output extraction (tool call → JSON → fenced JSON)
- [x] Deterministic scorers: `exactFields`, `matchesSchema`, `callsTool`
- [ ] Semantic scorer (embedding similarity)
- [ ] LLM-judge scorer
- [ ] Runner — concurrency, retries, timeouts, cost accounting
- [ ] Baseline file format and the CI gate
- [ ] Reporters (terminal, JSON, GitHub annotations)
