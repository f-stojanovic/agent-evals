# 015. Test-data provenance is typed, not described

Date: 2026-08-19
Status: Accepted
Evidence: This repository, commit `12518c4`. That commit added
          `src/fixtures.ts` with the doc comment "This is not a mock in the
          testing sense. The recorded outputs are real responses from a real
          model, frozen", and `evals/fixtures/support-extraction.yaml` with the
          header "These are frozen responses, not hand-written mocks". Both
          claims were false when written. The fixtures were hand-authored in
          the same session, by the same author, as the sentences asserting they
          were not. The claims survived two further commits and were caught
          only when a separate pass forced every statement in the repository to
          be checked against what had been executed.
          The fix is verified by src/provenance.test.ts: a fixture with no
          provenance fails to load, and a hand-authored entry cannot name a
          model.

## Context

The fixtures replayed by the per-push CI gate were described in a doc comment
as captured from a real model. They were written by hand.

Nothing about that was malicious and nothing caught it. It was a
plausible-sounding claim about where data came from, placed in a comment, and
comments are not reviewed against reality — they are read as context by
somebody who has already decided to trust the file. The claim was even load
bearing: it was the argument for why replaying fixtures in CI proved anything.

A false provenance claim is not the same kind of error as a documented
limitation. A limitation is a fact a reader can price in. A false claim about
where data came from makes every number derived from that data uninterpretable,
and worse, it tells the reader that the repository's other claims were not
checked either. Of everything in this project, it is the one category of error
that invalidates the rest.

The hardcoded date test — the same one from ADR 005, read here for what it claimed
rather than for how it passed — wasn't just using a value, it was making an assertion: it 
said this date was in the future, because it was, when written. That assertion simply 
became untrue without anyone touching the file, and yet it didn't break Anything™ in 
the test. And now it just continued to pass with the wrong values for a duration I can’t 
figure out fromgit. That’s the character of the failure: not wrong data, but a claim which 
was true when written and was never re-validated.

## Decision

We make provenance a required, typed field on every fixture and every
calibration case:

```ts
type Provenance =
  | { kind: 'hand-authored'; author: string; note?: string }
  | { kind: 'recorded'; model: string; revision?: string; capturedAt: string };
```

The schema rejects an entry that omits it, so adding test data without saying
where it came from is a load-time error. The two arms are structurally
different: a hand-authored entry has no field to put a model name in, and a
recorded one cannot omit `capturedAt`. Passing hand-written data off as a
recording now requires deliberately writing `kind: 'recorded'` and inventing a
capture date, rather than leaving an adjective unchallenged.

Every entry declares which it is. The calibration cases are `hand-authored`.
The fixtures were too when this record was written; they have since been
re-recorded from a live run and now declare `recorded`, with a model and a
capture date — which is the first time the `recorded` arm has been used by
anything in the repository.

The report prints the tally on every run, and says so outright when nothing was
recorded: *"every input was written by hand. This run exercised the harness,
not the model that would produce these responses."*

## Consequences

The claim is now checkable from the file, by a schema, on every load. It cannot
drift from the truth without somebody typing a lie.

It also becomes visible where it matters. The provenance of the calibration set
is printed next to the MAE it produced — which makes plain that the measured
0.031 is agreement between one judge and one annotator, on outputs that same
annotator invented. That was always true and it was only ever stated in an
Evidence line.

The costs:

**Every new fixture is more work to add**, and the friction is on the honest
path as much as the dishonest one. That is accepted: the field is three lines
and the failure it prevents cost a full audit pass to find.

**A typed field records what the author believed, not what is true.** Somebody
can still write `kind: 'recorded'` on invented data. This raises the cost of
being wrong from "leave a comment unchecked" to "type a false statement into a
required field", which is a real difference and not a guarantee.

**It made the underlying gap visible, and the gap was then closed separately.**
When this was written the fixtures were hand-authored, so the per-push gate
replayed a format distribution the live subject did not have. Printing that on
every run is what made it obvious enough to fix: the fixtures are now captured
from a live `claude-sonnet-5` run and the report says
`3 recorded from claude-sonnet-5`. The typed field did not do the fixing — it
did the not-letting-anyone-forget.

## Alternatives rejected

**Correct the comment.** The obvious move, and it fixes exactly one instance.
The next comment asserting a fact about data has the identical failure mode,
because nothing about a comment makes it checkable. Fixing the sentence would
have left the mechanism that produced it fully intact.

**A lint rule on comment wording** — flagging "real", "recorded", "captured" in
files under `evals/`. Unenforceable in any useful sense: it cannot tell a true
claim from a false one, only that a word appeared, so it would produce noise on
correct comments and miss a false claim phrased differently.

**Infer provenance from the data.** A recorded response and a hand-written one
are not reliably distinguishable — that is precisely why the comment went
unchallenged for three commits.

**A CONTRIBUTING note asking authors to state provenance.** A convention that
nothing enforces is a convention that decays, and this ADR exists because a
convention already decayed.
