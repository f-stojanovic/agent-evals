# 016. Categorical fields are constrained by schema, not requested in prose

Date: 2026-08-19
Status: Accepted
Evidence: Two baselines, both recorded from live `claude-sonnet-5` runs.
          `evals/baseline.freetext.json` (weighted 0.751) is the archived
          before: every case at 0.75 or below, all three losing the same field.
          `evals/baseline.json` (weighted 0.953) is the after, from the same
          model, same prompt intent, same cases and same scorers, with the
          categorical fields moved into a tool schema.
          The residual mismatch is one field on one case — `urgency: high` vs
          `medium` on the deliberately ambiguous case, where `medium` is listed
          in that case's own `acceptable` set. That is genuine annotator
          disagreement, which is what should be left once the wording problem
          is gone.

## Context

The first live run scored 0.75 or below on `exact-fields` for all three cases,
and every one of them lost the same field. The model's answers were correct:

| case | expected | model produced |
| --- | --- | --- |
| refund-damaged-item-01 | `issue_refund` | `refund_full_amount` |
| outage-escalation-01 | `escalate_to_engineering` | `fix_checkout_api_503_errors` |
| cancellation-or-complaint-01 | `explain_cancellation_terms` | `clarify_cancellation_terms` |

`requested_action` had been specified as "a short snake_case verb phrase for
what the customer wants" — a categorical field asked for as free text. The
model answered the question it was given, correctly, in words the case did not
happen to use. Exact match then graded the case design and reported it as a
model result.

`intent` and `urgency` had the same shape of problem in a milder form: the
prompt listed their allowed values in prose, and nothing enforced the list.

## Decision

Categorical fields go in the subject's tool schema as enums. The model chooses
a value; the schema constrains the set it may choose from, and the API rejects
anything outside it at the boundary.

`intent`, `urgency` and `requested_action` are enums. `customer_name` stays
free text, because it genuinely is one.

The old baseline is kept as `evals/baseline.freetext.json` rather than
overwritten. It is the evidence for this record.

## Consequences

Exact match becomes a valid scorer for these fields. It was not before: against
free text it was measuring whether the model guessed the case author's
vocabulary, and no amount of scorer work fixes that — a semantic scorer would
have papered over a specification error by learning to accept synonyms.

The weighted score moved 0.751 → 0.953 with no better model, no better prompt
and no better scorer.

**The model loses the freedom to be right in a way the system cannot route.**
`fix_checkout_api_503_errors` was a better description of that ticket than
`escalate_to_engineering`, and it is now unavailable. That is the trade, and it
is the correct one for a field whose consumer is a switch statement: an
enumeration that a downstream system can act on is worth more than a precise
phrase it cannot. It would be the wrong trade for a summary field.

**The enum set is now a design surface that can be wrong.** Six values were
chosen to cover three cases plus plausible neighbours. A real ticket that fits
none of them will be forced into the closest, and the score will look fine
while the data is wrong. Nothing here detects that; it needs a human reading
the distribution of chosen values.

**Two things changed at once, and only one of them is this decision.** Moving to
a tool call also changed how the payload arrives: the free-text subject fenced
10 of 15 samples, and the constrained one is 100% `tool-call`. So the
disappearance of the format-compliance finding is a side effect of the delivery
mechanism, not evidence that anything about formatting improved. The archived
baseline and the README preserve the earlier observation.

**Subject variance is now visible where it was masked.** Two consecutive live
runs of the constrained subject scored 0.972 and 0.953; one sample of five on
`refund-damaged-item-01` still disagreed. At 0.75 with a systematic wording
failure, that variation was invisible underneath the constant error.

## Alternatives rejected

**Use `semanticSimilarity` on `requested_action`.** The obvious fix and the
wrong one. It would have made the score go up while leaving the field free
text, so the suite would have kept accepting whatever the model said and called
it agreement. It treats a specification defect as a scoring problem.

**Widen the expected values to include the observed synonyms.** Teaching to the
test. The next model, or the next prompt, produces a different synonym and the
case fails again — and each round of widening makes the expectation mean less.

**Leave it and document the limitation.** Considered seriously, because the
0.751 baseline was an honest record of what the suite measured. Rejected
because the number was being read as a model result, and a metric that is
correct but systematically misattributed is worse than one that is wrong and
known to be.
