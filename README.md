# agent-evals

[![ci](https://github.com/f-stojanovic/agent-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/f-stojanovic/agent-evals/actions/workflows/ci.yml)
[![eval-live](https://github.com/f-stojanovic/agent-evals/actions/workflows/eval-live.yml/badge.svg)](https://github.com/f-stojanovic/agent-evals/actions/workflows/eval-live.yml)

![GitHub Actions showing both workflows green: ci on the latest push and
eval-live on a manual dispatch](docs/images/ci-both-workflows-green.png)

*Both gates on `main`: the per-push fixture gate and the live run against real
models. The live run grades with `claude-opus-5` and costs about $0.22.*

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

## Before and after: the harness found a specification error

This is the thing this repository actually did, on its first live run.

Three cases, `claude-sonnet-5`, exact-match scoring. Every case lost the same
field, `requested_action`:

```
| case                            | exact-fields | llm-judge | mean  | sd    | Δ vs baseline   | cost    | ms    |
|    cancellation-or-complaint-01 | 0.55         | 0.95      | 0.752 | 0.026 | -0.003 (±0.082) | $0.0741 | 46914 |
|    outage-escalation-01         | 0.75         | —         | 0.750 | 0.000 | +0.000 (±0.050) | $0.0110 | 13165 |
|    refund-damaged-item-01       | 0.75         | —         | 0.750 | 0.000 | +0.000 (±0.050) | $0.0092 | 15371 |

- weighted score: 0.750
- fenced: 10 (67%) · json: 5 (33%)
```

The model's answers were correct. They were not the case author's words:

| case | expected | model produced |
| --- | --- | --- |
| refund-damaged-item-01 | `issue_refund` | `refund_full_amount` |
| outage-escalation-01 | `escalate_to_engineering` | `fix_checkout_api_503_errors` |
| cancellation-or-complaint-01 | `explain_cancellation_terms` | `clarify_cancellation_terms` |

`requested_action` had been specified as "a short snake_case verb phrase" — a
categorical field asked for as free text. Moving it, `intent` and `urgency`
into the subject's tool schema as enums:

```
**GATE: PASS** — no regression against the baseline.

| case                            | exact-fields | llm-judge | mean  | sd    | Δ vs baseline   | via       | cost    | ms    |
| 🟢 cancellation-or-complaint-01 | 0.85         | 0.93      | 0.889 | 0.030 | +0.134 (±0.085) | tool-call | $0.0786 | 39956 |
| 🟢 outage-escalation-01         | 1.00         | —         | 1.000 | 0.000 | +0.250 (±0.050) | tool-call | $0.0246 | 20002 |
| 🟢 refund-damaged-item-01       | 1.00         | —         | 1.000 | 0.000 | +0.250 (±0.050) | tool-call | $0.0237 | 20179 |

- weighted score: 0.972
- tool-call: 15 (100%)
```

**0.751 → 0.953 recorded.** Same model. Same prompt intent. Same cases. Same
scorers. Nothing about the model got better and no scoring was loosened.

The number moved because the harness surfaced a defect in the task definition
on its first live run — and before that run, the number read as a model
problem. That is the whole argument for running evals against a real subject
early and recording what comes back, rather than tuning a suite until it looks
right.

Three things worth stating so the result is not read as better than it is:

- **The residual mismatch is real disagreement, not wording.** One field on one
  case: `urgency: high` vs `medium` on the deliberately ambiguous case, where
  `medium` is listed in that case's own `acceptable` set. That is what should
  be left over.
- **Two things changed at once.** A tool call also changes how the payload
  arrives, so the 67%-fenced observation vanished as a side effect of the
  delivery mechanism, not because formatting improved. The earlier run is
  preserved in `evals/baseline.freetext.json`.
- **The recorded numbers move between runs.** Consecutive runs of the
  constrained subject did not reproduce exactly; the archived 0.953 is one draw,
  not a fixed property of the model. At 0.75 with a systematic wording failure,
  that variation was invisible underneath the constant error.

Both figures are anchored to committed archives rather than retyped:
`evals/baseline.freetext.json` holds the before, `evals/baseline.enums-prescorer.json`
holds the after, and a test fails if the prose and the archives disagree.
Neither is a gate — nothing compares against them.

The reasoning is [ADR 016](docs/decisions/016-categorical-fields-are-constrained-by-schema.md),
including why `semanticSimilarity` on that field would have been the wrong fix.

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
  samples: 5,           // a stdDev from five draws is weak; from three, barely one
  cache: CACHE_OFF,        // required: no silent default-on (ADR 007)
});
```

A case is YAML:

```yaml
- id: "refund-damaged-item-01"   # stable forever; it is the baseline key
  input:
    subject: "Order #48812 arrived broken"   # quote it: bare `#` starts a comment
    body: |
      The ceramic mug was shattered inside the box. Please refund me.
  expect:
    fields:
      intent: refund_request
      urgency: medium
```

### What a full run looks like

Verbatim, current subject, comparing against its own recorded baseline:

<!-- generated:run-block -->

```
# Eval run — live

2026-08-25T08:11:49.004Z · 5 cases · 51.9s

**GATE: PASS** — no regression against the baseline.

| case                            | calls-tool | exact-fields | format-compliance | llm-judge | matches-schema | semantic-similarity | mean  | sd    | Δ vs baseline   | via       | cost    | ms    |
| ------------------------------- | ---------- | ------------ | ----------------- | --------- | -------------- | ------------------- | ----- | ----- | --------------- | --------- | ------- | ----- |
|    billing-question-schema-01   | —          | 1.00         | 1.00              | —         | 1.00           | 0.81                | 0.951 | 0.007 | +0.011 (±0.079) | tool-call | $0.0323 | 24900 |
|    cancellation-or-complaint-01 | —          | 0.90         | 1.00              | 0.77      | —              | 0.71                | 0.844 | 0.094 | -0.028 (±0.147) | tool-call | $0.0885 | 51906 |
|    no-tool-abuse-01             | 1.00       | 1.00         | 1.00              | —         | —              | 0.91                | 0.978 | 0.002 | -0.003 (±0.052) | tool-call | $0.0286 | 16764 |
|    outage-escalation-01         | —          | 1.00         | 1.00              | —         | —              | 0.57                | 0.857 | 0.031 | -0.014 (±0.090) | tool-call | $0.0346 | 29726 |
|    refund-damaged-item-01       | —          | 1.00         | 1.00              | —         | —              | 0.81                | 0.935 | 0.012 | -0.011 (±0.062) | tool-call | $0.0325 | 23009 |

## Totals

- cases: 5 · below threshold: 3 of 5 · errored 0
- weighted score: **0.904**
- latency: p50 24900ms · p95 51906ms · max 51906ms
- cost: **$0.2166** — subject $0.1615, judge $0.0552
- tokens: 26575 in / 5450 out

### Output format distribution

- tool-call: 25 (100%)

### Models

- judge: `claude-opus-5` @ unpinned (hosted)

### Test data provenance

- live subject: responses came from the model, not from replayed data

### Assumptions

This run used 5 uncalibrated constants:
  llm-judge.threshold = 0.7 — median judge score at or above which a case passes. A guess; the continuous value is recorded so it can be revisited against history.
  semantic-similarity.threshold = 0.8 — raw cosine above which a response counts as matching. A guess: the right cutoff depends on the encoder and the domain. Calibrate it against labelled pairs the way src/calibrate.ts calibrates the judge.
  baseline.floor = 0.05 — absolute score drop tolerated before a case is flagged. The primary allowance in the screen, and a convention — nothing measured says a 0.05 drop is acceptable and 0.06 is not.
  baseline.scorerFloor = 0.1 — absolute drop tolerated in a SINGLE scorer before it is flagged, independently of the case mean. Bounded by argument rather than measurement: below ~0.15 or it adds nothing the case screen has, above 0.05 or it fires on one field in one sample of five.
  baseline.z = 2 — standard errors of extra allowance granted to a noisy case. Borrowed from a normal approximation that the underlying data does not satisfy at n=5; treat it as a widening factor, not a confidence level.
```

<!-- /generated:run-block -->

**The `below threshold` tally and the gate answer different questions**, which
is why they are printed as two lines. The tally counts cases under each scorer's
own cutoff; the gate asks only whether anything got *worse* than the baseline,
so a run is routinely green with cases below threshold. Here the tally is driven
by the semantic scorer's uncalibrated 0.8 cutoff rather than by the model — see
below.

**The `via` column is per case.** Under the earlier free-text subject it showed
different routes on different cases under one identical system prompt — some
fencing every sample, some none — so the envelope tracked the input rather than
the instruction. A suite-wide total would have averaged that away. (The current
subject uses a tool call, so the column is uniform; the observation belongs to
the archived free-text run.)

## Choosing a scorer by field type

Both of this repository's scoring mistakes were the same mistake, pointing in
opposite directions, and both looked like a scorer problem:

| | the field is | it was specified as | what you see |
| --- | --- | --- | --- |
| what happened | categorical | free text | correct answers score 0, systematically |
| what almost happened next | free text | categorical | the model forced to pick a wrong-but-listed value |

`requested_action` was the first. Fixing it by constraining the field is
[ADR 016](docs/decisions/016-categorical-fields-are-constrained-by-schema.md) —
and applying that lesson without a stopping rule produces the second error,
because after it every scored field was an enum. A triage agent legitimately
writes a one-line `summary`, and there is no set of six sentences it should be
choosing between.

So the scorer follows the field
([ADR 019](docs/decisions/019-the-scorer-follows-the-field-type.md)):

- **Enum fields** → `exactFields`. The set is closed and the API rejects
  anything outside it, so equality is the right question. The `exact-fields`
  column in the run block above is at or near 1.00 throughout, where free text
  scored 0.75 across the board — the archived before and after are
  `evals/baseline.freetext.json` and `evals/baseline.enums-prescorer.json`.
- **Free text** → `semanticSimilarity` projected onto that one field, and
  `llmJudge` where the rubric needs prose. Never embed the whole payload: the
  encoder spends its capacity on braces and key names identical in every
  response.
- **Format** → a per-case declared assertion (`expect.format`), not a global
  metric. The suite-wide `via` distribution stays a metric and grades nothing.

The semantic numbers are worth looking at squarely: the `semantic-similarity`
column in the run block above holds summaries that are all plainly correct on
reading, and they do not cluster near 1.0. That band is what sentence encoders
do, it is why [ADR 010](docs/decisions/010-uncalibrated-constants-are-counted.md)
deleted the rescale that used to hide it, and it is why the default 0.8 cutoff
puts correct summaries below threshold. That cutoff is a guess, it is declared
as one in every report, and calibrating it against labelled pairs was attempted
and failed — see the table below.

Semantic similarity also cannot catch a fluent lie: a summary confidently wrong
about the order number still lands close to the expected paraphrase. The enum
fields constrain the facts; the semantic score only constrains what the sentence
is about.

## A semantic scorer cannot catch a fluent lie

This is the most useful thing in this repository if you are building your own,
and it is measured rather than argued.

`npm run calibrate:semantic` scores 10 labelled summary pairs against the
local encoder. Five are correct paraphrases. Five are wrong — but three of those
are wrong the way a model is actually wrong: fluent, on-topic, confident, and
false about one fact.

Those ten labels are **generated, not human**, and are queued for replacement —
the judge set next door had exactly this defect and replacing its labels moved
its measured error by roughly a factor of three
([ADR 021](docs/decisions/021-only-a-human-may-assign-a-label.md)). The finding
below survives that caveat better than most, because it is a negative result:
the scorer fails to separate groups that a wrong label set would, if anything,
make easier to separate.

<!-- generated:semantic-calibration -->

```
Semantic threshold calibration

  pair     label      cosine
  -------  ---------  ------
  sem-p02  incorrect  0.898
  sem-p01  correct    0.808
  sem-p03  incorrect  0.708
  sem-p04  correct    0.700
  sem-p08  correct    0.678
  sem-p07  incorrect  0.668
  sem-p05  correct    0.566
  sem-p09  correct    0.506
  sem-p06  incorrect  0.300
  sem-p10  incorrect  0.292

  lowest correct   : 0.506
  highest incorrect: 0.898
  margin           : -0.392

  DOES NOT SEPARATE. 8 pair(s) sit in the overlap:
    sem-p01 (correct) at 0.808
    sem-p02 (incorrect) at 0.898
    sem-p03 (incorrect) at 0.708
    sem-p04 (correct) at 0.700
    sem-p05 (correct) at 0.566
    sem-p07 (incorrect) at 0.668
    sem-p08 (correct) at 0.678
    sem-p09 (correct) at 0.506

  There is no threshold that classifies this set correctly, so none is
  recommended. Leaving the default declared as an uncalibrated constant is
  the honest outcome: a number chosen to split overlapping data would look
  measured and would not be.

  What this actually shows is a limit of the scorer, not of the set. A
  fluent summary that is confidently wrong about a fact sits close to a
  correct one in embedding space, because it is about the same thing. The
  fix is not a better threshold; it is not relying on this scorer alone.

  ⚠ Labels: 10 of 10 were GENERATED, not assigned
    by a human. To that extent this figure is a model agreeing with itself
    rather than a measurement. See ADR 021.
```

<!-- /generated:semantic-calibration -->

**The worst lie outranks every correct paraphrase.** The top score in the set —
0.898 — belongs to a summary saying the customer wants a replacement, when the
email explicitly declined one. One word changed, the fact inverted, and the
encoder barely registers it, because the two sentences are about the same thing.
The best genuinely-correct paraphrase scores 0.808 beneath it.

An earlier version of this table showed that pair at exactly 1.000, which was a
defect and not a finding. Two different sentences do not produce an identical
embedding. They had both been truncated by YAML — an unquoted `#48812` starts a
comment in a plain scalar — so both sides became the same 49-character prefix
and scored a perfect match. Quoting the strings gives 0.898. The conclusion
survives; the number that would not have survived scrutiny is gone, and
`src/eval-data.test.ts` now fails the build on an unquoted ` #` anywhere under
`evals/`.

There is no threshold that separates these groups. So none was adopted: the
calibration reports the failure, and `semantic-similarity.threshold` stays
declared as an uncalibrated constant in every run. **A failed calibration is a
result.** Picking a number that splits overlapping data would have produced
something that looked measured and was not.

What this actually shows is a limit of the tool, not of the labels:

> The enum fields constrain the facts. The semantic score only constrains what
> the sentence is about.

Which is the reason a semantic scorer must never be the only scorer on a field.
Pair it with something that can be wrong in a way it can detect — exact match on
the parts that are categorical, a schema on the shape, a judge with a rubric that
names the facts that matter. On the example suite, `exact-fields` scoring 1.00 on
the enums is what makes the 0.54 semantic score on the same case readable as
"different wording" rather than "possibly fabricated".

## The regression that got through, and the screen that was added

The defect is the one people actually make. Someone tidies an enum and drops a
value that looks redundant — `critical` from the subject's `urgency` set, one
line. The schema stays valid. Typecheck stays clean. All 281 tests pass. The
model, no longer permitted to say `critical`, returns `high` on the case whose
email describes a production outage losing £4k an hour.

`exact-fields` on that case fell **1.00 → 0.75**, five samples out of five. Here
is what the gate said:

```
**GATE: PASS** — no regression against the baseline.

| case                    | exact-fields | format-compliance | semantic-similarity | mean  | sd    | Δ vs baseline   |
| outage-escalation-01    | 0.75         | 1.00              | 0.57                | 0.774 | 0.031 | -0.077 (±0.087) |
```

It cleared by 0.010, and not by bad luck. The case is graded by three scorers and
averaged, so one wrong field of four arrives at the comparison as
`0.25 / 3 = 0.0833` — the **maximum** a single-field regression can move that
mean, against a tolerance of 0.087. No single-field regression on that case was
detectable at all, whatever the field.

The per-scorer numbers were in the baseline the whole time. `{"exact-fields": 1,
"semantic-similarity": 0.55134, "format-compliance": 1}` had been recorded since
v2 and nothing ever compared them. Everything needed to catch it was committed,
in the diff, and unused.

So the gate now screens the parts as well as the summary — same rule,
`floor + z·se`, applied per scorer, with each scorer's own spread recorded
alongside its mean. The identical defect, re-run against the identical suite:

```
**GATE: FAIL** — 1 regression (1 in a single scorer, with the case mean inside tolerance).

| case                    | exact-fields | format-compliance | semantic-similarity | mean  | sd    | Δ vs baseline   |
| 🔴 outage-escalation-01 | 0.75         | 1.00              | 0.62                | 0.791 | 0.040 | -0.080 (±0.096) |

## Regressions

- **outage-escalation-01** 0.870 → 0.791 (-0.080, tolerance ±0.096)
  - `exact-fields` 1.000 → 0.750 (-0.250, tolerance ±0.100) — this scorer alone
```

The case mean is still inside its tolerance and is still correctly reported as
such. The scorer is not. The enum was restored, verified byte-identical, and the
next run passed.

Two things this does not claim. The floor of 0.10 is a guess — bounded by
argument, reported in the uncalibrated list with the others, and explained in
[ADR 022](docs/decisions/022-a-gate-must-not-screen-on-a-summary.md). And it
catches the concentrated case, not the diffuse one: six scorers each dropping
0.09 would still pass both screens. That is the case the mean was always good
at, and the two are complementary rather than one replacing the other.

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

## "The model was wrong" and "we cannot tell" are different findings

Extraction can fail two ways, and they are recorded differently.

**`unreadable`** — the response contained no parseable JSON at all. The model
was asked for JSON and produced none. That is a fact *about the model*, so it
scores **0.0 with a reason and goes into the baseline** — which means the day a
subject stops emitting JSON, the suite shows a score drop rather than an
infrastructure error nobody can trend.

**`ambiguous`** — several fenced blocks each parsed and there is no principled
way to choose. First-wins scores the model's scratch work; last-wins scores a
trailing example. Nothing about the model was established, so the case is
**errored and excluded from the baseline**. An invented measurement is worse
than a refused one.

Collapsing the two would erase the axis this repository exists to measure. An
earlier version did exactly that, and a total format collapse would have been
filed as an infrastructure error and left no trace in the recorded history.

The blast radius of `ambiguous` is narrow: only scorers that consume the
extraction are affected. One reading `output.text` directly still scores.

## Judging the judge

`llmJudge` grades a case against a prose rubric by asking a different model. It
is also the only scorer that is itself a probabilistic system with unknown
accuracy, and adopting one without measuring it does not remove the unmeasured
part of your pipeline — it moves it one level down and attaches a number to it.

So `evals/calibration/` holds cases with human-assigned scores spanning the
range, each paired with a frozen output. `npm run calibrate` reports mean
absolute and mean signed error against those labels.

**The labels were replaced on 2026-08-24 and the measured error roughly
tripled.** Until then they had been written by a model — the same class of
system the judge is, grading outputs and rubrics that model had also written —
and the number that came out was published as accuracy when it was consistency.
Two of the rubrics made it worse by stating the target outright: one ended
*"score it around 0.3 … not higher"* and the judge returned 0.30, an error of
exactly zero on a case that measured nothing but instruction-following. With the
target deleted and the rubric rewritten to grade content rather than format, the
same judge on the same output returns 1.00.

The labels are now Filip Stojanović's, the rubrics state rules and never
targets, and each label declares whether the case has a ground truth at all —
one of the eight does not, and it is reported separately rather than averaged in
([ADR 021](docs/decisions/021-only-a-human-may-assign-a-label.md)).

<!-- generated:judge-calibration -->

**Measured: MAE 0.102 over n=8**, mean signed error +0.077. Over the 7 cases that have a ground truth it is 0.050; the remainder are contested labels, where no right answer exists and judge error is disagreement rather than inaccuracy. The labels are one pass by one human annotator. The outputs and rubrics they grade were written by a model (ADR 021).

<!-- /generated:judge-calibration -->

Three details that matter:

- **Structured verdicts through a forced tool call**, never prose to be parsed.
- **The rubric goes in the system prompt; the output goes in a delimited user
  turn.** A security boundary: in a real suite the output derives from customer
  emails and scraped pages, and putting that in the system prompt is a path from
  your own test data to a green build.
- **One verdict per sample, by default.** `temperature` no longer exists on
  current Claude models, so judge variance cannot be suppressed — only
  measured. It does not follow that the judge should be averaged inside a case:
  medianing k verdicts shrinks the variance the baseline records below the
  variance production has, and the gate derives its allowance from exactly that
  number. Judge variance gets its own command,
  `npm run judge:variance`, which holds the output fixed and asks k=5 times.
  The measured spread is small — run the command to see the current figure
  ([ADR 014](docs/decisions/014-judge-and-subject-sampling-are-not-multiplied.md)).

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

| workflow | when | what it proves | baseline |
| --- | --- | --- | --- |
| `ci.yml` | every push and PR | the **harness** works — typecheck, unit tests, and a full eval replaying fixed outputs. Deterministic, free, no secrets, works on forks. | `evals/baseline.fixture.json` |
| `eval-live.yml` | manual dispatch; a weekly schedule is configured but has not yet fired | the **models** still behave — real API calls, cache disabled, report uploaded. | `evals/baseline.json` |

![eval-live failing on GitHub Actions: the run refuses a baseline recorded in
an older format and exits 1](docs/images/gate-refuses-stale-baseline.png)

*`eval-live` refusing a baseline recorded in an older format, on real CI
against a genuinely stale file. This is the guard firing — not a caught
regression. Nothing has yet changed a prompt and been caught by the gate;
that is still open below.*

**Two baseline files, and not for convenience.** The fixture run grades with a
replaying judge and the live run grades with `claude-opus-5`. Scores from
different judge models are not comparable ([ADR 009](docs/decisions/009-model-revisions-are-locked.md)),
so a single file would make one of the two runs fail a model-mismatch check on
every execution — correctly, and uselessly. Each run owns the baseline it
records. A third file, `evals/baseline.freetext.json`, is an archive rather than
a gate: it preserves the pre-enum numbers as the evidence for
[ADR 016](docs/decisions/016-categorical-fields-are-constrained-by-schema.md)
and nothing compares against it.

**The per-push gate cannot catch a model regression.** It runs against
recordings. A model that got worse overnight passes it, and is caught by the
live run — which today means whenever someone dispatches one, because the
weekly schedule has not yet fired. Writing "within a week" here, as this
paragraph did, would be exactly the kind of overstatement this project exists
to prevent: the cron is configured, and configuration is not evidence.

## Status

- [x] Domain types — the stable contract
- [x] YAML case loader with actionable errors and stable ordering
- [x] Both wiring guards: unclaimed keys, and cases nothing measures
- [x] Score contract enforcement — finite, 0..1, correctly attributed
- [x] Extraction with the route recorded; ambiguity refused rather than guessed
- [x] Every shipped scorer is registered and has produced a number:
      `exactFields`, `matchesSchema`, `callsTool`, `formatCompliance`,
      `semanticSimilarity`, `llmJudge`. A test asserts each has a case that
      exercises it, so none can go idle again unnoticed.
- [x] Judge calibration against human labels (`npm run calibrate`)
- [x] Documentation checks as tests (`src/docs.test.ts`), including a check that
      each check inspected a non-empty corpus
- [x] `models.lock.json` — model changes are explicit and reviewable
- [x] Runner — concurrency, sampling, retry with jitter, timeouts, disk cache,
      cost accounting
- [x] Baseline file and the CI gate, with a tolerance derived from variance
- [x] Report — markdown and a JSON artifact
- [x] CI: fixture gate on every push; live run on manual dispatch
- [ ] Live run on the weekly schedule — the cron is configured (`0 3 * * 1`)
      and has never fired: the workflow was disabled over the one Monday that
      has passed since it was added. Ticks when a `schedule` run appears in the
      history, not before.
- [x] Live judge calibration — the measured figure is in the generated block
      under "Judging the judge"
- [x] Live runs against a real subject, with the baseline recorded from one —
      see the generated run block for what the current baseline covers
- [ ] Reporters beyond markdown/JSON (GitHub annotations)

Decisions and their reasoning — including one that was wrong and was reversed —
are in [`docs/decisions/`](docs/decisions/).

## Known limitations

Everything here is true as of the last live run. None of it is hypothetical.

**The calibration labels are one annotator over eight cases.** They are one
person's judgement, assigned in one pass and not reviewed by a second reader.
One of the eight is marked `contested` — a case with no right answer, where the
judge sits well above the human and that distance is the ambiguity being
reported rather than an error to close.

**The judge's calibration figures published before 2026-08-24 were wrong in
kind, not in value.** They measured a model against labels a model had written.
Every earlier MAE quoted anywhere in this repository is withdrawn
([ADR 021](docs/decisions/021-only-a-human-may-assign-a-label.md)).

**The MAE is itself noisy.** Two runs of the identical calibration set an hour
apart differed by about a third of its value, and the sign of the bias flipped
between them. That was measured on the old label set and there is no reason it
would not hold for the new one, which has been run once. At n=8 the figure is a
range, not a number — read the generated block as one draw.

**The semantic threshold is uncalibrated, calibration failed, and its labels are
still generated.** Against 10 pairs the correct and incorrect groups do not
separate at all (the margin is reported in the table above), so no threshold was
adopted and the constant is still declared as a guess in every report. That is a
limit of the scorer rather than of the labels — see "A semantic scorer cannot
catch a fluent lie" above. But the labels have not yet had the treatment the
judge set got: they were written by a model and no human has reviewed them, so
the separation figure is a model agreeing with itself and is knowingly in breach
of [ADR 021](docs/decisions/021-only-a-human-may-assign-a-label.md).

**The scheduled run would sample less than the run that recorded the baseline.**
`eval-live.yml` defaults to `--samples 3`; the committed baseline was recorded
at n=5. Nothing breaks — the tolerance takes both sample counts and widens
accordingly — but it means the weekly gate is systematically less sensitive than
the run it compares against, and no run has yet exercised that combination
because the schedule has never fired.

**The judge model pin is weak.** `claude-opus-5` is a moving target on the
provider's side: the same id can be served by a different build than last month,
and nothing local detects that. The lockfile catches somebody changing the id.

**The regression screen is a screen.** At n=5, `stdDev` is estimated from five
numbers. `z·se` is a widening factor for demonstrably noisy cases, not a
confidence interval, and there is no correction for screening every case at
once. It is better than one fixed tolerance for the whole suite and it is not
statistics.

**The regression screen is weakest exactly where the scorer is noisiest.** On
the one case whose score leans on `semantic-similarity`, three consecutive runs
of the same subject scored 0.77, 0.55 and 0.61 — a spread wider than most
regressions worth catching. The derived tolerance widens to match, which is
correct and also means the gate is close to blind on that case. A quieter
scorer, or more samples, would buy back the sensitivity.

Those three figures are anchored, not retyped: `evals/baseline.semantic-spread-high.json`
and `evals/baseline.semantic-spread-low.json` are committed archives of the
first two runs, the third is the current `evals/baseline.json`, and a test fails
if the prose and the files disagree. The current baseline also records the
within-run spread on that scorer directly — stdDev 0.097, against 0.000 for
`exact-fields` on the same case.

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

---

Built by [Filip Stojanović](https://github.com/f-stojanovic) — backend engineer,
nine years, mostly Symfony and payments. I wrote this while moving into AI
engineering, so that I would have something measured to say about evals instead
of a claim that I understand them.

## Licence

MIT
