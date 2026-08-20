# 020. README figures are generated, not transcribed

Date: 2026-08-20
Status: Accepted
Evidence: Five contradictions found simultaneously in a public README, named
          here because a count is not a finding:
          1. "Neither GitHub workflow has ever executed. There is no remote." —
             sitting under two CI badges pointing at
             `github.com/f-stojanovic/agent-evals`, where `ci` had passed and
             `eval-live` had been dispatched.
          2. Known limitations recommended `semanticSimilarity` on
             `requested_action` as work still to do, three sections below the
             Before/After showing it fixed by enums instead, and while ADR 016
             rejected that exact fix with reasons.
          3. "the recorded baseline of 0.751" — two baselines out of date.
          4. The semantic margin published as −0.728 in Known limitations and
             −0.392 in the corrected table on the same page. The first is the
             pre-YAML-truncation number.
          5. Status ticked a first live run whose baseline had since been
             superseded twice.
          Every one is a hand-copied number or claim. The fix is verified by
          `src/readme.test.ts`: hand-editing inside a marker fails the build,
          and so does reinstating the "no remote" sentence.

## Context

This is the fifth time a document in this repository has asserted something
untrue, and the first time it contradicted *itself* rather than the code.

The earlier four had one cause and one remedy: documents drift from code, so
`docs.test.ts` checks documents against code (ADR 017), and each check proves it
inspected something (ADR 018). None of that helps here. Every contradiction
above is internally about the README — a figure copied out of a terminal into
prose, made stale by a later run, and never re-read because from the author's
side nothing changed. They did not touch that paragraph.

That is the whole mechanism. A transcribed number has no link to its source, so
nothing can tell it has expired.

<!-- FILIP: a number in a README, runbook or dashboard description that was
     right when written and quietly went wrong — how long did it stay, and what
     decision did somebody make on it before anyone noticed? -->

## Decision

Figures live in one place and are rendered into the README.

Marked regions — `<!-- generated:run-block -->` and its siblings — are rendered
from `evals/published-figures.json`, which is itself regenerated from run
artifacts by `npm run readme:refresh`. Three blocks are covered: the full run
report (which carries the provenance summary and the uncalibrated-constant list
inside it), the semantic calibration table, and the judge calibration figures.

Nothing inside a marker is hand-edited. Everything outside is prose a human
writes and owns.

Four checks enforce it:

- every declared block is present and delimited;
- every block matches the committed figures exactly, so a stale README fails
  the build the way a stale baseline does;
- three named figures — suite score, semantic margin, judge MAE — appear
  nowhere in prose outside their block;
- the README does not deny a remote that exists.

`npm run readme:refresh --check` fails when the committed figures no longer
match the current artifacts, which is the form CI can run after an eval.

## Consequences

A figure cannot be stale and unnoticed. If a run changes it, either the README
is refreshed or the build fails.

**The prose guard is narrowed to three named figures, and that is a judgement
call.** "Any number that also appears in a generated block" is unusable: the
blocks contain `0.05`, `1.00`, `3` and `5`, which occur legitimately throughout
the prose — in the description of the floor constant, in the Quickstart snippet,
in ordinary sentences. A check that broad would be disabled within a week, or
would train people to reword around it. Three figures is the set that actually
went stale. A fourth that goes stale later will not be caught until somebody
adds it.

**It found a leak immediately.** The judge MAE was hand-copied into three more
places — the Status checklist and two Known-limitations entries. Those now
point at the generated block instead of restating it, which costs the reader a
scroll and buys the number one home.

**A figure that is not generated may not be published as a number.** The judge
self-consistency spread was quoted in prose and had no artifact behind it, so
it was reworded to point at the command rather than state a value. That is a
real loss of at-a-glance information, accepted because the alternative is a
number nothing keeps honest.

**Removing a number can introduce a falsehood, and did.** The Before/After
section said two consecutive runs "differed in the third decimal". They differed
in the second, by about two percent — the block above it showed 0.972 against a
headline of 0.953. The earlier wording named both figures and was correct;
genericising it to avoid a stale number made it wrong, and wrong in a way no
check catches, because there is no longer a figure to compare against anything.

So the rule is not "prefer vague prose to stale numbers". It is: **either the
figure is anchored and stated, or the sentence does not characterise a magnitude
at all.** A number with a committed file behind it is safer than an adjective
with nothing behind it, and "differed in the third decimal" is an assertion
about a quantity wearing the clothes of a hedge.

**The markers are load-bearing and invisible in rendered Markdown.** Delete one
and `applyBlocks` throws rather than silently writing the content somewhere
plausible — but a reader editing the README in a browser sees nothing warning
them.

**Refreshing requires artifacts, so it requires a run.** `readme:refresh` fails
with an explanatory error rather than emitting an empty block, which means a
contributor without an API key cannot refresh the live figures. That is honest
and it is friction.

## Alternatives rejected

**Re-read the README carefully before publishing.** This is the fifth
occurrence; three previous rounds of exactly this were what produced ADR 017.
The README was read carefully, several times, by the person who had written
every one of the stale numbers.

**A spell-check-style linter for stale-looking figures.** Nothing distinguishes
a stale number from a current one by inspection — that is the entire problem.

**Move all figures out of the README into a linked report.** Solves it by
deleting the thing that makes the README worth reading. The numbers are the
evidence; a project arguing that evals should be visible in the pull request
cannot hide its own results behind a link.

**Generate the entire README.** The prose is the argument and a human writes
it. Only the figures are mechanical, and the marker boundary is where that line
actually falls.
