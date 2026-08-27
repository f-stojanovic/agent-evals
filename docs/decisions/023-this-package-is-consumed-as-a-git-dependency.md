# 023. This package is consumed as a git dependency, and that has to be packaged for

Date: 2026-08-27
Status: Accepted. `prepare` builds on install; `main`, `types`, `exports` and
`files` are unchanged.
Evidence: TWO INSTALL PROBES, 2026-08-27, on this machine, into
          `/tmp/agent-evals-install-probe` and `/tmp/agent-evals-install-probe2`,
          against `git+file:///…/agent-evals#<ref>` — the same
          clone / install-devDependencies / run-`prepare` / prune path npm takes
          for a `github:` URL, with no network and nothing pushed.
          BEFORE, at `main` (16336d3), no `prepare` script:
          `npm i` REPORTED SUCCESS — "added 66 packages, and audited 67 packages
          in 7s", exit 0, no warning of any kind.
          `node_modules/agent-evals/` then contained exactly three files —
          `LICENSE`, `README.md`, `package.json` — and no `dist/`.
          `import('agent-evals')` failed:
          `code: ERR_MODULE_NOT_FOUND`,
          `message: Cannot find module '/private/tmp/agent-evals-install-probe/node_modules/agent-evals/dist/index.js'`.
          AFTER, at `packaging-git-dependency` (b5d6303), with `prepare`:
          `npm i` reported the same "added 66 packages" — devDependencies were
          installed for the build and pruned again, so the consumer's tree is
          the same size either way.
          `node_modules/agent-evals/dist/` contained 108 files including
          `dist/index.js` (2099 bytes).
          `import('agent-evals')` SUCCEEDED and resolved 67 runtime exports.
          COST TO THIS REPOSITORY'S OWN INSTALL, measured on the same machine:
          `npm ci` 1.99s without `prepare`, 2.68s with, over 118 packages —
          the difference is `tsc -p tsconfig.build.json`, timed separately at
          0.67s. `npm run typecheck`, `npm test` (295 passed, 1 skipped) and
          `npm run eval:fixture` (exit 0) all pass on the branch.
          `--ignore-scripts`, MEASURED, because the answer was not the one
          expected: `npm i --ignore-scripts` against the branch, with
          `--cache /tmp/npmcache-probe` pointing at a directory that did not
          exist, still produced `dist/` — `dist/index.js` mtime 09:16 against a
          `date` of 09:16:37 the same minute — and `import('agent-evals')`
          succeeded. Control, `--ignore-scripts` against `main` with its own
          cold cache: "added 66 packages", and `LICENSE README.md package.json`.
          So the flag does not suppress `prepare` on the git path here.
          NOT MEASURED: a real `github:f-stojanovic/agent-evals` install. Nothing
          has been pushed, so the GitHub path is inferred from the local git path
          rather than observed. What would count: one `npm i
          github:f-stojanovic/agent-evals` after this branch reaches `main`.
          ALSO NOT MEASURED: an install on Windows, or on any npm other than
          10.9.4 / Node 22.22.1 — and the `--ignore-scripts` result above is
          exactly the kind of behaviour that varies between npm majors.

## Context

This package is not published to npm and there is no plan to publish it. The
only way anything will ever consume it is a git URL — `voice-check` is the first
consumer, and it will take it as a dev dependency for its own eval suite.

The manifest was written as though for a registry. `main`, `types` and `exports`
all point into `dist/`; `files` is `["dist"]`; `.gitignore` excludes `dist/`.
Every one of those is right for a published package, where `npm publish` runs a
build before packing and the tarball carries the compiled output. Together, and
without a build hook, they are wrong for a git dependency, where npm gets a
clone of the source tree and nothing has ever been compiled.

What makes this worth a record rather than a one-line fix is HOW IT FAILS. The
install does not fail. It prints "added 66 packages" and exits 0. `npm ls` is
happy. The package directory exists, is named correctly, and holds a
`package.json` whose `main` points at a file that is not there. Nothing goes
wrong until the first `import`, which is in the consumer's code, at a point where
the obvious diagnosis is that the consumer's own build or module resolution is
broken.

That is the same shape as the failure this repository was built to argue about:
a green result that establishes nothing. An install that succeeds without
installing anything usable is emptiness read as success, and it belongs in the
same family as a suite that scores no case
([ADR 005](005-two-guards-against-a-suite-that-measures-nothing.md)) and a check
that inspects an empty corpus
([ADR 018](018-a-check-must-prove-it-inspected-something.md)).

## Decision

`package.json` gains one script:

```json
"prepare": "tsc -p tsconfig.build.json"
```

`prepare` is the hook that covers the git path. npm installs a git dependency's
`devDependencies` before running it, precisely so that a build can happen, and
prunes them afterwards — both halves are visible in the probe above, where the
consumer ended up with the same 66 packages before and after. `typescript` is
already a `devDependency`, so nothing else changes.

