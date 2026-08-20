# 018. A check must prove it inspected something

Date: 2026-08-20
Status: Accepted
Evidence: The vacuous C1 injection, during the development of commit
          `546a268`. C1 checks that every `{@link Type.member}` resolves. To
          verify it worked, a defect was injected — and the injection replaced
          a string that did not occur in the file, so nothing changed, the
          check found no broken links because it found no links at all, and it
          reported pass. A second injection against a link that did exist
          produced the expected failure.
          The guard is verified in both directions: renaming the README's
          `## Status` heading makes C2 fail as vacuous rather than pass, and
          deleting one guard makes the meta-check name the unguarded test.
          All seven checks in `src/docs.test.ts` are green with a non-empty
          corpus.

## Context

The same bug has now appeared three times in this repository, wearing three
costumes:

1. **A suite that scores no case reports green.** A mistyped expectation key is
   read by nobody, the case runs, and the run passes having asserted nothing.
2. **A case no scorer measures reports green.** Every scorer skips it, each
   skip individually correct, and the case contributes a perfect score for
   checking nothing.
3. **A check with no corpus reports green.** C1 found zero `{@link}`s and
   concluded there were zero broken ones.

Each time it is emptiness read as success. ADR 005 refuses the first two. The
third arrived in the very file written to stop documentation drifting, which
made `src/docs.test.ts` the last place in the repository still able to be
silently vacuous — and the least likely place anyone would look, because it is
the thing that does the looking.

## Decision

Every check in `src/docs.test.ts` calls `expectNonEmptyCorpus(items, label)`
before asserting anything. It throws when the corpus is empty, with a message
naming what was expected and where it was looked for:

> This check inspected nothing: no scorer names found in the README `## Status`
> section (was the heading renamed?). That is a failure, not a pass — a check
> with an empty corpus cannot distinguish "no defects" from "never looked".

A meta-test reads this file's own source, finds every `it(` block, and asserts
each one calls the guard. It guards itself too.

## Consequences

The realistic failure is now caught. Nobody deletes a check; somebody renames a
heading, moves a directory, or changes a file extension, and a check that
located its corpus by name quietly starts inspecting nothing. That now fails
with a message pointing at the rename.

**The meta-test is syntactic.** It confirms the string `expectNonEmptyCorpus(`
appears in each block, not that the argument passed is the right corpus. A
check could guard a list it does not then inspect and still pass. That is a
weaker property than it looks, and it is the honest limit of a test that reads
source text.

**It is a check on checks, which is one level of indirection that has to earn
its place.** It earns it here because the failure it prevents is invisible by
construction: a vacuous check looks exactly like a passing one, in the file
whose entire job is noticing things.

**The guard does not extend to the rest of the suite.** `runner.test.ts` and
the scorer tests can still assert over empty arrays. Extending it everywhere
would be noise; the checks in this file are singled out because they locate
their inputs by name in files that change for unrelated reasons.

## Alternatives rejected

**Trust the injection discipline.** Verify each check by breaking the
repository on purpose, as was done for C1 and C4. It works and it is a ritual,
performed once by the person who wrote the check, never again by anyone. The
vacuous C1 pass happened *during* exactly that ritual.

**Assert an exact expected count** — "C1 must find 14 links". Precise, and it
turns every ordinary edit into a failing test, so it would be relaxed to a
range and then deleted. A lower bound of one is the strongest constraint that
survives contact with a changing codebase.

**Fail only when a check has zero findings AND zero corpus.** This is what the
code already does, phrased as if it were an alternative. There is no version
where an empty corpus is acceptable: the answer to "did you look?" cannot be
inferred from "I found nothing wrong".
