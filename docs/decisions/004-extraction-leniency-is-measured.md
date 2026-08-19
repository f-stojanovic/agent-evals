# 004 — Extraction leniency is measured, not chosen

**Status:** accepted

## Context

Models return structured data in several shapes: a tool call, bare JSON, JSON
in a markdown fence, or JSON buried in prose ("Sure! Here you go: ```json …").
A harness that asks for JSON has to decide how much of that to accept.

Both obvious answers are wrong in the same way.

**Strict** — only parse bare JSON — does not measure extraction accuracy
strictly. It measures extraction accuracy multiplied by format compliance, and
reports one number that cannot distinguish a model that misread the input from
one that read it perfectly and added a preamble. Those need completely
different fixes.

**Lenient, silently** — parse whatever can be found — throws the format signal
away entirely. Preamble discipline stops being visible at all, and a model that
degrades from clean JSON to prose-with-a-code-block scores identically.

## Decision

Extract leniently, record how, and score the how separately.

`extractStructured` resolves in order: tool call input, bare JSON, a fence
wrapping the whole response, then a fenced block scavenged from prose. It
returns `via: 'tool-call' | 'json' | 'fenced' | 'scavenged'` alongside the
data.

`formatCompliance` is a separate scorer that reads `via` and grades it against
the case's declared `expect.format` (`tool-call`, `json`, `fenced`, or `any`).
A declared format accepts its own route and every stricter one.

Extraction runs **once per case**, in the runner, and the result is recorded on
`CaseResult.extraction` and passed to every scorer.

## Consequences

- Two readable numbers instead of one muddled one. "Understood the input" and
  "complied with the format" move independently in the baseline.
- The direction of this choice matters for history. Being lenient now and
  measuring format separately is *additive*: existing recorded scores stay
  valid and a new column appears beside them. Being strict now and relaxing
  later would move every extraction score upward at once — indistinguishable in
  the baseline from the model improving, and a silent rewrite of history the
  gate cannot flag. Leniency is the reversible direction.
- There is no invented partial credit for a fence. An earlier version scored
  `fenced` at 0.5, which was a made-up number applying one team's tolerance to
  everyone. Whether an envelope is acceptable depends on what consumes the
  output, so the case author declares it and the score is 1 or 0 against that.
- Ambiguity is refused rather than resolved. If several fenced blocks parse as
  JSON, extraction fails and reports the count. First-wins would score the
  model's scratch work; last-wins would score a trailing example. Both rules
  are arbitrary, and an arbitrary rule applied silently produces a confident
  number derived from a coin flip.
- Extraction never throws. A model returning prose where JSON was expected is a
  *result* — 0.0 with a reason, visible in the baseline the day it starts
  happening. Throwing would make it indistinguishable from a dropped
  connection, which is infrastructure noise to retry rather than a quality
  signal to act on.

## Alternatives rejected

**Strict extraction only.** Rejected: measures two properties as one, and
tightening is the irreversible direction.

**Per-scorer extraction.** Rejected: three scorers re-parsing the same response
store the same fact three times, cost three parses, and can disagree.

**A global leniency setting.** Rejected as the same mistake one level up — one
knob for a decision that is genuinely per-case.
