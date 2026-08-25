# 022. A case mean is a summary, and a gate must not screen on a summary

Date: 2026-08-25
Status: Accepted. Baseline format v3; a v2 file is refused rather than screened
at half strength.
Evidence: THE MISS, MEASURED, 2026-08-24. `critical` was removed from the
          subject's urgency enum — one line, the tidy-up nobody reviews. The
          schema stayed valid, typecheck stayed clean, all 281 tests passed, and
          the model returned `high` on outage-escalation-01, where the email
          describes a production outage losing £4k an hour.
          `exact-fields` fell 1.00 → 0.75, five samples of five. The case mean
          fell 0.850 → 0.774, a delta of 0.077 against a tolerance of 0.087.
          **GATE: PASS**, cleared by 0.010.
          Not bad luck. The case is graded by three scorers and averaged, so one
          wrong field of four is 0.25/3 = 0.0833 on the mean — the MAXIMUM a
          single-field regression can move it, against a tolerance of 0.087. No
          single-field regression on that case was detectable at all, whatever
          the field. Two fields would have been (0.167) and would have cleared
          it easily.
          THE CATCH, MEASURED, 2026-08-25. The identical defect against the
          identical suite, with the per-scorer screen in place:
          **GATE: FAIL — 1 regression (1 in a single scorer, with the case mean
          inside tolerance)**. `exact-fields` 1.000 → 0.750, delta -0.250,
          tolerance ±0.100. The case mean moved -0.080 against ±0.096 and was
          correctly reported as unchanged by the screen that looks at means.
          The enum was restored and verified byte-identical; the run after it
          passed.

## Context

This is the fourth time this repository has reported two measurements as one
number, and the first time it did so in the gate itself.

`exactFields` mixed recall with precision, and was separated. The report mixed
the below-threshold tally with the gate verdict, so a run could print "3 of 5
below threshold" beside **GATE: PASS** and read as broken; they were separated.
A judge rubric mixed whether the content was right with whether the format was,
and ADR 019 separated those into a scorer each. Each time the fix was the same
shape: two questions were being answered with one figure, and the figure
answered neither.

The gate had the identical defect and it survived three rounds of looking at
it, because a case mean does not look like a conflation. It looks like the
score. But `CaseResult.value` is an unweighted mean over the scorers that ran,
so a case graded by six scorers reports any single-scorer movement at one sixth
of its size, and the tolerance it is compared against was calibrated for the
mean's noise rather than for the part's.

The per-scorer values had been recorded in the baseline since v2 and were never
read by anything. The file said `{"exact-fields": 1, "semantic-similarity":
0.55134, "format-compliance": 1}` and the comparison computed
`caseResult.value - recorded.mean`. Everything needed to catch the regression
was committed, in the diff, in front of the reviewer, and unused.

## Decision

We screen the parts as well as the summary. A regression in any single scorer
fails the build, whatever the case mean did.

`BaselineCase.scorers` becomes `{ mean, stdDev }` per scorer rather than a bare
number, because a screen needs a noise estimate and the case-level `stdDev`
describes the spread of the mean rather than of any scorer in it. The runner
computes per-scorer spread across samples alongside the per-scorer means it
already computed.

The rule is the same one the case screen uses — `floor + z·se`, and a drop
below it is a regression — applied per scorer.

**A scorer regression is a regression even where the case mean improved.** Two
scorers moving opposite ways cancel in the mean, and reporting a case as green
because two numbers happened to sum to zero is the same defect this record
exists for, wearing a different disguise.

### The floor, which is a guess and is declared as one

`baseline.scorerFloor = 0.10`, reported in the uncalibrated list with the other
guesses (ADR 010). Nothing measured says 0.10 is right. What can be said is why
it is not 0.05 and not 0.15, and both arguments are about arithmetic rather than
about any observation:

**Not 0.15 or above.** A case mean divides each scorer by the number that ran —
three, on the case this was built for. The case floor of 0.05 therefore already
demands roughly 0.15 per scorer before it will look at anything. A per-scorer
screen at 0.15 would add nothing the case screen does not have.

