# 011. The judge is calibrated against human labels

Date: 2026-08-19
Status: Accepted, and now measured. Its sampling guidance is superseded by 014:
judge k defaults to 1, not 3.
Evidence: MEASURED, 2026-08-19. `npm run calibrate` against claude-opus-5 over
          n=8 hand-labelled cases: mean absolute error 0.031, mean signed error
          +0.006. A second run of the identical set gave MAE 0.019 and signed
          -0.006 — so the MAE is itself noisy at this n, and the sign of the
          bias flipped between two runs an hour apart. Read 0.02–0.03 as the
          figure and treat any claim about its direction as unsupported.
          Judge self-consistency measured separately (ADR 014): mean spread
          0.031 at k=5, maximum 0.10, nothing contested.
          The labels remain ONE PASS BY ONE ANNOTATOR over eight cases, and two
          of them (cal-hallucinated-name-01, cal-prose-not-json-01) are
          contested judgement calls — the judge landed 0.10 below the human on
          the first and matched exactly on the second. An MAE against unreviewed
          labels measures agreement with one person.
          What would still count: a second annotator, and more than eight cases.

## Context

`llmJudge` is the only scorer that can grade "is this a good answer to an
ambiguous question", which is the class of case the deterministic scorers cannot
touch. It is also the only scorer that is itself a probabilistic system with
unknown accuracy.

That combination is the trap. Adopting a judge does not remove the unmeasured part
of a pipeline — it moves it one level down and attaches a number to it, which is
strictly worse, because now there is a figure in the baseline that looks like a
measurement and is being compared against a threshold and gating a merge.

Nothing else in this repo trusts an unmeasured number. ADR 010 counts the
thresholds. ADR 009 pins the models. A judge adopted on the strength of "the
outputs look reasonable" would be the largest unexamined assumption in the system,
sitting in the same column as `exactFields`.

I have no numbers here. I've simply observed an informal, nine-month sequence for three
patterns. Review missed a guard that was far too loose for real transaction volume; review
missed a validator which threw a legitimate admin transaction for a block. Static analysis
caught three inaccurate docblocks where review had signed off in ignorance. Across all that
time I struggle to recall ever both finding anything of the same class, which suggests both
are needed.

## Decision

We measure the judge against human labels before trusting it.

`evals/calibration/` holds eight cases, each pairing a **frozen** subject output
with a score assigned by hand and a `humanReason` that is never shown to the
judge. They span the range deliberately: clearly right, clearly wrong,
hallucinated-but-fluent, and genuinely borderline.

`npm run calibrate` runs the judge against those same outputs and reports mean
absolute error against the human labels, mean signed error, and the cases where
the two diverge most.

The outputs are frozen because otherwise a changed score could mean the judge
drifted or the subject did, and the measurement would be uninterpretable.

One supporting decision follows from the same argument: the judge defaults to a
different model than the subject.

A second one has since been reversed. This record originally said the judge runs
k times per output and the median is taken. It does not, by default —
[ADR 014](014-judge-and-subject-sampling-are-not-multiplied.md) sets k to 1,
because medianing k verdicts inside a case records a stability production does
not have. When k > 1 the median is still what is taken, and judge variance is
measured by `npm run judge:variance` instead.

## Consequences

The MAE is what makes the judge's scores admissible. A judge at 0.08 is a usable
instrument; one at 0.35 is a random number generator with good manners, and no
amount of prompt engineering elsewhere in the suite fixes that.

Separating mean absolute from mean signed error separates two problems that need
different fixes: a judge uniformly too generous is miscalibrated and correctable
by moving a threshold; one off in both directions is noisy and is not.

The costs:

The labels are one person's judgement on eight cases. MAE against a small
hand-labelled set is itself an estimate, with its own error, on a set the author
chose — a floor on honesty, not a certificate. If the labels are wrong, the number
measures agreement with a wrong answer.

Self-consistency multiplies the judge's cost by k, and the samples run
sequentially, so a judged suite is roughly k times slower and k times more
expensive than a single-shot one.

And the calibration set is maintenance. Every rubric change can invalidate labels
that were correct for the old rubric.

## Alternatives rejected

**Trust the judge.** The default, and the reason LLM-judged suites acquire a
reputation for producing numbers nobody acts on. It substitutes the judge's
plausibility for its accuracy.

**Use the same model as the subject.** A model grading its own output shares its
blind spots: if the subject misreads an ambiguous email in a particular direction,
the same model asked to grade that reading finds it reasonable, because it is the
reading it would have produced. Agreement then measures that the two systems are
one system. `llmJudge` records `sameModelAsSubject` and says so in the reason when
it happens.

**Calibrate against a large generated label set.** Labels generated by a model to
measure a model is the same circle drawn wider. Eight labels a human argued over
are worth more than eight hundred nobody read.
