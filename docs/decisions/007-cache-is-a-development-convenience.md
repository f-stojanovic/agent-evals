# 007. The cache is a development convenience, not a source of truth

Date: 2026-08-19
Status: Accepted
Evidence: Partial. The cache exists and its rules are covered by
          src/runner.test.ts — a hit is reused, a retry bypasses it, and the
          CLI refuses `--cache` in CI or alongside `--update-baseline`. The
          argument the rules exist to prevent is unobserved: no baseline has
          ever been recorded from replayed responses, so nothing here has been
          seen to stay green through a model change it should have caught.

## Context

Iterating on a suite means running it repeatedly against inputs that have not
changed. Without a response cache, editing one scorer and re-running costs the
full price of every subject call in the suite, which is slow enough that people
stop re-running and start guessing.

So a cache will exist. The question is what it is allowed to do, and the pressure
runs one way: caching is most valuable exactly where it is most dangerous. CI runs
are the most frequent, the most expensive, and the most tempting to speed up.

Two situations make it dangerous. A retry exists to re-roll a sample from a
stochastic system; serving the cached response returns the identical failure and
makes the retry a no-op that costs wall-clock and proves nothing. And a baseline
assembled from replayed responses is a record of the cache's contents, not of the
model's behaviour — it would stay green across a model upgrade, a prompt change,
and a provider incident alike.

<!-- FILIP: add the concrete experience here — what you saw, where, what it cost -->

## Decision

We treat the cache as a local development tool and nothing else.

`attempt > 0` always bypasses it. Baseline recording and CI runs disable it
entirely, including on attempt 0.

The rule the cache lives under is recorded on `SubjectContext.attempt`: the
request sent to the model must be byte-identical across attempts — same prompt,
same parameters, same tool definitions — while everything outside that request,
including cache behaviour, transport, timeouts, and logging, is free to differ.
The line is drawn at the request because that is what a baseline describes.

## Consequences

A recorded baseline always reflects the model, so a green CI run means the model
passed today rather than that it passed once in March.

The cost is paid in money and wall-clock on exactly the runs that happen most. CI
re-runs the whole suite from scratch on every pull request, including for changes
that cannot possibly affect the subject — a README edit pays full price for the
gate. That is a standing, recurring cost with an obvious-looking fix, and the fix
is the thing this ADR exists to forbid.

The second-order cost is that someone will eventually propose caching in CI to cut
the bill. This document is the answer.

## Alternatives rejected

**Cache in CI for speed.** A baseline built from replayed responses records the
cache's behaviour, not the model's. The gate would keep passing through precisely
the events it exists to catch.

**Cache in CI with a short TTL.** Reduces the window without changing the
property: within the window the gate is still validating a recording. It also
makes failures non-reproducible, since whether a run measured the model now
depends on when it started.

**Cache only "cheap" cases in CI.** Splits the suite into cases the gate
guarantees and cases it does not, with no marker in the baseline saying which is
which. A gate with a silent exemption list is worse than one with none, because
nobody knows which rows they can trust.
