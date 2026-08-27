# 025. `@huggingface/transformers` is an optional peer, so five scorers cost nothing

Date: 2026-08-27
Status: Accepted. Moved from `dependencies` to `peerDependencies` with
`peerDependenciesMeta.optional: true`, kept in `devDependencies` so the semantic
scorer's own tests and `calibrate:semantic` still run here. The saving in the
consumer that matters is not yet measured — see `Evidence:`.
Evidence: THE COST, MEASURED 2026-08-26 in `voice-check`. Taking this package as
          a dev dependency moved `node_modules` from 78,760 KB to 477,152 KB.
          `onnxruntime-node` was 215,288 KB and `onnxruntime-web` 132,852 KB —
          340MB of the 400MB delta, reached only through
          `@huggingface/transformers`.
          THE CLEAN-ROOM INSTALL, MEASURED 2026-08-27, AND IT IS NOT A
          BEFORE-AND-AFTER. An empty scratch consumer whose only dependency is
          this package, installed from a `git+file://` URL: **27,328 KB**, 16
          packages, and `find node_modules -maxdepth 2 -name "onnxruntime*"`
          returns nothing — the runtime is not present at all.
          THAT NUMBER MUST NOT BE SUBTRACTED FROM THE 477,152 KB ABOVE. The two
          measure different populations: 477,152 KB is `voice-check` carrying
          its own dependency tree plus this package, and 27,328 KB is a
          directory containing nothing else. The difference between them is
          mostly `voice-check`, not mostly the saving, and a "477 MB → 27 MB"
          reading overstates what this change did. An earlier version of this
          line presented exactly that pairing.
          WHAT THE SAVING ACTUALLY IS, in the only place it matters: unmeasured.
          The figure that says anything about the Render build is `voice-check`'s
          own `node_modules` with this branch pinned, and that is next pass's
          measurement — `voice-check` is deliberately untouched here.
          What can be said from the clean-room install alone: onnxruntime is
          absent rather than smaller, and the 215,288 KB + 132,852 KB it
          occupied in the earlier `voice-check` install is therefore not
          installed at all.
          The change was proposed expecting roughly 140MB. That expectation is
          recorded because it was wrong in the direction that flatters the
          change, and because it is not a result.
          THE DETERMINISTIC PATH STILL WORKS, end to end, in that same
          consumer with no transformers installed: `import('agent-evals')`
          resolves 67 exports; `exactFields()` and `formatCompliance()`
          construct; a real `score()` call returns `value: 1`; and
          `semanticSimilarity()` CONSTRUCTS without the peer, because nothing
          loads until `embed()` is called.
          THE FAILURE PATH, OBSERVED against a genuinely absent package rather
          than a mock: `localEmbedder().embed(['hello'])` in that consumer
          throws `SemanticScorerUnavailableError`, whose message names the
          package, states that the omission is deliberate and why, gives
          `npm i -D @huggingface/transformers`, gives the alternative of
          dropping the scorer, notes the threshold was never calibrated, and
          repeats the underlying `Cannot find package
          '@huggingface/transformers'` inline.
          Four unit tests cover the wrapping through an injected importer.
          295 → 299 tests, all passing, typecheck exit 0, `eval:fixture` exit 0.
          NOT MEASURED: install time in the consumer, since the previous pass's
          150.92s cold-cache figure was taken before this change and has not
          been re-run; and any behaviour under pnpm or yarn, whose handling of
          optional peers has not been checked.

## Context

`@huggingface/transformers` exists in this package for one scorer,
`semanticSimilarity`. The other five — `exactFields`, `matchesSchema`,
`callsTool`, `formatCompliance`, `llmJudge` — do not touch it.

It is also, by a wide margin, the most expensive thing this package installs:
340MB of ONNX runtime, on every consumer, to run string comparisons.

The scorer it serves has not earned that. Its calibration failed here — margin
−0.392, eight of ten pairs overlapping — and **no threshold was adopted**. So
the mandatory dependency was 340MB for a scorer this repository does not itself
consider ready.

## Decision

An optional peer dependency. npm does not install optional peers, so a consumer
gets nothing unless they ask for it, and the manifest states the true
relationship: this scorer needs that package, the rest of the library does not,
and the consumer decides.

**Not `optionalDependencies`**, which means "may fail to install on this
platform" and which npm installs by default anyway — off-label, and it would not
have shrunk anything.

**Not a change to `voice-check`'s Render build command**, which would treat a
library problem as a deployment problem, in the wrong repository, leaving every
future consumer to rediscover it.

## Consequences

**A new way to fail, and it is the same SHAPE this package spent ADR 023
fixing.** There, an install reported success and the first symptom appeared in
the consumer's code as `ERR_MODULE_NOT_FOUND` on `dist/index.js`. Here, an
install reports success and the first symptom appears as `ERR_MODULE_NOT_FOUND`
on a package the consumer never listed and never asked for. That reads as a
broken dependency tree, and the reader has no way to know it is deliberate.

So the error message is the mitigation, and it was treated as the deliverable
rather than as a string. `SemanticScorerUnavailableError` carries what a stack
trace cannot: that the omission is intentional, what it buys, which scorer
wanted the package, the exact install command, the alternative of dropping the
scorer, and the fact that the scorer's threshold was never calibrated so
dropping it is a reasonable answer. It repeats the underlying import failure in
the message body because `cause` is invisible in most logs.

**THE IMPORT WAS ALREADY LAZY, which is why this change is small.** Before any
of this, `semantic.ts` loaded the package with `await import(...)` inside
`load()`, with a comment saying it existed so that importing the module would
not pull in the ONNX runtime. The anticipated landmine — `src/index.ts`
re-exports the scorer, so a top-level import would make the whole package
unimportable without the peer — was not there. What this pass added is the
error, not the laziness.

**The tests prove the wrapping, not the wiring.** They inject an importer that
rejects. Uninstalling the package for real would also disable the integration
test and `calibrate:semantic`, for a failure mode that is entirely about how one
rejected promise is wrapped. The wiring — that the real dynamic import is what
throws when the package is absent — is covered outside the unit tests, by the
scratch-consumer probe in the Evidence line. Both halves are stated in the test
file, because a reader who sees four green tests should not conclude the real
path was exercised.

**A consumer who wants the semantic scorer now has to install it themselves,
and nothing tells them in advance.** They find out at first `embed()`, which is
runtime rather than install time. That is the trade: the 95% who never touch the
scorer save 340MB, and the 5% who do get one clear error and a one-line fix.

**Optional-peer handling is npm's, and only npm's, as far as anyone here has
checked.** pnpm and yarn have not been tested.

## Alternatives rejected

**Drop the semantic scorer entirely.** Defensible on the calibration result
alone, and too far for this pass: `calibrate-semantic.ts`, its labelled pairs
and its ADR 008 rationale all still exist, and removing a scorer is a decision
about the suite rather than about packaging.

**Split it into a second package, `agent-evals-semantic`.** The cleanest answer
in principle, and it doubles the release surface of a repository that has no
release process and one consumer.

**Leave it a normal dependency and let consumers use `--omit=optional`.** That
flag does not apply to a normal dependency, and the previous pass explicitly
ruled out reaching into the consumer's install command to solve a library
problem.
