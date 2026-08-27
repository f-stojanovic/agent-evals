# Architecture decision records

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-scores-are-continuous.md) | Scores are continuous, not boolean | Accepted |
| [002](002-baseline-is-a-ci-gate.md) | The baseline is immutable and enforced as a CI gate | Accepted |
| [003](003-baseline-contains-only-reviewable-data.md) | The baseline contains only what a human can review | Accepted |
| [004](004-scorers-may-share-an-expectation-key.md) | Scorers may share an expectation key | Accepted — supersedes the one-owner rule, which was wrong |
| [005](005-two-guards-against-a-suite-that-measures-nothing.md) | Two guards against a suite that measures nothing | Accepted |
| [006](006-extraction-leniency-is-measured.md) | Extraction leniency is measured, not chosen | Accepted |
| [007](007-cache-is-a-development-convenience.md) | The cache is a development convenience, not a source of truth | Accepted |
| [008](008-embeddings-run-locally.md) | Embeddings run locally | Accepted |
| [009](009-model-revisions-are-locked.md) | Model revisions are locked | Accepted |
| [010](010-uncalibrated-constants-are-counted.md) | Uncalibrated constants are counted, not hidden | Accepted |
| [011](011-the-judge-is-calibrated-against-human-labels.md) | The judge is calibrated against human labels | Accepted — measured, MAE 0.096; the labels became human on 2026-08-25 (ADR 021) |
| [012](012-tolerance-is-derived-from-measured-variance.md) | The regression tolerance is derived from measured variance | Accepted |
| [013](013-ci-splits-fixture-from-live.md) | CI is split between a fixture run and a live run | Accepted |
| [014](014-judge-and-subject-sampling-are-not-multiplied.md) | Judge sampling and subject sampling are measured separately, not multiplied | Accepted — supersedes the `minSamples: 3` rule |
| [015](015-test-data-provenance-is-typed.md) | Test-data provenance is typed, not described | Accepted |
| [016](016-categorical-fields-are-constrained-by-schema.md) | Categorical fields are constrained by schema, not requested in prose | Accepted |
| [017](017-checkable-documentation-claims-are-checked.md) | Documentation claims that can be checked mechanically are checked mechanically | Accepted |
| [018](018-a-check-must-prove-it-inspected-something.md) | A check must prove it inspected something | Accepted |
| [019](019-the-scorer-follows-the-field-type.md) | The scorer follows the field type | Accepted |
| [020](020-readme-figures-are-generated.md) | README figures are generated, not transcribed | Accepted |
| [021](021-only-a-human-may-assign-a-label.md) | A model may write the inputs and the outputs; only a human may assign the label | Accepted — the semantic pairs are knowingly still in breach |
| [022](022-a-gate-must-not-screen-on-a-summary.md) | A case mean is a summary, and a gate must not screen on a summary | Accepted — baseline v3; the miss and the catch are both measured |
| [023](023-this-package-is-consumed-as-a-git-dependency.md) | This package is consumed as a git dependency, and that has to be packaged for | Accepted — both install probes measured; the GitHub path itself is still unobserved |
| [024](024-the-sdk-is-a-peer-dependency.md) | The Anthropic SDK is a peer dependency, so a consumer runs one copy | Accepted — range asserted at `<1`, tested at three points |
| [025](025-transformers-is-an-optional-peer.md) | `@huggingface/transformers` is an optional peer, so five scorers cost nothing | Accepted — 27 MB clean-room install measured; the saving in `voice-check` is not |

## Two axes: Status and Evidence

Every record carries both a `Status` and an `Evidence` line, and they answer
different questions. **Status** says whether the decision is in force — whether
the code does this today, and whether a later record supersedes it.
**Evidence** says whether it has been tested: what has actually been observed
that supports it, as opposed to what was reasoned about.