**Not 0.05.** `exactFields` on a four-field case moves in steps of 0.25 per
sample, so at n=5 its mean moves in steps of 0.05. A floor at 0.05 fires on one
field wrong in one sample out of five, which at these sample counts is as likely
to be the model being stochastic as it is to be a regression. The cheap
direction to be wrong in is the other one.

0.10 is half the case screen's effective per-scorer sensitivity and twice the
smallest move a deterministic scorer can make. `z·se` widens it for a scorer
that has demonstrated it needs the room.

**A deterministic scorer does get a tighter effective allowance than a noisy
one, and that is the intended behaviour rather than a side effect.** On the
current baseline `exact-fields` has stdDev 0.000 on four of five cases and gets
the floor and nothing more; `semantic-similarity` on outage-escalation-01 has
stdDev 0.097 and earns a tolerance of 0.223. The same 0.15 drop is a regression
in the first and noise in the second, which is exactly what the two numbers say
about themselves.

## Consequences

**A v2 baseline is refused, not degraded.** v2 records per-scorer means with no
spread, so it can support the case screen and not the scorer screen. Running the
new gate at half strength against an old file would report a pass that covered
less than it appeared to — which is the failure mode of this entire repository
in miniature. Both committed baselines were re-recorded.

**The verdict line and the regression list distinguish the two kinds.** A
scorer-only regression shows a case mean sitting comfortably inside its
tolerance, so a reader shown only the mean concludes the gate misfired and
dismisses a correct failure. The verdict says `1 regression (1 in a single
scorer, with the case mean inside tolerance)` and the entry names the scorer,
its own delta, and its own allowance.

**More things now fail the build, including some that should not.** A scorer
that is noisy in a way n=5 has not yet revealed will trip a 0.10 floor
eventually, and the first such failure will look exactly like a real
regression. The mitigation is the one the case screen already relies on: the
spread is recorded, so a scorer that demonstrates it moves gets the room the
next time the baseline is recorded. That is a slow correction and it is the
honest one.

**It does not catch a regression spread thinly across every scorer.** Six
scorers each dropping 0.09 trip neither screen: no scorer exceeds its floor, and
the case mean falls 0.09 against a tolerance that may well be wider. This
screen catches the concentrated case, which is the one the mean hides. The
diffuse case is what the mean was always good at, and the two are complementary
rather than one being a replacement.

**The uncalibrated count went from 4 to 5.** That is the honest direction for it
to move when a guess is added, and the point of counting them at all.

## Alternatives rejected

**Lower the case-level floor instead.** Cheaper, and it treats the symptom.
Dropping the case floor to 0.02 would have caught this defect and would fire on
every case whose mean drifts by ordinary sampling noise, because the case mean's
noise is exactly what the floor was sized for. The problem was never that the
tolerance was too generous; it was that the quantity being screened had the
signal averaged out of it before the comparison happened.

**Weight the scorers so the important ones dominate the mean.** Moves the
arbitrary decision rather than removing it, and makes every case mean depend on
a weighting nobody measured. It also does not fix the failure: whichever scorer
is weighted lowest becomes the one whose regressions are invisible, and now
there is a table of numbers explaining why that was intentional.

**Screen only the deterministic scorers, where noise is not a confound.** Tidy,
and it exempts precisely the scorers whose regressions are hardest to see. A
gate with a silent exemption list is worse than one with none, because nobody
knows which rows they can trust — the same argument ADR 007 makes against
caching only the cheap cases in CI.

**Report per-scorer drops as a warning rather than failing.** A warning in CI
is a line of output nobody reads. This project's whole argument is that an eval
result which cannot block a merge is an eval result nobody looks at; applying a
weaker standard to its own gate would be the position collapsing at the first
inconvenience.

**Record per-sample per-scorer values in the baseline so the spread is
recomputable.** Rejected by ADR 003: five numbers per scorer per case per run
makes the diff unreadable, and a baseline nobody reads is a rubber stamp. The
summary statistic is what a reviewer can actually check.
