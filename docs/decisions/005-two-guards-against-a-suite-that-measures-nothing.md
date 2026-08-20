# 005. Two guards against a suite that measures nothing

Date: 2026-08-19
Status: Accepted
Evidence: Partial. Both guards are covered by src/scorers/registry.test.ts,
          and the cost is observed: adding a required `format` claim to
          formatCompliance invalidated the committed example cases and forced
          an edit. Neither guard has ever caught a real authoring mistake,
          because every case in this repository was written by one person in
          one sitting.
          In a rebase I spotted two unit tests that have had been passing for months 
          whilst not testing anything at all. One was mocking an interface and calling 
          a method which only existed on the concrete implementation of the interface – 
          the mock returned null, and the test never got anywhere near the code which was 
          claiming to be under test. The other was asserting fixed hardcoded dates that had
          long passed so the policy being tested fell back to wallclocktime for its 
          injected dates rather than the ones I'd hardcoded into the test. 
          Neither was one of my tests nor have either ever failed. 
          Which is the issue, a failing test grabs the eye, one that asserts something but 
          tests it vacuously will not.

## Context

A green run that asserts nothing is worse than a red one, because it produces
confidence instead of information.

`EvalCase.expect` is an open record so that adding a scorer never means editing
the case contract. The price of that openness is that silence is ambiguous, and it
fails in two directions:

An author writes `field:` where they meant `fields:`. The file is valid YAML,
satisfies the case schema, and loads without complaint. No scorer reads it. The
case runs, costs money, and contributes a perfect score for having checked
nothing.

Or a case declares no `fields`, no `schema`, no `toolCalls`. Every scorer skips
it, and every skip is individually correct — a schema check against a case with no
schema has no opinion. Together the correct local decisions produce a case that
is measured by nothing at all.

Both produce a suite that measures less than it did yesterday with no signal
anywhere that it happened.


## Decision

We run two checks in `validateExpectations`, before the first API call, and both
throw.

**Guard one.** Every scorer declares the keys it consumes. Any key in any case
that no registered scorer claims is an error. Problems are grouped by key, not by
case, with an edit-distance suggestion — one typo copy-pasted across fifty cases
is one problem, and the correct spelling is usually in the message.

**Guard two.** Every `ExpectationClaim` carries a `required` flag, which lets a
runner tell "this check does not apply here" from "this case is misconfigured". A
case that no scorer *measures* is an error, naming which scorer was missing which
key. Measuring is stricter than applying: a scorer with no required claims applies
to every case, and if that counted as measurement it would silently disable this
guard for any suite that registered one.

A `meta` key colliding with a claimed key is also an error, because `meta.fields`
is never a decision — only an expectation moved out of enforcement.

## Consequences

A misrouted expectation cannot reach CI. The failure arrives before any tokens
are spent, with the file and case named.

The cost is that empty `expect: {}` is now illegal in a suite whose scorers all
have required claims, and the example suite had to be edited when
`formatCompliance` began claiming `format` as required. Adding a required claim to
any scorer can invalidate existing cases across a repository — the guards make the
scorer contract stiffer, and stiffness is felt every time it changes.

The second guard also depends on the applies/measures distinction, which is subtle
enough that it needs its own test to stay correct.

## Alternatives rejected

**Warnings instead of errors.** A warning in CI output is a line nobody reads in a
log nobody opens. The whole failure mode here is a signal that does not reach a
human; adding a quieter signal does not address it.

**An opt-in `--strict` flag.** The suites that would enable it are the ones
careful enough not to need it. A control nobody enables is not a control — it is
a way of appearing to have addressed the problem while leaving it in place, and it
lets the default configuration ship the bug.

**Closing `expect` to a fixed schema.** Removes the ambiguity by removing the
openness, and couples the case contract to its consumers: every new scorer would
require editing the type every case is validated against. Rejected in favour of
keeping the openness and paying for it with these two checks.
