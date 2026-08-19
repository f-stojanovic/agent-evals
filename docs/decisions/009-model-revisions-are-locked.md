# 009. Model revisions are locked

Date: 2026-08-19
Status: Accepted. Implemented for both the embedding model and the judge.
Evidence: Partial. The lock logic — writing on first run, failing on a
          changed model id or dtype, recording an unresolvable revision as null
          — is covered by src/models-lock.test.ts against an injected resolver.
          Nothing has exercised it for real: models.lock.json has never been
          written, no revision has ever been resolved from the Hugging Face
          API, and the judge slot has never been populated by a live call.
          The temperature claim is verified against the current API
          documentation, not against a 400 this repository received.

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
{
  "embedding": { "modelId": "Xenova/all-MiniLM-L6-v2", "revision": "…", "dtype": "fp32" },
  "judge":     { "modelId": "claude-opus-5", "revision": null, "dtype": "hosted" }
}
```

A hosted model exposes no revision to resolve and no quantisation to record, so
the judge entry pins the model id and records `null` for the rest. That is a
weaker pin than the encoder's and it is the true one: it still catches the
change that moves every judge score at once.

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

The judge's pin is weaker than it looks. `claude-opus-5` is a moving target on
the provider's side: the same id can be served by a different build than it was
last month, and nothing local detects that. The lockfile catches somebody
changing the id; it cannot catch the id changing underneath us.

## A note on temperature

The conventional way to make a judge reproducible is `temperature: 0`. On
current Claude models that parameter has been removed — Opus 5, Sonnet 5, and
the 4.7/4.8 family reject it with a 400. There is no determinism knob left to
set.

That is not a footnote, it is a second consequence of this decision. Pinning
the model removes one source of drift; nothing removes the run-to-run variance
that used to be suppressed with a sampling parameter. The only honest response
left is to measure it.

An earlier version of that response was wrong in an instructive way: `llmJudge`
declared `minSamples: 3`, forcing the runner to sample judged cases at least
three times as well. [ADR 014](014-judge-and-subject-sampling-are-not-multiplied.md)
supersedes it — averaging the judge inside a case records a stability
production does not have. Judge variance is now measured by its own command,
and it turns out to be small: mean spread 0.031 at k=5.

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
