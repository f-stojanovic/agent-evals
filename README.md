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
silence is ambiguous, and it fails in two directions. Both are hard errors,
checked before the first API call.

**Guard one — a key nobody reads.** Write `field:` where you meant `fields:`
and the file is valid YAML, satisfies the case schema, and loads without
complaint. Then it is read by nobody: the expectation exists and is enforced by
nothing. So every scorer declares the keys it consumes, and any key in any case
that no scorer claims fails the run. The error groups by key rather than by case
— one mistake copy-pasted across fifty cases is one problem — and suggests the
intended spelling:

```
unclaimed key "field" in 8 cases (no scorer claims it; did you mean "fields"?):
case-0, case-1, case-2, case-3, case-4, ... (+3 more)
```

**Guard two — a case nobody measures.** Every scorer skips it, correctly and
individually: no `fields`, no `schema`, no `toolCalls`. Each skip is a
reasonable local decision. Together they mean the case runs, costs money, and
produces a result with no checks in it. So each claim carries a `required` flag,
which is what lets the runner tell "this check does not apply here" from "this
case is misconfigured" — and a case that every scorer skips fails the run,
naming which scorer was missing which key.

Annotations that are not expectations (`owner`, `ticket`) go in `meta`. A `meta`
key that collides with a claimed key is also an error, with no opt-out switch:
`meta.fields` is never a decision, only an expectation that was quietly moved
out of enforcement. A control nobody enables is not a control.

Both guards exist because a green suite that measures less than it did yesterday
is worse than a red one. A red suite gets investigated; a green one sells
confidence nobody earned.

The same principle runs through the rest: `invokeScorer` rejects a NaN score
rather than letting it reach a baseline as `null`, and a model returning prose
where JSON was expected scores 0.0 with a reason instead of throwing — a bad
response is a measurement, not a crash.

## Embeddings run locally

The semantic scorer runs a sentence encoder on your machine via
`@huggingface/transformers` — no API key, and no network after the first model
download. A suite that needs a third-party key to pass CI fails for reasons that
have nothing to do with the thing under test: an expired key, a rate limit, a
provider incident, a fork without secrets. Every one of those is a red build
that is not a regression, and a gate that cries wolf gets switched off — which
costs you the gate entirely.

Embeddings are also where a local model is genuinely good enough: a
22M-parameter encoder runs in milliseconds on CPU. The judge scorer will need an
API; this does not, and paying for it anyway would spend both money and
reliability for nothing.

The model id, git revision, and quantisation are pinned in code and recorded on
every score. They have to be — a cosine similarity is only comparable to another
from the same encoder, so an unnoticed model upgrade shifts every score in the
suite at once, which is indistinguishable from the model under test getting
worse.

## Status

- [x] Domain types — the stable contract (`src/types.ts`), including per-case
      sampling (`samples`, `stdDev`) so baseline tolerances can be derived from
      measured variance rather than guessed
- [x] YAML case loader with actionable errors and stable ordering
- [x] Both wiring guards: unclaimed keys, and cases nothing measures
- [x] Score contract enforcement (`invokeScorer`)
- [x] Structured-output extraction, with the route recorded (`via`)
- [x] Deterministic scorers: `exactFields`, `matchesSchema`, `callsTool`
- [x] `formatCompliance` — output-format discipline, scored separately from
      extraction accuracy so neither hides the other
- [x] Semantic scorer — local embeddings, pinned model, calibratable rescale
- [ ] LLM-judge scorer
- [ ] Runner — concurrency, retries, timeouts, sampling, cost accounting
- [ ] Baseline file format and the CI gate
- [ ] Reporters (terminal, JSON, GitHub annotations)

## Development

```bash
npm install
npm run typecheck
npm test                     # unit tests only; no model download
RUN_MODEL_TESTS=1 npm test   # adds the one real-embedding integration test
```
