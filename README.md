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
22M-parameter encoder runs in milliseconds on CPU. The judge needs an API; this
does not, and paying for it anyway would spend both money and reliability for
nothing.

The model id, revision, and quantisation are pinned in a committed
`models.lock.json`, written on the first run and checked on every later one. A
mismatch fails the run. It has to — a cosine similarity is only comparable to
another from the same encoder, so an unnoticed model upgrade shifts every score
in the suite at once, which is indistinguishable from the subject getting
worse. The lockfile turns that into a reviewable diff. See
[ADR 009](docs/decisions/009-model-revisions-are-locked.md).

The scorer emits **raw cosine similarity**, not a rescaled score. Real
sentence-embedding similarities do cluster in a narrow band, which makes raw
values awkward to read — but the earlier fix, mapping an invented [0.3, 0.95]
band onto [0, 1], stacked two guesses on top of a third and produced a number
that looked calibrated and matched no published figure. The answer to an
awkward range is to calibrate a threshold against labelled data, not to squash
the axis until the numbers look friendly.

## Judging the judge

`llmJudge` grades a case against a prose rubric by asking a different model —
the only scorer that can assess "is this a good answer to an ambiguous
question". It is also the only scorer that is itself a probabilistic system
with unknown accuracy, and adopting one without measuring it does not remove
the unmeasured part of your pipeline. It moves it one level down and attaches a
number to it, which is worse, because now there is a figure in the baseline
that looks like a measurement.

So `evals/calibration/` holds cases with human-assigned scores, spanning the
range from clearly-right through genuinely-borderline to clearly-wrong, each
paired with a frozen model output. `npm run calibrate` runs the judge against
those same outputs and reports how far it lands from the human labels:

```
  case                        human  judge  error  spread
  --------------------------  -----  -----  -----  ------
  cal-clear-correct-01         1.00   0.95  -0.05    0.05
  cal-hallucinated-name-01     0.50   0.85  +0.35    0.10
  ...
  mean absolute error : 0.121
  mean signed error   : +0.086
```

The two error figures answer different questions. A judge that is uniformly too
generous is miscalibrated and fixable by moving a threshold; one that is off in
both directions is noisy and is not. A judge with an MAE of 0.08 is a usable
instrument; one at 0.35 is a random number generator with good manners, and no
amount of prompt engineering elsewhere fixes that. You cannot know which you
have without running it.

Three further details matter enough to state:

- **The judge returns structured output through a forced tool call**, never
  prose to be parsed. A grade regexed out of a paragraph is a parser bug
  waiting to become a silent scoring bug.
- **The rubric goes in the system prompt; the output under evaluation goes in a
  delimited user turn.** This is a security boundary. In a real suite the output
  derives from customer emails and scraped pages, and interpolating it into the
  system prompt puts attacker-influenced text in the position of highest
  authority — a path from your own test data to a green build.
- **The judge runs k times and the median is taken**, with the spread recorded.
  Median rather than mean because one wild verdict should not move the score by
  a quarter of the range. And the spread is kept because a judge that disagrees
  with itself is reporting that the case is genuinely ambiguous — that is a
  finding, not noise to be averaged away.

## Counting the assumptions

A harness like this fills up with numbers that look like findings and are
guesses: a pass threshold, a disagreement cutoff, a sample count. Each is
defensible alone; stacked, they produce a score that reads as authoritative and
is not.

Every such constant is declared through `uncalibrated(value, id, note)`, which
returns it unchanged and registers it. Reports end with a count and a list. The
assumptions do not go away — a harness needs defaults — but they are counted
rather than absorbed.

The same instinct removed things in the last revision: the semantic scorer used
to rescale raw cosine similarity from an invented [0.3, 0.95] band onto [0, 1],
and `formatCompliance` used to award 0.5 for a markdown fence. Both numbers
were made up, and both made the output look calibrated. They are gone; the
semantic scorer emits raw cosine, and format compliance is graded against a
format the case author declares.

## Status

- [x] Domain types — the stable contract (`src/types.ts`), including per-case
      sampling (`samples`, `stdDev`, `sampleValues`)
- [x] YAML case loader with actionable errors and stable ordering
- [x] Both wiring guards: unclaimed keys, and cases nothing measures
- [x] Score contract enforcement (`invokeScorer`)
- [x] Structured-output extraction, once per case, with the route recorded
- [x] Deterministic scorers: `exactFields`, `matchesSchema`, `callsTool`
- [x] `formatCompliance` — format discipline, graded against a declared format
- [x] Semantic scorer — local embeddings, raw cosine, lockfile-pinned model
- [x] LLM judge — forced tool call, self-consistency, injection-safe prompt
- [x] Judge calibration against human labels (`npm run calibrate`)
- [x] `models.lock.json` — model changes are explicit and reviewable
- [x] Uncalibrated-constant tracking
- [ ] Runner — concurrency, retries, timeouts, sampling, cost accounting
- [ ] Baseline file format and the CI gate
- [ ] Reporters (terminal, JSON, GitHub annotations)

Design decisions and their reasoning — including one that was wrong and was
reversed — are recorded in [`docs/decisions/`](docs/decisions/).

## Development

```bash
npm install
npm run typecheck
npm test                     # unit tests only; no network, no model download
RUN_MODEL_TESTS=1 npm test   # adds the real-embedding integration test
npm run calibrate            # measures the judge; needs ANTHROPIC_API_KEY in .env
```

Judge calls read the API key from the project `.env` (see `.env.example`),
explicitly and by path — never from the ambient environment. A run should not
be able to silently bill a key nobody meant to use.

### A note on dependencies

`@huggingface/transformers` pulls two transitively vulnerable packages
(`adm-zip`, `sharp`), both with no fix currently available upstream. Neither is
on a path this project exercises — it embeds text, never decodes images, and
unpacks only the ONNX runtime — but they will appear in any `npm audit`.
