# 012. The regression tolerance is derived from measured variance

Date: 2026-08-19
Status: Accepted
Evidence: Partial, and now operating on one real number. The live baseline of
          2026-08-19 records a genuine per-case spread for the first time: the
          judged case measured stdDev 0.024 over n=5 and was granted a ±0.082
          allowance, while the two deterministic cases measured 0.000 and got
          the ±0.050 floor. The mechanism did what it exists for — a wider
          allowance where variance was demonstrated — on live data.
          One noisy case out of three is not a demonstration that the scaling
          is right, only that it engages. src/baseline.test.ts still supplies
          every other stdDev it is tested against.
          What would still count: a suite where the noisy and stable cases
          disagree about whether a drop is real.
          <!-- FILIP: if you have had a threshold-based gate that flapped until
               someone disabled it, that is the experience this ADR is built
               on. Add what the threshold was and how long it survived. -->

## Context

ADR 002 fails the build when a case regresses. That requires a definition of
"regressed", and the obvious one is a constant: fail if a case drops more than
0.05.

The constant is a guess about how much a case moves on its own, applied
uniformly to cases whose real variance differs by an order of magnitude. Set it
loose enough for the noisiest case in the suite and it stops catching
regressions on the stable ones. Set it tight and the noisy cases flap until
somebody switches the gate off. Either way the threshold is doing work that
measurement should be doing, and ADR 010 already says what this repository
thinks of numbers nobody measured.

We already record what is needed to do better. Every case carries `stdDev` and
`n` on both sides of the comparison, because ADR 002 put them in the baseline
before any baseline existed.

<!-- FILIP: add the concrete experience here — what you saw, where, what it cost -->

## Decision

We compare two estimates rather than a number against a constant. Both the
baseline mean and the current mean are estimates with their own spread and
sample count, so the allowance comes from the standard error of their
difference:

```
se = sqrt(baseline.stdDev² / baseline.n + current.stdDev² / current.n)
```

and a case regresses when

```
current.mean < baseline.mean − z·se − floor
```

`z` defaults to 2. `floor` defaults to 0.01 and covers the degenerate case
where both spreads are zero. The report prints the derived tolerance next to
every delta, so a passing case shows by how much it passed.

## Consequences

A case scoring 0.95 ± 0.01 gets almost no allowance, and a drop to 0.90 fails
it — which a fixed 0.05 tolerance would have waved through. A case scoring
0.60 ± 0.35 gets a wide allowance because it earned one. One number stops
having to be right for both.

The costs are real:

**It is not a hypothesis test and must not be described as one.** It assumes
per-case scores are roughly normal, which for a bounded 0..1 score that piles
up at the ends is false. It uses a normal quantile at sample sizes of three or
five, where a t-distribution is the textbook choice. It applies no correction
for testing every case in a suite at once, so across a hundred cases a few will
trip on noise alone. This is a pragmatic screen that scales its allowance to
measured variance, and saying so in the doc block is cheaper than having
somebody infer rigour from the square root.

**It degenerates to the constant it replaced when `n` is 1.** With one sample
there is no spread, `se` is zero, and only the floor remains. So the whole
mechanism is worth exactly as much as the sampling that feeds it, and sampling
multiplies the cost of a run.

**`z` and `floor` are themselves uncalibrated constants** — smaller and better
placed than a raw tolerance, but still guesses, and they are not currently
routed through the ADR 010 reporting.

## Alternatives rejected

**A fixed absolute tolerance.** Cannot be right for a suite containing both a
deterministic extraction case and an ambiguous judged one. Whichever way it is
set, it is wrong for half the suite.

**A fixed relative tolerance (5% of the baseline mean).** Scales with the score
rather than with the noise. A case at 0.95 that never moves and a case at 0.95
that swings weekly get the same allowance, which is the same failure in
percentage clothing.

**A proper statistical test — Welch's t, or a bootstrap.** More defensible in
principle and rejected on honesty grounds: at n=3 the assumptions it would need
are no better met than the ones here, and the output would carry a p-value that
invites more confidence than the underlying data supports. If the sample counts
ever justify it, this is the first thing to revisit.
