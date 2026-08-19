# 010. Uncalibrated constants are counted, not hidden

Date: 2026-08-19
Status: Accepted

## Context

A harness like this fills up with numbers that look like findings and are guesses.
A pass threshold of 0.8. A judge-disagreement cutoff of 0.25. Three
self-consistency samples. Each is defensible in isolation, each has to be *some*
value for the code to run, and none is derived from data.

Stacked, they stop being individually defensible. The semantic scorer was the near
miss: it rescaled raw cosine similarity from an invented [0.3, 0.95] band onto
[0, 1], and the rescaled value was then compared against an invented threshold.
Three guesses in a trench coat, producing a number that read as calibrated,
matched no published similarity figure, and could not be sanity-checked against
anything. The floor and ceiling were both defended in comments at the time. Both
were made up.

<!-- FILIP: add the concrete experience here — what you saw, where, what it cost -->

The honest response is not to remove the constants. A harness needs defaults. It
is to refuse to let them disappear into the code.

## Decision

We declare every constant not derived from data through
`uncalibrated(value, id, note)`, which returns the value unchanged and registers
it. The note says what the number does and what would have to be measured to
justify it. Reports end with a count and the list.

The rule: if you cannot say which measurement produced a number, it goes through
the registry. A value produced by a calibration run does not — that is the point
of calibrating it.

Four constants are currently registered: the semantic pass threshold, and the
judge's sample count, disagreement threshold, and pass threshold.

We also deleted the guesses that were doing real damage. The semantic scorer now
emits raw cosine similarity with no rescale, and `formatCompliance` grades against
a format the case author declares instead of awarding a made-up 0.5 for a fence.

## Consequences

Assumptions are counted rather than absorbed. A report that ends with "this run
used 4 uncalibrated constants" tells a reader how much of the number in front of
them is convention.

Raw cosine is harder to read than a rescaled score — unrelated sentences sit near
0.3 rather than 0 — and we accept the worse ergonomics for a number that is
comparable to published figures and to itself across runs.

The registry is process-global mutable state, populated at import time and inside
factories, keyed by id, with a test-only reset export. That is a genuine wart: the
count is independent of construction order, which is what a report needs, but it
means the module has state that tests must clear.

It is also unenforced. Nothing stops the next constant being written as a bare
`0.75`, and the registry only knows about numbers someone remembered to declare —
so the count is a floor on how many assumptions a run made, never the total.

## Alternatives rejected

**Pick plausible defaults and move on.** This is the default behaviour of every
codebase, and it is how the rescale shipped. The problem is not that the values
are wrong; it is that nothing distinguishes a threshold somebody measured from one
somebody guessed, so both are read as measured.

**Refuse to have defaults and require every threshold to be configured.** Moves
the guess to the caller and makes the tool unusable out of the box, without making
anybody's number better informed.

**A comment next to each constant.** Comments do not aggregate. Four `// this is a
guess` comments scattered across two files never become the sentence "this run
used 4 uncalibrated constants" at the bottom of a report a human is already
reading.
