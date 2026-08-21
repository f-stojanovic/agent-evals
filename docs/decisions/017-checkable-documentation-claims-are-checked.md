# 017. Documentation claims that can be checked mechanically are checked mechanically

Date: 2026-08-19
Status: Accepted
Evidence: Three manual audit rounds, three real divergences, one cause each
          time. Round one: ADR 005 claimed a `--strict` flag that never
          existed. Round two: the one-owner-per-key rule's written
          justification described a dispatch mechanism the system does not
          have. Round three: ADR 006 said extraction runs once per case when it
          runs once per sample, `src/types.ts` linked a `CaseResult` field
          deleted in the same commit, and ADR 011 still described k>1 sampling
          after ADR 014 reversed it.
          The five checks in `src/docs.test.ts` were written to fail against
          the round-three divergences before they were fixed. Two did fail
          immediately; C1 and C4 were verified by injecting the defect they
          exist for and confirming each failed for the right reason, then
          restoring. All five are green now.

## Context

Every round of the manual honesty pass has found something, and the failures
share a shape. It is never a careless document. It is a document edited *twice*:
one pass updates the Decision, another updates the Evidence line six weeks
later, and a third paragraph is left asserting the world as it was before
either. The person who made both edits is the person least able to see the
third paragraph, because they know what the document is supposed to say.

Round three made this unarguable. All three divergences were introduced by the
same pass that correctly updated other parts of the same files.

But these were rules that I enforced, not rules that I wrote. The team had sixty 
architecture decision records, and quite a few of them were duplicated: once as
descriptive text, once as a static-analysis rule or as layer-dependency
configuration that blocked the build. I never had to remember one. I only know that 
I violated one when the ci report told me I did. I don’t remember the content of any 
ADR that only exists as descriptive text.

## Decision

Claims a machine can decide are decided by a machine, in `src/docs.test.ts`,
run by `npm test` and therefore by CI on every push:

1. Every `{@link Type.member}` in `src/**/*.ts` names a type and member that
   exist.
2. Every scorer named in the README Status checklist is registered by the CLI.
3. Every baseline file on disk is documented, and every baseline file named in
   the docs exists.
4. Every ADR whose Status says "superseded by NNN" is answered by NNN naming it
   back — asserted in both directions.
5. Every ADR has a non-empty Evidence line, and a Status line. `None.` counts;
   absent does not.

The manual pass continues. Its scope is now what a machine cannot decide.

## Consequences

The three classes of defect that recurred cannot recur silently. A deleted
field takes its doc links with it, a scorer cannot be advertised into a run
that never invokes it, and a supersession cannot be declared in one direction.

**The checks are shallow, and shallow on purpose.** C1 is text analysis, not the
TypeScript AST — it cannot see through re-exports or generics, so it skips any
link whose type it cannot find a declaration for. That makes it silent on cases
it does not understand rather than noisy, which is the right failure direction
for a check nobody would otherwise keep.

**They can pass vacuously.** A check that finds nothing to inspect reports
success indistinguishably from one that inspects and approves. C1 did exactly
this on first writing: an injected defect went undetected because the injection
itself was a no-op, and the check looked green. C1 and C4 were subsequently
verified by breaking the repository on purpose and confirming each failed with
the right message. Nothing in the suite enforces that discipline for the next
check somebody adds.

**They encode a fixed idea of where claims live.** C2 knows the README has a
`## Status` section; C3 knows baselines live in `evals/`. Restructure either
and the check quietly stops covering anything.

**And the important claims remain unchecked.** Whether an Evidence line is
honest, whether reasoning is sound, whether a number is presented as more than
it is — no test decides that. C5 asserts an Evidence line exists, which is the
weakest possible version of the property it cares about.

## Alternatives rejected

**Review more carefully.** Tried three times, found three defects. That is the
definition of a control that does not work, and repeating it while expecting a
different result is not a plan.

**A checklist in CONTRIBUTING.** A convention nothing enforces decays — ADR 015
exists because one already did.

**Generate the documentation from the code.** It would eliminate the whole
class, and it would also eliminate the documents. The value of these records is
the reasoning, the rejected alternatives and the evidence, none of which is
derivable from the code. What is derivable is exactly the small set of facts
now checked.

**A stricter tool — API-extractor, or typedoc with `--treatWarningsAsErrors`.**
Would do C1 properly and nothing else, at the cost of a build step and a
configuration file. The five checks here are ninety lines of test with no new
dependency, and four of them are about prose no documentation tool models.
