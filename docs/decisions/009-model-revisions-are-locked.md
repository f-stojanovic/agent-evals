# 009. Model revisions are locked

Date: 2026-08-19
Status: Accepted. Implemented for the embedding model; the `judge` slot exists in
the lockfile type but nothing writes it yet.

## Context

Two scorers depend on a model of their own rather than on the subject: the
semantic scorer runs a sentence encoder, and the judge calls an LLM. Both produce
numbers that land in the baseline beside numbers from deterministic scorers, on
the same 0..1 scale, with nothing marking them as coming from somewhere else.

A cosine similarity is only comparable to another cosine similarity from the same
encoder. Change the model, the revision, or the quantisation and every semantic
score in the suite shifts at once — uniformly, quietly, and in exactly the shape
of the subject getting worse. The same holds for a judge across model versions.

This is the most expensive false positive a harness like this can produce, because
it is indistinguishable from the true positive the harness exists to find. The
concrete cost is an afternoon spent bisecting prompt changes to explain a
regression caused by `npm update`.

<!-- FILIP: add the concrete experience here — what you saw, where, what it cost -->

## Decision

We record model identity in a committed `models.lock.json`:

```json
{ "embedding": { "modelId": "Xenova/all-MiniLM-L6-v2", "revision": "…", "dtype": "fp32" } }
```

The first run resolves the revision from the Hugging Face API and writes the file.
Every later run compares against it and fails on a mismatch of model id, dtype, or
an explicitly requested revision. The lock is checked before the model loads, so a
mismatch fails in milliseconds rather than after a download.

A revision that cannot be resolved is recorded as `null`, never invented. Every
score from a model-backed scorer also carries its locked identity in `Score.meta`,
so a number never travels without the thing that produced it.

## Consequences

A model upgrade becomes an explicit, reviewable change: a lockfile diff and a
baseline diff in one commit, which is ADR 002's mechanic applied one level down. A
silent upgrade becomes impossible rather than merely unlikely.

The costs:

The first run needs network access and writes a file, so a cold offline run
records `revision: null` and is honestly marked as unpinned rather than failing.
That is a weaker guarantee than the lockfile appears to offer.

The guarantee is also incomplete in a way worth stating plainly: the lockfile
catches the model changing, but nothing yet stops a run being compared against a
baseline recorded under a *different* lock. Until the gate checks that too,
updating the lock silently invalidates every recorded semantic score. This is
tracked as a TODO in `src/scorers/semantic.ts`.

And the judge is not locked at all yet. ADR 011 depends on it being locked, and
the slot is defined but unwritten.

## Alternatives rejected

**Pin a revision hash in source.** The hash has to be written by hand, and a hash
nobody verified is worse than no pin: it looks like a guarantee. An earlier
version of this repo did exactly that, and the hash was invented.

**Pin by tag or branch (`main`, `v1`).** A moving target that can be repointed
upstream without any local change. It records an intention to pin rather than a
pin.

**Record the model version in the run report only.** Detects the change after a
run has been spent, and only if someone reads the report closely enough to notice
a string that looks the same as it did last week. The lockfile fails the run
instead, which is the difference between a control and a note.