They come apart in both directions, and pretending otherwise is how a design
document turns into marketing. A decision can be correct and entirely
unverified — [ADR 008](008-embeddings-run-locally.md) is accepted and shipped,
and the embedding model in question has never once been downloaded. A decision
can also be well evidenced and wrong, which is what
[ADR 004](004-scorers-may-share-an-expectation-key.md) records: the rule it
supersedes had a written justification and a passing test suite, and the
justification described a mechanism the system does not have.

Five of these records' claims are now checked by `src/docs.test.ts` on every
push — dangling doc links, scorers advertised but never registered, undocumented
baseline files, one-way supersession, and a missing Evidence line
([ADR 017](017-checkable-documentation-claims-are-checked.md)) — and each check
must prove it inspected a non-empty corpus before it is allowed to pass
([ADR 018](018-a-check-must-prove-it-inspected-something.md)). What is left for
a human is what a machine cannot decide: whether an Evidence line is honest and
whether the reasoning holds.

So the two lines are kept apart deliberately. `Evidence: None.` next to
`Status: Accepted` is not an admission that the decision is weak; it is a
statement that the argument for it is reasoning rather than observation, which
a reader is entitled to know before deciding how much weight to put on it. Where
nothing has been observed, the line says what would count — so the gap is a
piece of work rather than a hole.

[011](011-the-judge-is-calibrated-against-human-labels.md) argues that a
judge's scores are inadmissible until measured, and it is the sharpest example
of why the two lines are separate. It was marked measured on 2026-08-19 with an
MAE of 0.031, and both halves of that were in good faith and one of them was
false: the eight labels it was measured against had been written by a model, not
by a person, so the figure recorded consistency and was filed as accuracy. The
labels became human on 2026-08-25 and the same judge on the same outputs
measures 0.096 ([ADR 021](021-only-a-human-may-assign-a-label.md)). The Evidence
line now carries the new number and withdraws the old one rather than quietly
replacing it. Several other records are still unverified, and their Evidence
lines say which.

## Why this repository keeps decision records

Most of what is interesting about an eval harness is not in its code. The code
that computes a mean absolute error is fifteen lines and any competent engineer
would write the same fifteen. What matters is why the baseline may not contain
raw model output, why extraction is lenient rather than strict, and why a judge
is not trusted until it has been measured — and none of that is recoverable from
reading the functions. Six months from now the reasoning is gone, and the next
person to touch the file re-derives it badly or, more often, deletes the
constraint because it looks arbitrary. A comment says what a line does. An ADR
says what would break if you changed it, which is the question someone is
actually asking when they open the file.

The other reason is that this repository has already been wrong three times, on
the record, and in different ways.
[ADR 015](015-test-data-provenance-is-typed.md) is the sharpest of the three: a doc
comment asserted the CI fixtures were captured from a real model when they had
been written by hand in the same session, and it went unchallenged for three
commits because nothing about a comment makes it checkable. The fix was not to
correct the sentence but to make provenance a required typed field the schema
enforces and the report prints. [ADR 004](004-scorers-may-share-an-expectation-key.md) documents a rule
that shipped with a written justification which turned out to be false: it
claimed scorer dispatch was ambiguous when nothing in the system dispatches by
key at all. The rule was imported wholesale from static analysis, where the
justification does hold, and it blocked a legitimate use case while preventing
nothing. It survived a review round precisely because the written rationale made
it look reasoned rather than assumed.
[ADR 021](021-only-a-human-may-assign-a-label.md) is the third and the most
uncomfortable, because ADR 011 rejected the exact mistake it then made — *"labels
generated by a model to measure a model is the same circle drawn wider"* — and
nothing noticed for five days, including every mechanism 015, 017 and 018 had
put in place. That is the strongest argument for keeping these documents: a
decision written down can be audited and reversed, and a reversal that is
recorded is worth more than five successes that are not. It is also the argument
against trusting them too far. A rejected alternative sitting in a file does not
stop anyone implementing it.
