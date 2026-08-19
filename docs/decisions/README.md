# Architecture decision records

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-scores-are-continuous.md) | Scores are continuous, not boolean | Accepted |
| [002](002-baseline-is-a-ci-gate.md) | The baseline is immutable and enforced as a CI gate | Accepted, not yet implemented |
| [003](003-baseline-contains-only-reviewable-data.md) | The baseline contains only what a human can review | Accepted, not yet implemented |
| [004](004-scorers-may-share-an-expectation-key.md) | Scorers may share an expectation key | Accepted — supersedes the one-owner rule, which was wrong |
| [005](005-two-guards-against-a-suite-that-measures-nothing.md) | Two guards against a suite that measures nothing | Accepted |
| [006](006-extraction-leniency-is-measured.md) | Extraction leniency is measured, not chosen | Accepted |
| [007](007-cache-is-a-development-convenience.md) | The cache is a development convenience, not a source of truth | Accepted, not yet implemented |
| [008](008-embeddings-run-locally.md) | Embeddings run locally | Accepted |
| [009](009-model-revisions-are-locked.md) | Model revisions are locked | Accepted — embedding slot only |
| [010](010-uncalibrated-constants-are-counted.md) | Uncalibrated constants are counted, not hidden | Accepted |
| [011](011-the-judge-is-calibrated-against-human-labels.md) | The judge is calibrated against human labels | Accepted, not yet run against a live judge |

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

The other reason is that this repository has already been wrong once, on the
record. [ADR 004](004-scorers-may-share-an-expectation-key.md) documents a rule
that shipped with a written justification which turned out to be false: it
claimed scorer dispatch was ambiguous when nothing in the system dispatches by
key at all. The rule was imported wholesale from static analysis, where the
justification does hold, and it blocked a legitimate use case while preventing
nothing. It survived a review round precisely because the written rationale made
it look reasoned rather than assumed. That is the strongest argument for keeping
these documents: a decision written down can be audited and reversed, and a
reversal that is recorded is worth more than five successes that are not.
