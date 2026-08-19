# agent-evals

[![ci](https://github.com/filipstojanovic/agent-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/filipstojanovic/agent-evals/actions/workflows/ci.yml)
[![eval-live](https://github.com/filipstojanovic/agent-evals/actions/workflows/eval-live.yml/badge.svg)](https://github.com/filipstojanovic/agent-evals/actions/workflows/eval-live.yml)

An evaluation harness for LLM agents, in TypeScript. You describe cases in YAML
— an input, the expectations, a stable id — point it at a subject (an API call,
an agent loop, anything returning text and tool calls), and score the results
with deterministic checks, local embeddings, or an LLM judge. Scores are
continuous, so a change that moves a case from hopeless to nearly-right is
visible instead of invisible. Runs record token usage, cost, and latency
alongside quality, because in practice all three constrain what you can ship.

The point of the project is the gate: results are frozen into a committed
baseline, every run is compared against it, and a regression fails the build.

## Why not promptfoo / Braintrust / Langfuse?

Those tools are good at what this one deliberately isn't: promptfoo at quick
local comparison matrices, Braintrust and Langfuse at hosted tracing,
dashboards, and team review workflows. If you want an observability platform,
use one of those.

The differentiator is **an immutable baseline enforced as a CI gate**. A run is
recorded to a checked-in file keyed by case id; later runs are compared against
it, and a regression beyond tolerance fails the build — the same mechanic as a
PHPStan or Psalm baseline, applied to eval scores. Improving a score means
committing the new baseline, so the change is reviewable in the diff. Letting
one drop requires a deliberate edit rather than a dashboard nobody opened this
week.

The tolerance is not a number somebody picked. Both sides of the comparison are
noisy estimates with a recorded spread and sample count, so the gate asks "is
this drop larger than the noise I already measured?" ([ADR 012](docs/decisions/012-tolerance-is-derived-from-measured-variance.md)).

## Quickstart

```bash
npm install
npm run eval:fixture                      # runs the whole pipeline offline
npm run eval:fixture -- --update-baseline # freeze the current numbers
```

Point it at your own subject:

```ts
import { loadCases, runSuite, validateExpectations, exactFields, llmJudge, CACHE_OFF } from 'agent-evals';

const cases = await loadCases('evals/cases');
const scorers = [exactFields(), llmJudge()];

validateExpectations(cases, scorers);   // fails now, not after you have paid

const run = await runSuite({
  cases,
  subject: myAgent,        // (input, ctx) => Promise<SubjectOutput>
  subjectId: 'my-agent@v3',
  scorers,
  samples: 3,
  cache: CACHE_OFF,        // required: no silent default-on (ADR 007)
});
```

A case is YAML:

```yaml
- id: refund-damaged-item-01     # stable forever; it is the baseline key
  input:
    subject: Order #48812 arrived broken
    body: |
      The ceramic mug was shattered inside the box. Please refund me.
  expect:
    fields:
      intent: refund_request
      urgency: medium
```

### What a run looks like

```
| case                            | exact-fields | llm-judge | mean  | sd    | Δ vs baseline   | cost | ms |
| ------------------------------- | ------------ | --------- | ----- | ----- | --------------- | ---- | -- |
|    cancellation-or-complaint-01 | 0.50         | 0.70      | 0.600 | 0.000 | +0.000 (±0.010) | —    | 1  |
| 🔴 outage-escalation-01         | 0.75         | —         | 0.750 | 0.014 | -0.250 (±0.031) | —    | 0  |
|    refund-damaged-item-01       | 1.00         | —         | 1.000 | 0.000 | +0.000 (±0.010) | —    | 0  |

## Totals

- cases: 3 · passed 2 · failed 1 · errored 0
- weighted score: **0.900**
- cost: **$0.0413** — subject $0.0090, judge $0.0323

### Output format distribution
- json: 9 (100%)

### Models
- judge: `claude-opus-5` @ unpinned (hosted)

### Assumptions
This run used 3 uncalibrated constants:
  llm-judge.samples = 3 — independent verdicts collected per output. …
```

## An eval that measures nothing must not report green

`EvalCase.expect` is an open record: each scorer owns its own keys, so adding a
scorer never means editing the case contract. The cost of that openness is that
silence is ambiguous, and it fails in two directions. Both are hard errors,
checked before the first API call ([ADR 005](docs/decisions/005-two-guards-against-a-suite-that-measures-nothing.md)).

**Guard one — a key nobody reads.** Write `field:` where you meant `fields:` and
the file is valid YAML, satisfies the schema, and loads without complaint. Then
nobody reads it. Any expectation key no scorer claims fails the run, grouped by
key with a suggestion:

```
unclaimed key "field" in 8 cases (no scorer claims it; did you mean "fields"?):
case-0, case-1, case-2, case-3, case-4, ... (+3 more)
```

**Guard two — a case nobody measures.** Every scorer skips it, correctly and
individually: no `fields`, no `schema`, no `toolCalls`. Each skip is a
reasonable local decision; together they mean the case runs, costs money, and
checks nothing. Each claim carries a `required` flag, and a case that every
scorer skips fails the run, naming which scorer was missing which key.

Annotations that are not expectations go in `meta` — and a `meta` key that
collides with a claimed one is also an error, with no opt-out switch. A control
nobody enables is not a control.

## Errored is not failed

A case the harness could not evaluate — no parseable payload, or several that
each parse and no principled way to choose — is marked **errored**, not scored
zero. Zero asserts the model was wrong, which was never established; we declined
to decide, and an invented measurement is worse than a refused one. Errored
cases are excluded from the baseline entirely and fail the run on their own
path.

The blast radius is narrow: only scorers that consume the extraction are
affected. One reading `output.text` directly still produces a score.

## Judging the judge

`llmJudge` grades a case against a prose rubric by asking a different model. It
is also the only scorer that is itself a probabilistic system with unknown
accuracy, and adopting one without measuring it does not remove the unmeasured
part of your pipeline — it moves it one level down and attaches a number to it.

So `evals/calibration/` holds cases with human-assigned scores spanning the
range, each paired with a frozen output. `npm run calibrate` reports mean
absolute and mean signed error against those labels. A judge at 0.08 MAE is a
usable instrument; one at 0.35 is a random number generator with good manners.

Three details that matter:

- **Structured verdicts through a forced tool call**, never prose to be parsed.
- **The rubric goes in the system prompt; the output goes in a delimited user
  turn.** A security boundary: in a real suite the output derives from customer
  emails and scraped pages, and putting that in the system prompt is a path from
  your own test data to a green build.
- **k verdicts, median taken, spread recorded.** `temperature` no longer exists
  on current Claude models, so judge variance cannot be suppressed — only
  measured. Which is why judged cases require at least three samples.

## Counting the assumptions

Every constant not derived from data is declared on the scorer that guesses it
and printed in the report footer with a count. The assumptions do not go away —
a harness needs defaults — but they are counted rather than absorbed.

The same instinct deleted things: a rescale with an invented floor and ceiling
stacked under an invented threshold, and a made-up 0.5 for a markdown fence.
Both produced numbers that looked calibrated. The semantic scorer now emits raw
cosine, and format compliance is graded against a format the case declares.

## CI: two workflows, honestly

Real model calls on every push would cost money per push, need a secret forks do
not have, and return a different answer each time. So there are two gates
([ADR 013](docs/decisions/013-ci-splits-fixture-from-live.md)):

| workflow | when | what it proves |
| --- | --- | --- |
| `ci.yml` | every push and PR | the **harness** works — typecheck, unit tests, and a full eval replaying recorded outputs. Deterministic, free, no secrets, works on forks. |
| `eval-live.yml` | manual + nightly | the **models** still behave — real API calls, cache disabled, report uploaded. |

**The per-push gate cannot catch a model regression.** It runs against
recordings. A model that got worse overnight passes it, and is caught by the
nightly run within a day. Saying otherwise would be the exact kind of
overstatement this project exists to prevent.

## Status

- [x] Domain types — the stable contract
- [x] YAML case loader with actionable errors and stable ordering
- [x] Both wiring guards: unclaimed keys, and cases nothing measures
- [x] Score contract enforcement — finite, 0..1, correctly attributed
- [x] Extraction with the route recorded; ambiguity refused rather than guessed
- [x] Scorers: `exactFields`, `matchesSchema`, `callsTool`, `formatCompliance`,
      `semanticSimilarity`, `llmJudge`
- [x] Judge calibration against human labels (`npm run calibrate`)
- [x] `models.lock.json` — model changes are explicit and reviewable
- [x] Runner — concurrency, sampling, retry with jitter, timeouts, disk cache,
      cost accounting
- [x] Baseline file and the CI gate, with a tolerance derived from variance
- [x] Report — markdown and a JSON artifact
- [x] CI: fixture gate on every push, live run nightly
- [ ] Live calibration figure — the machinery exists, the number does not yet
- [ ] Reporters beyond markdown/JSON (GitHub annotations)

Decisions and their reasoning — including one that was wrong and was reversed —
are in [`docs/decisions/`](docs/decisions/).

## Development

```bash
npm run typecheck
npm test                     # unit tests; no network, no model download
RUN_MODEL_TESTS=1 npm test   # adds the real-embedding integration test
npm run eval:fixture         # the full pipeline, offline
npm run calibrate            # measures the judge; needs ANTHROPIC_API_KEY
```

The judge reads its API key from the project `.env` (see `.env.example`),
explicitly and by path — never from the ambient environment. A run should not be
able to silently bill a key nobody meant to use.

### A note on dependencies

`@huggingface/transformers` pulls two transitively vulnerable packages
(`adm-zip`, `sharp`) with no upstream fix available. Neither is on a path this
project exercises — it embeds text, never decodes images, and unpacks only the
ONNX runtime — but they appear in any `npm audit`, and on a public repository
that is worth stating rather than leaving to be discovered.

## Licence

MIT
