# 010. Uncalibrated constants are counted, not hidden

Date: 2026-08-19
Status: Accepted
Evidence: Direct, from this repository's own history, and now from one
          constant taken all the way through.
          The near-miss is real: the semantic scorer shipped with a
          [0.3, 0.95] rescale stacked under an invented threshold, and
          formatCompliance shipped with a 0.5 for a markdown fence. Both were
          defended in comments at the time; both were deleted.
          The mechanism is covered by src/uncalibrated.test.ts, including the
          case that motivated dropping the global registry — a count that
          changed with which modules had been imported.
          MEASURED, 2026-08-20: `semantic-similarity.threshold` was counted as
          uncalibrated in every report, then calibrated against 10 hand-labelled
          pairs (`npm run calibrate:semantic`). The groups do not separate:
          lowest correct 0.506, highest incorrect 0.898, margin -0.392. No
          threshold classifies the set, so none was adopted and the constant is
          still declared as a guess. (The first run of this reported a margin of
          -0.728 off a pair scoring exactly 1.000 — a YAML truncation defect,
          not a finding. Corrected, and now guarded by src/eval-data.test.ts.) That is the mechanism working — a counted
          assumption was examined and survived as an assumption, with a reason
          on the record rather than a number invented to close the ticket.

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

I created a flat, zeroing out fee with some numbers I completely made up (like 30 cents 
and some kind of $1 cap where if below $1, fee goes away – which I then remove 2 months 
later as a “per-entity config” that no one could trace where the hell the dollar came from). 
Default fee then got set to 0 once inherited by non-prod and started charging fees nobody 
was looking for 1 month later. So that was 3 edits over 4 months, based off of choosing 2 
numbers in 10 seconds. The honest response is not to remove the constants. A harness needs  
defaults. It is to refuse to let them disappear into the code.

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