The rest of the packaging stays as it is. `files: ["dist"]` still means the
consumer receives compiled output and nothing else, which is what a consumer
should receive; the probe confirms npm applies that allowlist on the git path
too, and it is the reason the failure was three files rather than a source tree.

## Consequences

**`npm install` and `npm ci` in this repository now build.** Measured at 0.67s
against a 2s install. It is not free and it is worth it: `dist/` cannot be stale
after an install, and the compile that a consumer depends on is exercised on
every developer's machine rather than only on the first install by the first
consumer.

**Both CI workflows now build at the `npm ci` step**, and NEITHER PREVIOUSLY
BUILT AT ALL — `grep -rn "npm run build" .github/workflows/` returns nothing, so
this duplicates no step. It does change what a `npm ci` failure means: a compile
error in the library now stops the job at install, before `Typecheck` runs,
reported as a failed install rather than as a type error. The type error is the
real cause and `npm run typecheck` is where a reader will look for it. This is
accepted rather than papered over — `typecheck` covers a strict superset
(`tsconfig.json` includes `*.test.ts`, `tsconfig.build.json` excludes them), so
nothing can fail the build step that would have passed typecheck. The cost is
one confusing step name on the day it happens, not a missed error.

**The build now happens on the consumer's machine, during their install.** It
pulls a toolchain the consumer did not ask for — a full `devDependencies`
install of `typescript` and `vitest` — into whatever environment runs their
install, including CI and a hosting provider's build container, and then prunes
it again. On a constrained builder that is a real cost charged to somebody who
never chose it. Publishing to npm would remove it; not publishing is the
standing decision, so this is the price of that.

**`--ignore-scripts` does not break this, which I did not expect.** The obvious
worry about a build hook is the consumer who installs with `--ignore-scripts`,
either by choice or by a global npm config. MEASURED, and the worry is
unfounded on npm 10.9.4: `npm i --ignore-scripts` against this branch, with a
cold cache directory so no earlier probe's tarball could be reused, still
produced `dist/` — `dist/index.js` carried an mtime from the install itself —
and `import('agent-evals')` succeeded. The control run, `--ignore-scripts`
against `main` with its own cold cache, gave the three-file directory. npm
treats building a git dependency as part of preparing the package rather than as
a consumer-side lifecycle script, and `--ignore-scripts` does not reach it.

This is recorded because it is the opposite of what I assumed while writing the
paragraph it replaces, and because it is version-specific. It has not been
checked on any other npm, and a future npm that honours the flag here would
reintroduce the silent three-file install with no signal at all.

**`declarationMap` and `sourceMap` were on, and the sources they point at are
not packed. FIXED 2026-08-27; both are now off in `tsconfig.build.json`.**
`files: ["dist"]` excludes `src/`, and MEASURED: `dist/index.d.ts.map` named
`["../src/index.ts"]` as its sources while `files` was `["dist"]`, so all 54
map files in a consumer's `node_modules` pointed at paths that do not exist
there. A map that resolves to nothing is worse than no map — it fails at the
moment somebody is already debugging, and until it fails it claims to show
source while showing compiled output.

Both are off in `tsconfig.build.json` only. `tsconfig.json` keeps them on and
still drives `typecheck`; VERIFIED that the split holds rather than assumed, by
injecting a type error into `src/pricing.test.ts` and confirming `npm run
typecheck` still reports it (`src/pricing.test.ts(65,7): error TS2322`) while
`dist/` contains zero test files. Emitted `dist/` went 768 KB → 452 KB, 27
`.d.ts.map` and 27 `.js.map` → zero.

Shipping `src/` was the alternative and is rejected: it doubles what a consumer
downloads to restore a convenience for a library consumed by one repository,
whose sources are one `git clone` away for anyone who needs them.

## Alternatives rejected

**`prepack`.** It runs for `npm pack` and `npm publish`. It does not run on the
git-dependency install path, which is the only path this package has. It would
look correct in the manifest and change nothing about the observed failure.

**`postinstall`.** Runs in the consumer's install, for every consumer, for every
dependency that declares it. It is a hook for adapting to the consumer's
environment, not for compiling your own source, and using it here would run the
build again on every install of every downstream tree.

**Commit `dist/`.** It works and it needs no hook. It is rejected because
compiled output in a repository is a
second copy of every source file that can silently disagree with the first: a
reviewer reading a diff cannot tell whether the `dist/` half was regenerated
from the `src/` half in the same commit, and the failure mode is a consumer
running code that no longer exists in source. This repository already argues
that a claim nobody can check from the file is a defect
([ADR 015](015-test-data-provenance-is-typed.md)); committed build output is
that, per file, forever.

**Publish to npm.** It solves the problem completely and correctly, and it is a
larger decision than packaging: a published name is public, permanent, and a
promise about versioning that this repository has not made. Out of scope here.

**Point `main` at `src/index.ts` and let the consumer compile.** It removes the
build from the install and moves it into every consumer's toolchain, which now
has to transpile `node_modules`. That is a worse trade and it breaks any
consumer that is not TypeScript.
