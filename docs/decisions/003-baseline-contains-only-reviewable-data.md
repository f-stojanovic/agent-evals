# 003. The baseline contains only what a human can review

Date: 2026-08-19
Status: Accepted
Evidence: Partial. src/baseline.test.ts asserts that raw provider output and
          per-sample values never reach the recorded file. The three reasons
          are untested at scale: the committed baseline is 727 bytes over three
          cases, so neither the reviewability argument nor the size argument
          has met a suite large enough to strain it, and no real customer data
          has ever passed through this repository.
          What would count: a suite of a few hundred cases, and one diff a
          reviewer actually read.

## Context

ADR 002 makes the baseline diff the control. A control works only if someone
reads it, and the pressure on a file like this is always toward completeness:
store the raw responses so failures can be debugged later, store every sample so
the statistics can be recomputed, store the judge transcripts so the reasoning is
auditable. Each addition is individually defensible and collectively fatal.

Meanwhile the harness genuinely does need that material. `SubjectOutput.raw` is
preserved precisely so that a scorer written next year can read a field nobody
normalised today.

The two requirements are not in conflict once they are separated: keep everything,
persist a little.

## Decision

We record in the baseline, per case: the mean `value`, `stdDev`, the sample count
`n`, the per-scorer values, and the model identities the run used.

We do not put in the baseline: `SubjectOutput.raw`, `CaseResult.sampleValues`,
model output text, or judge transcripts. Those live in memory during the run and
in `.artifacts/` afterwards, which is gitignored.

`CaseResult.sampleValues` carries this rule in its own doc comment, so the next
person to add a field to the baseline meets the argument before they make the
mistake.

## Consequences

The baseline diff stays readable. A reviewer sees a column of numbers change and
can tell which cases moved and by how much.

Three reasons drive the exclusion, and each rules out a different thing:

**Reviewability.** Five raw sample values per case per run bury the two numbers
that matter. A diff a human skims is a control; a diff a human scrolls past is a
rubber stamp, and a rubber stamp is worse than no gate because it looks like one.

I saw an architectural rule engine with 38,835 baseline entries across three files 
ship, be demoted to non-blocking seven weeks later and replaced entirely three weeks 
after that. No human could diff something that big and no human did, so it just churned 
along creating new violations behind a gate that everyone had implicitly stopped reading. 
The replacement shipped with 3,147 entries and months later I could still find it
whitelisting two entirely deleted datastores, purely by chance and because the file was
tiny enough that one obviously wrong line stood out as… well, obviously wrong.

**PII.** Real eval inputs are customer emails, support tickets, scraped pages.
Provider responses quote them back. Committing raw output to a repository — often
a public one, as this one is — copies personal data into git history, where
deleting it means rewriting history.

**Size.** A suite of 200 cases at five samples each, with full transcripts, adds
megabytes per run to a file that is rewritten on every improvement. The
repository stops being cloneable long before anyone notices the file stopped
being readable.

The cost is that a baseline alone cannot explain a regression. Seeing that
`refund-damaged-item-01` fell from 0.95 to 0.60 tells you nothing about why, and
the artifacts that would tell you are not in git — so if CI did not retain them,
that information is gone and the case must be re-run. We accept re-running over
an unreadable diff.

## Alternatives rejected

**Store full transcripts in the baseline.** Fails all three tests above at once.
The debugging value is real but belongs in run artifacts, where nobody has to
read it to approve a merge.

**Store transcripts in the baseline but truncated.** Truncation picks the wrong
part in exactly the case you needed it, keeps the PII problem in full, and
still bloats the diff. It trades the benefit away and keeps the costs.
