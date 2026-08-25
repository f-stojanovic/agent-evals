# 013. CI is split between a fixture run and a live run

Date: 2026-08-19
Status: Accepted
Evidence: BOTH WORKFLOWS HAVE RUN, 2026-08-20, on
          github.com/f-stojanovic/agent-evals.
          `ci.yml` passed on push: typecheck, unit tests, and a full fixture
          eval, in 40 seconds, with no secret.
          `eval-live` was dispatched and FAILED — correctly, and usefully. It
          refused the committed baseline with "recorded in baseline format v1;
          this build writes v2 … re-record it" and exited 1. The guard from
          ADR 009/019 fired on real infrastructure rather than on a laptop,
          against a genuinely stale committed file, which is the first evidence
          that the gate works off this machine.
          The fixtures are RECORDED for three of five cases and hand-authored
          for two added without budget for a live run; each declares which, and
          the report prints the tally.
          A dispatched `eval-live` has since PASSED, 2026-08-24, against the
          re-recorded v2 baseline — both directions of the live gate now
          observed on real infrastructure.
          THE SCHEDULE HAS NEVER FIRED. The weekly cron (`0 3 * * 1`) was added
          2026-08-20 and the workflow was disabled from then until roughly
          14:00 UTC on 2026-08-24, so Monday 03:00 UTC passed while it was off.
          Nothing is wrong with the workflow and nothing was changed to fix it;
          the run history simply contains no `schedule` event, only two
          `workflow_dispatch` runs. Until one appears, "runs weekly" is
          configuration rather than evidence, and the README says so.
          What would still count: a scheduled `eval-live` that completes.

## Context

ADR 002 says the eval gate belongs in the pull request, because an eval nobody
is forced to look at is an eval nobody looks at. That argues for running the
suite on every push.

Running the real suite on every push is not possible, and pretending otherwise
would be the dishonest version of this repository:

- It costs money per push, including on pushes that change a README.
- It needs `ANTHROPIC_API_KEY`, which a fork does not have — so every external
  contribution would arrive with a red build it cannot fix.
- It is non-deterministic, so the same commit can pass and then fail, which is
  how a gate loses its authority.

There are two different questions here and they were being treated as one.
"Did this change break the harness?" is deterministic, free, and belongs on
every push. "Did the model get worse?" is none of those.

I made use of this split, I didn't engineer it. Static analysis, formatting, and the 
full test suite had a green light for every push; the smoke tests, requiring a real 
deployed app and the entire checkout process, were only ever triggered by manual
dispatch. The first tier which could run hundreds of times per day ended up defining for the 
team what it means for "it" to break. The second would run when some part of the system's 
release date felt imminent, which inevitably meant that the check would trigger late - a 
compromise they seemed to be ok with.

## Decision

We run two workflows.

**`ci.yml`** runs on every push and pull request: typecheck, unit tests, and a
full eval against a fixture subject that replays outputs in `evals/fixtures/`.
It exercises sampling, extraction, the baseline comparison and the exit code,
and it runs the scorers the example cases declare — `exactFields` on all three,
`llmJudge` on the one with a rubric. `matchesSchema` and `callsTool` are
registered but skipped, because no case declares `schema` or `toolCalls`, and
`formatCompliance` and `semanticSimilarity` are not registered at all.
Deterministic, free, no secrets, works on a fork.

**`eval-live.yml`** runs on manual dispatch and weekly, against real models,
with the cache disabled and the report uploaded as an artifact.

The two runs keep separate baselines — `evals/baseline.fixture.json` and
`evals/baseline.json`. They grade with different judge models, and ADR 009 says
scores from different judge models are not comparable, so one shared file would
fail a mismatch check on every run of whichever workflow did not record it.

The fixtures hold the subject still — the same device `evals/calibration/` uses
while measuring something else. Each declares where it came from in a required
`provenance` field, and the report prints the tally on every run
([ADR 015](015-test-data-provenance-is-typed.md)). They are now captured from a
live run; they were hand-authored until 2026-08-20, and an earlier version of
this paragraph claimed otherwise while they still were — a sentence that
contradicted this record's own Evidence line for two commits.

The judge is replayed too, so the self-consistency and disagreement paths stay
inside the per-push gate rather than being exercised only at night.

## Consequences

Every pull request gets a real signal about the machinery in seconds, and forks
are first-class.

The costs, stated plainly:

**The per-push gate cannot catch a model regression.** It runs against
recordings, so a model that got worse overnight passes it. That is the whole
trade, and it means the README must not imply the live gate runs on every
commit — this repository's differentiator is a CI gate, and overstating when it
fires would be exactly the kind of claim it exists to prevent.

**The fixtures go stale.** They are a snapshot of a model that has moved on, so
the per-push run gradually stops resembling the live one. Nothing currently
detects that drift or reminds anyone to re-record.

**A case with no fixture fails the fixture run**, which is deliberate — a
silently uncovered case is the failure mode ADR 005 exists to prevent — but it
does mean adding a case is a two-step commit.

**A model regression is found within a week, not within a push.** For a weekly
schedule that is the honest bound, and it is worse than what the README of a
lesser project would claim. Weekly rather than nightly is a cost decision: a
nightly live run bills every night for a subject that changes rarely. A project
shipping against this suite daily should tighten it.

## Alternatives rejected

**Real models on every push.** Costs, secrets, flakiness. A gate that goes red
for reasons unrelated to the change gets disabled, and then there is no gate.

**Real models on pull requests to `main` only.** Still needs the secret, so
still breaks for forks, and still bills for documentation changes.

**No fixture run — unit tests only on push.** Unit tests cover the parts in
isolation; nothing would exercise the assembled pipeline until the scheduled run.
The fixture run is the only thing that proves `runSuite`, the scorers, the
baseline comparison, and the exit code work together, which is precisely the
seam a refactor breaks.

**Mock the model with hand-written responses.** Cheaper to write and a
different thing: hand-written output is what the author imagines a model
produces, so the fixture run would stop exercising the messy cases — the
preamble, the fenced block, the ambiguous phrasing — that the extraction and
format code exists for.
