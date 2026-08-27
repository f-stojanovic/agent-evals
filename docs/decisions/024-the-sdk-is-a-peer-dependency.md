# 024. The Anthropic SDK is a peer dependency, so a consumer runs one copy

Date: 2026-08-27
Status: Accepted. `@anthropic-ai/sdk` moves from `dependencies` to
`peerDependencies` at `>=0.117.1 <1`, and stays in `devDependencies` at
`^0.117.1` so this repository's own tests and CLI run without a consumer.
Evidence: THE DUPLICATION, MEASURED, 2026-08-26. Installing this package into
          `voice-check`, whose own manifest requires `^0.120.0`, produced
          `node_modules/agent-evals/node_modules/@anthropic-ai/sdk` at 0.117.1
          alongside the consumer's 0.120.0.
          THE CAUSE, VERIFIED against the `semver` library rather than reasoned
          about: `new Range('^0.117.1').range` is `>=0.117.1 <0.118.0-0`;
          `satisfies('0.120.0', '^0.117.1')` is `false`; and
          `intersects('^0.117.1', '^0.120.0')` is `false`. For a `0.x` version
          the caret allows patch changes only, so the two ranges cannot both be
          satisfied by one copy.
          THE FIX, MEASURED. A scratch consumer declaring
          `"@anthropic-ai/sdk": "^0.120.0"` and installing this branch from a
          `git+file://` URL: `find node_modules -type d -path "*@anthropic-ai*"
          -name sdk` returns exactly one path, at 0.120.0, and
          `import('agent-evals')` resolves 67 exports.
          A consumer declaring NO SDK: npm auto-installed the required peer, at
          0.121.0, and the import still resolved 67 exports.
          THE RANGE IS ASSERTED WIDER THAN IT IS TESTED, and this is the line
          that says so. `>=0.117.1 <1` claims compatibility across every
          release in that span. It has been tested at THREE points — 0.117.1,
          0.120.0 and 0.121.0 — each with `npm run typecheck` (exit 0), the
          full suite (295 tests at first measurement, 299 after this pass's
          tests were added, 1 skipped) and `npm run eval:fixture` (exit 0).
          Everything between and above those three points is asserted, not
          measured. 0.121.0 was tested only because npm chose it for a bare
          consumer, which is a fair description of how much of this range
          anyone has looked at.
          NOT MEASURED: any release between 0.117.1 and 0.120.0, anything above
          0.121.0, and any behaviour at all under a package manager that does
          not auto-install required peers.

## Context

`voice-check` requires `^0.120.0`. This package required `^0.117.1`. npm
resolved that by giving the consumer two copies.

Nothing breaks today. Neither copy is loaded by the deployed service, and the
eval path runs on a laptop where 40MB of duplicate SDK is not a cost anyone
notices. The reason to fix it now is what comes next: OpenTelemetry spans and
per-call cost attribution, which read `usage` off SDK responses. Two SDK builds
means two places `usage` is parsed and two places instrumentation has to be
attached, in a repository whose entire claim is that the numbers are
attributable to something. One SDK in the process is a precondition for that
work rather than a tidiness preference.

## Decision

`peerDependencies: { "@anthropic-ai/sdk": ">=0.117.1 <1" }`, kept in
`devDependencies` at `^0.117.1`.

A peer dependency says the consumer owns this copy and the library will use
whichever one is there. That is exactly true here: the SDK is a transport the
consumer is already holding, not an implementation detail this package should
be hiding.

The range is wide because the alternative is worse. A narrow range on a package
that ships a minor every few weeks means every SDK bump in `voice-check` breaks
the peer and needs a commit here to unbreak it — and this package has no
release process, so that commit is a push, a tag, and a re-pin in the consumer.

## Consequences

**The wide range is a promise made on very little evidence, and 0.x makes it
worse.** Under semver a `0.x` minor is allowed to break, and this SDK uses that
allowance. `<1` asserts that none of those breaks will touch the surface this
package uses, across an unbounded number of future minors, on the strength of
three tested points. The honest description is that this is a bet that the
Messages API surface and the `usage` shape are stable, and the bet is being
recorded rather than hidden. A break shows up as a type error at the consumer's
`npm run build`, not at install.

**`usage` IS NOT VALIDATED AT THE BOUNDARY, AND THE PEER RANGE IS WHERE THAT
STOPS BEING FREE.** Checked rather than assumed: neither `src/scorers/judge.ts`
nor `src/subjects/support-extraction.ts` imports `zod`, and both read
`response.usage.input_tokens` and `response.usage.output_tokens` structurally.
The only thing standing behind those reads is the TypeScript type from whichever
SDK version was installed at compile time — which, with a peer, is not
necessarily the version installed at run time.

MEASURED consequence of that gap: `costOf({ inputTokens: undefined, ... })`
returns `{"inputUsd":null,"outputUsd":0.0025,"totalUsd":null}` — the arithmetic
produces `NaN`, and `JSON.stringify` writes `NaN` as `null`. So an SDK that
renamed or dropped a usage field would not throw. It would put `null` costs into
`.artifacts/` and, if the run recorded one, into a baseline, in a repository
whose argument is that a recorded number is attributable. No validator is added
in this pass, deliberately: the gap is now measured rather than suspected, and
what to do about it is a decision with the instrumentation work in front of it.

**Both SDK imports are top level and static.** `src/index.ts` re-exports
`anthropicJudge` from `judge.ts`, which imports the SDK at module scope, so a
consumer without the SDK cannot import this package at all — not even to use
`exactFields`. npm 7+ auto-installs required peers, which is why the bare-consumer
probe above worked, so this is not a problem on npm. It is a problem under any
installer that does not, and `--legacy-peer-deps` is the obvious one. Not fixed
here; unlike the transformers case (ADR 025) the peer is required, so npm's
default behaviour covers the mainstream path.

## Alternatives rejected

**Widen `dependencies` to `>=0.117.1 <1` and keep it a normal dependency.** It
would let npm dedupe in the common case, and npm would still be free to nest on
any conflict. It also keeps the library asserting ownership of a copy it does
not own.

**Match `voice-check` at `^0.120.0`.** Fixes today's duplication and reintroduces
it the next time either repository bumps. The disjointness, not the versions, is
the defect.

**Bundle or vendor the SDK.** Guarantees one copy in this package and guarantees
two in the consumer's process.
