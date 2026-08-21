# 006. Extraction leniency is measured, not chosen

Date: 2026-08-19
Status: Accepted
Evidence: CONFIRMED BY OBSERVATION, 2026-08-19, and more strongly than
          expected. A live run of claude-sonnet-5 under a system prompt ending
          "Reply with the JSON object and nothing else" produced `fenced` on
          10 of 15 samples and `json` on 5. One case fenced 5/5, another 4/5,
          a third 0/5 — so the envelope varies both between cases and between
          samples of the same case.
          Strict extraction would have scored those ten samples as failures of
          comprehension. They were failures of envelope, and the two now read
          as separate columns exactly as this ADR argued.
          The multi-fence ambiguity path has NOT been observed live: no real
          response has yet produced two parseable blocks. Its behaviour is
          covered only by src/scorers/extract.test.ts.
          Routes and the ambiguity refusal are covered by
          src/scorers/extract.test.ts. evals/fixtures/ is now captured from a
          live run rather than hand-authored, though the current subject uses a
          tool call, so those recordings exercise the `tool-call` route only.

## Context

Models return structured data in four shapes: a tool call, bare JSON, JSON inside
a markdown fence, and JSON buried in prose ("Sure! Here you go: ```json …"). A
harness that asks for JSON must decide how much of that to accept, and both
obvious answers are wrong in the same way.

Strict extraction — parse bare JSON only — does not measure extraction accuracy
strictly. It measures extraction accuracy multiplied by format compliance and
reports one number that cannot separate a model that misread the input from one
that read it perfectly and added a preamble. Those need different fixes.

Silent leniency — parse whatever is findable — throws the format signal away
entirely. A model degrading from clean JSON to prose-with-a-code-block scores
identically before and after.

The only deliberate leniency I saw up close was changing the architectural rule
engine from “do not block” to “no longer observed”. It stayed in the pipeline, it
kept running and it kept producing output — which no one read. Leniency which
produces no distinct measurable output is not leniency. It’s simply turning a
light off very slowly until no one’s around any more.

There is also a timing constraint. Relaxing extraction later moves every
extraction score upward at once, which in a recorded baseline is indistinguishable
from the subject improving — a silent rewrite of history the gate cannot flag.
Leniency is the reversible direction, and the choice must therefore be made before
the first baseline exists.

## Decision

We extract leniently, record how, and score the how separately.

`extractStructured` resolves in order — tool call input, bare JSON, a fence
wrapping the whole response, then a fenced block scavenged from prose — and
returns `via: 'tool-call' | 'json' | 'fenced' | 'scavenged'` alongside the data.
It runs once per SAMPLE — each sample is a different response and deserves its
own reading — and every scorer within a sample shares that one result, so three
scorers cannot disagree about what the model produced. The routes are recorded
on `CaseResult.vias`, one per sample.

`formatCompliance` is a separate scorer that grades `via` against the case's
declared `expect.format` (`tool-call`, `json`, `fenced`, or `any`). A declared
format accepts its own route and every stricter one, so declaring `fenced` means
a fence is acceptable, not required.

When several fenced blocks each parse as JSON, extraction fails and reports the
count rather than picking one.

## Consequences

Two readable numbers instead of one muddled one. "Understood the input" and
"complied with the format" move independently in the baseline.

There is no invented partial credit for a fence. Whether an envelope is acceptable
depends entirely on what consumes the output, so the case author declares it and
the score is 1 or 0 against that declaration. An earlier version scored `fenced`
at 0.5, which applied one team's tolerance to everyone (see ADR 010).

The cost is blast radius. Because every scorer in a sample shares one
extraction, an ambiguous response — two JSON blocks in prose — fails extraction
for *every* extraction-consuming scorer on that case, not only the format one. `exactFields`, `matchesSchema`, and
`semanticSimilarity` all see `via: 'none'` and score 0, so one formatting quirk
zeroes a case across the board.

Declaring `format` also becomes mandatory for any case that wants the check, since
`formatCompliance` claims it as required. Suite-wide format tracking is therefore
opt-in per case rather than automatic.

## Alternatives rejected

**Strict extraction only.** Measures two properties as one and reports a number
that answers neither question. It also picks the irreversible direction:
tightening can be relaxed later only by invalidating every recorded score.

**Silent leniency.** Recovers the payload but discards the evidence, so preamble
discipline becomes unobservable. This is the cheaper mistake and the harder one to
notice, because everything keeps passing.

**Per-scorer extraction.** Three scorers re-parsing the same response store the
same fact three times, pay for three parses, and can disagree about what the model
produced. One extraction, one answer.

**Picking the first (or last) fenced block when several parse.** First-wins scores
the model's scratch work; last-wins scores a trailing example. Both rules are
arbitrary, and an arbitrary rule applied silently produces a confident number
derived from a coin flip.
