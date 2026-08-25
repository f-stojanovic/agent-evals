# 008. Embeddings run locally

Date: 2026-08-19
Status: Accepted
Evidence: MEASURED, 2026-08-20 — the first time this ADR has had any. The
          encoder ran: `Xenova/all-MiniLM-L6-v2`, revision
          `751bff37182d3f1213fa05d7196b954e230abad9`, dtype fp32, resolved from
          the Hugging Face API and written to the `embedding` slot of the
          committed `models.lock.json`. Every prior version of this line said
          the model had never been downloaded.
          First-run cost: the download and load added roughly 40 seconds to a
          suite that otherwise takes ~20 seconds per case, one time. Subsequent
          runs load from the local cache and the semantic scorer contributes no
          measurable wall-clock next to the API calls, and no cost at all —
          `costOf` prices it at exactly zero, which is the claim this ADR is
          about.
          Still unobserved: a CI failure avoided that a hosted embedding key
          would have caused. The argument for local embeddings is about a
          failure mode that has not yet had the chance to happen here.
          The cost side remains observed, and the earlier count here was wrong.
          `npm audit` reports FOUR high-severity vulnerable packages, all
          transitive through `@huggingface/transformers` and none with an
          upstream fix: `@huggingface/transformers`, `onnxruntime-node`,
          `adm-zip` and `sharp`. They arise from two advisories —
          GHSA-xcpc-8h2w-3j85 (adm-zip: a crafted ZIP triggers a 4GB memory
          allocation) and GHSA-f88m-g3jw-g9cj (sharp, inheriting libvips
          CVE-2026-33327, CVE-2026-33328, CVE-2026-35590 and CVE-2026-35591).
          This line previously said "two high-severity transitive advisories",
          which counted advisories where `npm audit` counts packages; both
          numbers are now stated so neither reads as the other.

## Context

The semantic scorer needs sentence embeddings. The default choice is a hosted
embedding API — OpenAI, Voyage, Cohere — which is fast, well-maintained, and
costs almost nothing per call.

But this suite is a CI gate (ADR 002), and a gate has a property ordinary code
does not: every way it can fail that is unrelated to the subject is a false alarm,
and false alarms are what get gates switched off. A hosted embedding call fails on
an expired key, a rate limit, a provider incident, a network policy, or a fork
whose contributors have no secrets. None of those are the model under test getting
worse, and all of them turn the build red.

Embeddings are also the one place in this pipeline where a small local model is
genuinely good enough: a 22M-parameter sentence encoder runs in milliseconds on
CPU and is the same class of model the hosted APIs served until recently.

## Decision

We run the encoder locally through `@huggingface/transformers`. No API key, and no
network after the first model download. The default is
`Xenova/all-MiniLM-L6-v2`, loaded once per embedder instance and cached, with the
ONNX runtime imported lazily so that using only the deterministic scorers does not
pay for it.

The judge is a separate matter and does need an API. That is a different trade —
no local model grades a rubric acceptably — and it is why the judge is the only
scorer whose absence degrades the suite rather than breaking it.

## Consequences

A fork can run the full semantic suite with no credentials. CI cannot fail for a
reason unrelated to the subject.

The costs are real and mostly borne at install time. `@huggingface/transformers`
pulls in the ONNX runtime, and with it two transitively vulnerable packages —
`adm-zip` and `sharp` — that currently have no upstream fix. Neither sits on a
path this project exercises: it embeds text, never decodes images, and unpacks
only the runtime it downloads. They still appear in every `npm audit` a reviewer
runs, and on a public repository that is a recurring conversation.

The first run downloads roughly 90 MB and writes `models.lock.json`, which is why
the one integration test that touches the real encoder is gated behind
`RUN_MODEL_TESTS=1` rather than running by default.

A local model is also weaker than a current hosted one. We accept lower embedding
quality in exchange for a scorer that cannot fail for reasons that have nothing to
do with the answer.

## Alternatives rejected

**OpenAI or Voyage embeddings.** The argument against is not cost — it is
negligible. It is that an eval suite which needs a third-party key to pass CI
fails for reasons unrelated to the thing under test, and a gate that cries wolf
gets disabled, which costs the gate entirely.

**Hosted by default, local as a fallback.** The fallback path would then be
exercised only during an incident, which is the worst time to discover it
produces different numbers. Two encoders also means two incomparable score scales
in one baseline (ADR 009).

**Skip semantic scoring when no key is present.** Silently reduces what the suite
measures on exactly the runs where nobody is watching. ADR 005 exists to prevent
that shape of failure.
