# 019. The scorer follows the field type

Date: 2026-08-20
Status: Accepted
Evidence: Measured live, 2026-08-20, with `Xenova/all-MiniLM-L6-v2` at revision
          `751bff37182d3f1213fa05d7196b954e230abad9`.
          The enum fields now score 1.00 on exact match across all three cases,
          where under free text they scored 0.75 (ADR 016).
          The `summary` field scores 0.54, 0.76 and 0.79 raw cosine against
          hand-written acceptable paraphrases — a band of 0.25 across three
          cases whose summaries are all obviously correct on reading. Exact
          match on that field would score 0.00 on all three, and every one
          would be a false negative.
          What is NOT evidenced: that 0.54 and 0.79 are meaningfully different
          qualities of summary. The default 0.8 threshold is uncalibrated and
          currently marks all three as below it.

## Context

ADR 016 fixed `requested_action`: a categorical field specified as free text,
where exact match graded the case author's vocabulary rather than the model.
The fix constrained it to an enum.

Applied without a stopping rule, that lesson produces the opposite error. After
016 every scored field was an enum, which is not a sign of a well-specified
task — a support-triage agent legitimately produces a one-line summary, and
there is no set of six sentences it should be choosing between. Constraining
that field would force free text into a taxonomy exactly as surely as the
original defect graded a taxonomy as free text.

The two mistakes are the same mistake in opposite directions, and both present
as a scorer problem:

| | field is | specified as | symptom |
| --- | --- | --- | --- |
| ADR 016 | categorical | free text | correct answers score 0, systematically |
| this ADR | free text | categorical | model forced to pick a wrong-but-listed value |


## Decision

The scorer follows from what the field is:

- **Enum fields** — `intent`, `urgency`, `requested_action`. Exact match. The
  set is closed, the API rejects anything outside it, and equality is exactly
  the right question.
- **Free-text fields** — `summary`, and `customer_name` for a different reason.
  Semantic similarity against acceptable paraphrases, and a judge where the
  rubric needs prose. `semanticSimilarity` is projected onto the one field with
  no single right wording, never onto the whole payload.
- **Format** — a per-case declared assertion (`expect.format`), not a global
  metric. The suite-wide `via` distribution stays a metric that grades nothing.

`summary` is added to the subject's tool schema as an unconstrained string, and
all three cases carry `similar` expectations for it.

## Consequences

Both scorers now run. `semanticSimilarity` and `formatCompliance` shipped,
were tested, and had never been invoked by any run until this change — an
embarrassment the README had to disclose. Fixing the cause rather than adding a
case to exercise them means the encoder is now genuinely part of the suite, and
`models.lock.json` finally has an `embedding` slot.

**The suite's headline number went down**, 0.953 → 0.886, and nothing got
worse. Adding scorers changes what the mean is an average of. That is the
correct behaviour and it is an uncomfortable property: the aggregate is not
comparable across a change to the scorer set, in the same way it is not
comparable across a change of model. The baseline records model identity and refuses a mismatched comparison; it did
**not** record the scorer set, so this change surfaced as a spurious regression
on the run that introduced it and had to be re-recorded by hand.

That gap is now closed, by reusing the model mechanic one axis over. The
baseline records the sorted scorer names, a mismatch is its own hard failure
with its own message — *"the scorer set changed, so these means are not
comparable — re-record the baseline"* — and when either identity differs the
per-case deltas are not computed at all, because a fake regression is worse
than no number: it looks actionable. Both directions are tested, added and
removed. Recording a new field changed the baseline format, so
`BASELINE_VERSION` went to 2 and an older file now fails with a sentence naming
the remedy rather than a schema dump — and `--update-baseline` is exempt from
that refusal, because it IS the remedy.

**Semantic scores sit in a narrow, low band** — 0.54 to 0.79 for three
summaries that are all plainly correct. This is the documented behaviour of
sentence encoders and the reason ADR 010 deleted the rescale that used to hide
it. The default 0.8 threshold marks all three as below threshold, so
`below threshold` in the report is partly a statement about the constant rather
than about the model.

Calibrating it was attempted and **failed, informatively**: against 10
hand-labelled pairs the correct and incorrect groups do not separate at all
(margin -0.728). No threshold was adopted. See the next point for why.

**Semantic similarity cannot catch a fluent lie, and this is now measured.** A
summary confidently wrong about a fact sits close to a correct one in embedding
space because it is about the same thing. In the calibration set, the three
fluent-but-wrong candidates occupy the TOP of the ranking — above every correct
paraphrase — and the worst of them, a summary that says the customer wants a
replacement when the email explicitly declined one, scores **1.000**. The
highest score in the whole set belongs to the wrong answer.

Exact match on the enum fields is what constrains the facts; the semantic score
constrains only what the sentence is about. That is the argument for never
letting a semantic scorer be the only scorer on a field.

## Alternatives rejected

**Constrain `summary` too, to a set of templates.** Would make exact match work
and would destroy the field. A templated summary is a fifth enum with extra
characters.

**Score `summary` with the judge instead.** Defensible, and it is what the
judge already does for the one case with a rubric. Rejected as the default
because it costs an API call per sample to answer a question a 22M-parameter
encoder answers offline in milliseconds. The judge is for questions that need
reading comprehension; "is this sentence about the same thing" does not.

**Embed the whole extracted payload rather than projecting onto one field.**
Tried and rejected earlier: the encoder spends its capacity on braces, quotes
and key names identical in every response, which compresses the range and makes
genuinely different answers look alike.

**Leave the two scorers unregistered and document it.** The README did exactly
that, honestly, for two rounds. A scorer nobody runs is a scorer nobody knows
is broken.
