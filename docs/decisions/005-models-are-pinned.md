# 005 — Embedding and judge models are pinned; scores are not comparable across revisions

**Status:** accepted

## Context

Two scorers depend on a model of their own rather than on the subject: the
semantic scorer runs a sentence encoder, and the judge calls an LLM. Both
produce numbers that go into the baseline next to numbers from deterministic
scorers, on the same 0..1 scale, with no visible marker distinguishing them.

A cosine similarity is only comparable to another cosine similarity from the
same encoder. Change the model, the revision, or the quantisation and every
semantic score in the suite shifts at once — uniformly, quietly, and in exactly
the shape of the subject getting worse. The same holds for a judge across model
versions.

This is the most expensive false positive an eval harness can produce, because
it is indistinguishable from the true positive the harness exists to find. An
afternoon spent bisecting prompt changes to explain a regression caused by
`npm update` is the concrete cost.

## Decision

Model identity is recorded in a committed `models.lock.json`:

```json
{ "embedding": { "modelId": "...", "revision": "...", "dtype": "fp32" } }
```

The first run resolves the revision and writes the file. Every later run
compares against it and **fails** on a mismatch, with a message saying that
scores are not comparable across revisions and that the fix is to update the
lock and re-record the baseline in the same commit.

A revision that cannot be resolved is recorded as `null`, never invented. A
fabricated hash would claim a guarantee the run did not have.

Every score from a model-backed scorer carries its model identity in
`Score.meta`, so a number is never separated from the thing that produced it.

## Consequences

- A model upgrade becomes an explicit, reviewable change: a lockfile diff and a
  baseline diff in one commit. This is the same mechanic as ADR 002, applied
  one level down.
- A silent upgrade becomes impossible rather than merely unlikely.
- First run needs network access to resolve the revision, and writes a file.
  Offline first runs record `null` and are honestly marked as unpinned.
- **Not yet enforced end to end.** The gate must also refuse to compare a run
  against a baseline recorded under a different lock. Until that exists,
  changing the lock silently invalidates recorded semantic and judge scores —
  the lockfile catches the model changing, not the baseline going stale
  against it. This is tracked as a TODO in `src/scorers/semantic.ts`.

## A note on temperature

The conventional way to make a judge reproducible is `temperature: 0`. On
current Claude models that parameter has been removed — Opus 5, Sonnet 5, and
the 4.7/4.8 family reject it with a 400. There is no determinism knob to set.

This is not a footnote; it changes the design. With sampling controls gone, the
only honest response to judge variance is to measure it, which is why the judge
runs k times and takes the median while recording the spread. Pinning the model
and measuring the spread are the two halves of the same replacement for a
setting that no longer exists.

## Alternatives rejected

**Pin a revision hash in source.** Rejected: the hash would have to be written
by hand, and writing one that was never verified is worse than not pinning —
it looks like a guarantee.

**Use a hosted embedding API and pin the model name.** Rejected: a suite that
needs a third-party key to pass CI fails for reasons unrelated to the subject,
and a gate that cries wolf gets disabled. See the local-embeddings rationale in
`src/scorers/semantic.ts`.

**Record the model in the baseline only.** Rejected: that detects the change
after a run has already been spent, and only if someone reads the diff
carefully. The lockfile fails before the model loads.
