# 026. A cost is known, or it is accounted for — it is never a partial number

Date: 2026-08-27
Status: Accepted. `costOf` returns a `Cost` union rather than
`CostBreakdown | undefined`; `src/sdk-usage.ts` validates the SDK response at
both call sites. Breaking change to a published symbol, made before any consumer
has pinned this package.
Evidence: THE DEFECT, MEASURED 2026-08-27, before the change:
          `costOf({inputTokens: undefined, outputTokens: 50}, 'claude-fable-5')`
          returned `{"inputUsd":null,"outputUsd":0.0025,"totalUsd":null}`.
          The arithmetic produced `NaN` and `JSON.stringify` wrote it as `null`,
          so an object with one real measurement and one absent one serialised
          into `.artifacts/` looking like a cost.
          TWO MORE OF THE SAME DEFECT, found while fixing that one and not
          suspected beforehand.
          Aggregation: merging a priced `$0.0600` with an unpriced component
          returned `$0.0600`. `mergeCost` treated an unpriced term as absent, so
          a suite total silently omitted it.
          `judgeCostOf` returned `ZERO_COST` when a scorer reported
          `judgeUsage` with no `judgeModel` — asserting the grading was free
          when the truth was that nobody knew what it cost.
          A FOURTH, LIVE IN THIS REPOSITORY'S OWN FIXTURE RUN, found by running
          the old tree from a git worktree at f3a955b rather than by reading it.
          `npm run eval:fixture` printed:
            `- cost: **$0.1534** — subject $0.1534, judge $0.0000`
          The judge is `fixture-judge`, which has no price table entry. Its cost
          was not zero; it was unknown. The renderer's `run.judgeCost?.totalUsd
          ?? 0` turned an absent component into a figure, and the total was
          presented as complete while a term was missing.
          The same command on this branch prints:
            `- cost: **unknown** — only $0.1534 of it could be priced`
            `  - no price table entry for "fixture-judge"`
          AFTER, MEASURED: `costOf` with a missing token count returns
          `{"kind":"unknown","gaps":[{"kind":"uncomputable","detail":
          "claude-fable-5: inputTokens is missing"}]}`. The serialised form
          contains no `null` and no `NaN`. Adding a priced cost to an unpriced
          one returns `kind: "unknown"` carrying the gap and a `pricedPortion`.
          A genuinely free run still returns `kind: "known"` with `totalUsd: 0`,
          so "free" and "unknown" remain distinguishable.
          THE BOUNDARY: 14 tests over `parseSdkUsage`, covering a renamed field,
          a missing field, `null`, a string, a fractional count, a negative
          count, absent usage, and non-object usage — each refused. One asserts
          an unrecognised field is ACCEPTED, which is the `z.object` decision.
          `npm run verify` exit 0 throughout. 299 → 318 tests.
          NOT MEASURED: whether any released `@anthropic-ai/sdk` in
          `>=0.117.1 <1` actually changes the `usage` shape. No SDK release
          notes were read and none is cited. The validator is insurance against
          a possibility, not a response to an observed break.

## Context

ADR 024 made `@anthropic-ai/sdk` a peer at `>=0.117.1 <1` so a consumer runs one
copy. It recorded, as a consequence it did not act on, that `usage` was read
structurally with nothing behind it but a compile-time type — and that a missing
field became `NaN`, and `NaN` serialises to `null`.

That is the whole problem in one sentence: **this repository's argument is that
its numbers are attributable, and its cost path could emit a number that was not
a measurement, into the artifact it points at when making that argument.**

The next pass puts OpenTelemetry spans on this path and renders per-step cost in
a waterfall. A span attribute carrying a null-that-means-NaN is worse than no
span, because a waterfall looks authoritative.

## Decision

Two halves of one boundary.

**Validate what arrives.** `src/sdk-usage.ts` parses `response.usage` with Zod
at both SDK call sites and refuses anything it cannot price.

THE RANGE IS WIDE BECAUSE THE BOUNDARY IS VALIDATED, NOT IN SPITE OF IT. That
sentence is the argument, and it answers the `<1` versus `<0.122.0` question ADR
024 left open. A narrow range buys safety by treating every SDK minor as a break
and charges a push, a tag and a re-pin in every consumer for each one — a
treadmill that produces a churn of version bumps nobody reads, which is its own
way of not noticing a change. A validated boundary buys the same safety once.
The validator is not an addition to ADR 024; it is the half of it that was
missing.

`z.object`, not `z.strictObject`, and deliberately the opposite of what
`cases.ts` and `fixtures.ts` do. Those validate files a human wrote, where an
unrecognised key is a typo. This validates a payload a vendor wrote, where new
fields ship on a normal release schedule and are not errors. `strictObject` here
would fail on every additive SDK release — the exact treadmill the wide range
exists to avoid.

**Make an unknown cost unrepresentable as a number.** `Cost` is a union: `known`
with a breakdown, or `unknown` with the gaps that made it so. `CostGap`
separates `unpriced` — a fact about `PRICES`, fixed by adding a row — from
`uncomputable`, a fact about what arrived. They are kept apart for the same
reason `ExtractionOutcome` keeps `unreadable` apart from `ambiguous`: different
findings, different responses, and collapsing them makes the report state a
diagnosis nobody made.

There is no arm holding a partially computed breakdown as though it were the
answer. `unknown` may carry `pricedPortion`, but under a name that cannot be
read as a total, and the renderer prints the word before it prints any figure.

## Why a union, and what the alternatives cost

**Throwing** is the loudest option and the wrong one here. `costOf` runs inside
per-case aggregation, so a throw destroys the report for an entire run at the
moment its reader most needs it — over an accounting field, not a result. It
also does not fit three of the four defects above: an unpriced model and a
missing `judgeModel` are not exceptional conditions, they are ordinary states
the report should describe. With the boundary validated, the SDK path already
throws before `costOf` is reached, so a throw here would be a second gate on the
one case that was already covered.

**`totalUsd: number | 'unknown'` inside `CostBreakdown`** is the same union with
worse ergonomics. Every arithmetic site has to narrow before it can add, and
`addCost` becomes a four-branch function over two possibly-unknown operands. It
also leaves the partial state representable — `inputUsd` a number while
`totalUsd` is `'unknown'` — which is the defect.

**The union** costs a breaking change to `costOf` and touches `types.ts`,
`pricing.ts`, `runner.ts`, `report.ts` and four test files. It is the only one of
the three that fixes all four defects, and it is the only one where the compiler
enumerates the call sites rather than leaving them to a reader.

## Consequences

**A published symbol changed shape.** `costOf` returned `CostBreakdown |
undefined` and now returns `Cost`. This is timed rather than lucky: `voice-check`
pins a SHA next pass, so nothing has depended on the old signature and this is
the cheapest moment the change will ever be.

**`undefined` still exists and now means one thing.** No cost component ran at
all. Previously it meant that, or "unpriced model", and the renderer picked one
of those to print for both.

**The report is longer and less pleasant when something is unknown**, which is
the point. `- cost: **unknown**` with a bullet per gap is worse to look at than a
tidy dollar figure, and this repository's own fixture run now shows it on every
invocation. That line is accurate and the tidy one was not.

**`costOf` validates its own input as well as the SDK boundary doing so.** It is
exported, so a consumer can hand it a `Usage` this package never parsed —
hand-assembled, replayed from a fixture, or produced by their own subject. "The
caller validated it" is not a guarantee an exported function can rely on.

**The `unpriced` gap is now visible where it was invisible, which will look like
a regression.** Anyone whose price table lacks an entry has been getting a total
that quietly excluded it; they will now see `unknown`. That is the tool starting
to tell the truth, and it should be read that way rather than as a new fault.

**Nothing here touches the baseline.** Cost is recorded in `.artifacts/` and the
report, and `baseline.ts` contains no cost field — checked. So no recorded
history is invalidated and no baseline needs re-recording.

## Alternatives rejected

**Leave it and handle the shape change if it ever happens.** The failure mode is
a wrong number rather than an error, so "if it happens" is not a thing anyone
would observe. The four defects above all shipped, and three of them were found
only because the fourth was reported.

**Pin the SDK back into `dependencies` and drop the peer.** Removes the
instability by reintroducing two SDK copies in the consumer — ADR 024's problem —
and does nothing about the unpriced-model or missing-`judgeModel` cases, which
have no connection to the SDK.

**Validate in the runner rather than at the call sites.** The runner sees a
`SubjectOutput` a subject already built, so the bad value would have been
constructed and passed through before anything looked at it. A boundary check
belongs where the foreign data is first touched.
