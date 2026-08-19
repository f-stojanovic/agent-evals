# 014. Judge sampling and subject sampling are measured separately, not multiplied

Date: 2026-08-19
Status: Accepted. Supersedes the `minSamples: 3` rule introduced alongside ADR 009.
Evidence: The judge's own spread is now measured: `npm run judge:variance` at
          k=5 over eight fixed outputs gives a mean spread of 0.031 and a
          maximum of 0.10, with nothing above the 0.25 disagreement threshold.
          The subject's spread is measured separately by the suite run: 0.024
          on the judged case, 0.000 on the two deterministic ones.
          None of that has been observed under the superseded rule, because it
          was removed before a live run happened. The artificial-stability
          argument below is arithmetic, not observation. What would count:
          recording one baseline both ways and comparing the recorded stdDev.
          <!-- FILIP: if you have seen a metric look healthier than production
               because of how it was aggregated rather than because anything
               improved, that is the experience this ADR generalises. Add it. -->

## Context

Two different things vary, and an earlier version of this repository conflated
them.

`llmJudge` takes k verdicts on one output and medians them, to defend against a
single wild verdict. The runner takes n samples of a case, each a fresh
generation, to measure how much the subject varies. Both are reasonable. The
mistake was requiring both at once: `llmJudge` declared `minSamples: 3`, which
forced the runner to take at least three subject samples for any judged case,
on top of its own three verdicts. Nine judge calls per case, and the reasoning
was that a single verdict from a probabilistic grader is an anecdote.

That reasoning is correct and the combination was still wrong.

## Decision

Judge k defaults to 1 in a normal run and when recording a baseline. The
runner's sample count measures the subject and nothing else. `llmJudge`
declares no `minSamples`.

Judge variance gets its own command, `npm run judge:variance`, which holds the
output fixed and asks the judge k=5 times. There, averaging is the goal rather
than a contaminant, because the only thing that can move between votes is the
judge.

## Consequences

The number recorded in the baseline is a draw from the distribution production
sees. That is the point.

**The failure this avoids.** Median k verdicts inside a case and what lands in
`sampleValues` is not one draw — it is an average of k, and averaging shrinks
variance by roughly √k. The baseline then records a case as more stable than it
is. ADR 012 derives the regression allowance from exactly that recorded spread,
so the suite issues itself a tolerance too tight to be met and too flattering
to be true. A baseline that looks steadier than production is the worst failure
an eval suite has: every number downstream inherits it, and nothing about it
looks wrong.

**The cost.** A single verdict per sample is noisier than a median of three. On
a case where the judge genuinely wavers, one vote can land at either end, and
the suite will see that as subject variance when some of it is the judge. The
two commands together are what separate them; neither alone does.

**A second cost.** Judge variance is now measured on demand rather than
continuously, so a rubric that starts confusing the judge shows up only when
somebody runs `judge:variance`. Nothing schedules it.

## Alternatives rejected

**Keep `minSamples: 3`.** Nine judge calls per case for a number that is worse
than the one call produces. The cost was the smaller objection.

**Median the judge but record the individual verdicts and reconstruct the
unaveraged spread later.** Possible, and it puts a reconstruction step between
the run and the baseline for no gain — if the individual verdicts are what the
baseline should reflect, take one.

**Sample the judge once but n times more at the runner level to compensate.**
This is the superseded rule with extra steps: it still averages, just further
up, and it still records a spread that mixes the two sources.
