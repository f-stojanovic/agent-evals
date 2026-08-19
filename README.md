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

This is an early-stage portfolio project. The foundation — domain types and the
case loader — is in place; scorers, the runner, and the baseline gate are not
yet implemented.
