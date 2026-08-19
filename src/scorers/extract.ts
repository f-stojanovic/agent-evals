/**
 * Getting structured data out of whatever the model actually produced.
 *
 * Called ONCE per case by the runner, never per scorer — see {@link Extraction}
 * in types.ts for why. The types live there because `CaseResult` records the
 * result; this module only computes it.
 */

import type { Extraction, SubjectOutput } from '../types.js';

/**
 * Pulls the structured payload out of a subject's output.
 *
 * Resolution order, most to least compliant: tool call input, bare JSON, a
 * fence wrapping the whole response, then a fenced block scavenged out of
 * prose.
 *
 * WHY THIS IS LENIENT, AND WHY THAT IS NOT A CONCESSION
 * ----------------------------------------------------
 * Extraction accuracy ("did the model read the email correctly?") and format
 * compliance ("did it emit clean JSON, or three paragraphs and a code block?")
 * are different properties of a response. A function that refuses to parse the
 * prose-wrapped case is not measuring extraction strictly — it is measuring
 * the two properties multiplied together, and reporting a number that cannot
 * distinguish a model that misread the email from one that read it perfectly
 * and said "Here you go:" first. Those call for completely different fixes.
 *
 * So this recovers the payload wherever it is, records HOW in `via`, and
 * leaves format to `formatCompliance`, which scores `via` against the case's
 * declared `expect.format`. Two readable numbers instead of one muddled one.
 *
 * The direction of the choice also matters for the baseline. Being lenient now
 * and measuring format separately is additive: recorded scores stay valid and
 * a new column appears beside them. Being strict now and relaxing later would
 * move every extraction score upward at once, which is indistinguishable in
 * the baseline from the model improving — a silent rewrite of history the gate
 * cannot flag.
 *
 * TWO KINDS OF FAILURE
 * --------------------
 * `unreadable` means no parseable JSON anywhere: the model demonstrably failed
 * to produce what was asked. `ambiguous` means several candidates parsed and
 * choosing between them would be a coin flip. Callers treat them differently —
 * the first is a score, the second is an error — and this function's job is to
 * report which one happened, not to smooth them together.
 *
 * WHY THIS NEVER THROWS
 * ---------------------
 * A model returning prose where JSON was expected is a *result*, not an
 * exception. It belongs in the baseline as 0.0 with a reason, visible as a
 * regression the day it starts happening. Throwing would abort the case, and
 * a runner cannot tell "the model wrote an essay" apart from "the connection
 * dropped" — one is a quality signal to act on, the other is infrastructure
 * noise to retry.
 */
export function extractStructured(output: SubjectOutput): Extraction {
  const firstCall = output.toolCalls?.[0];
  if (firstCall !== undefined) return { via: 'tool-call', data: firstCall.input };

  const text = output.text;
  if (text === undefined || text.trim() === '') {
    return {
      via: 'unreadable',
      error:
        output.toolCalls?.length === 0
          ? 'the subject returned an empty tool call list and no text'
          : 'the subject returned no text and made no tool calls',
    };
  }

  const direct = tryParseJson(text);
  if (direct !== undefined) return { via: 'json', data: direct.data };

  const whole = stripWholeStringFence(text);
  if (whole !== undefined) {
    const parsed = tryParseJson(whole);
    if (parsed !== undefined) return { via: 'fenced', data: parsed.data };
  }

  /* AMBIGUITY IS NOT A CHOICE.
     If the prose contains several fenced blocks that each parse as JSON, there
     is no principled way to pick one. First-wins scores the model's scratch
     work when it shows its reasoning before the answer; last-wins scores a
     trailing example or a "here's what that looks like in context" block. Both
     rules are arbitrary, and an arbitrary rule applied silently is the worst
     option available: the suite would report a confident number derived from
     a coin flip, and nobody would ever know which block it graded.

     So this reports the ambiguity and lets the case fail visibly. The fix is
     for the author to constrain the output format, not for the harness to
     guess — and `fenceCount` tells them how many candidates there were. */
  const parseable = [...fencedBlocks(text)]
    .map((block) => tryParseJson(block))
    .filter((parsed): parsed is { data: unknown } => parsed !== undefined);

  if (parseable.length > 1) {
    /* AMBIGUOUS, not unreadable. Nothing about the model was established here
       — it produced parseable output and the harness could not choose. That
       distinction decides whether the case is scored 0 and recorded, or
       errored and excluded, so the two arms are separate types. */
    return {
      via: 'ambiguous',
      error:
        `the response contains ${parseable.length} fenced blocks that each parse as ` +
        `JSON, so which one is the answer is ambiguous; constrain the output format ` +
        `or use a tool call`,
      fenceCount: parseable.length,
    };
  }

  const only = parseable[0];
  if (only !== undefined) return { via: 'scavenged', data: only.data };

  /* UNREADABLE. The model was asked for JSON and produced none — a fact about
     the model, not about the harness. It scores 0 and it goes in the baseline,
     so the day a subject stops emitting JSON the suite shows a score drop
     rather than quietly reporting an infrastructure error. */
  return {
    via: 'unreadable',
    error: `expected JSON but no parseable JSON was found: ${snippet(text)}`,
  };
}

/** A wrapper so a successful parse of the literal `null` stays distinguishable
 *  from "not JSON". */
function tryParseJson(text: string): { data: unknown } | undefined {
  try {
    return { data: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** A fence that wraps the entire response, with nothing outside it. */
function stripWholeStringFence(text: string): string | undefined {
  return /^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)?.[1];
}

function* fencedBlocks(text: string): Generator<string> {
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    const body = match[1];
    if (body !== undefined) yield body;
  }
}

function snippet(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 80 ? `"${flat.slice(0, 80)}…"` : `"${flat}"`;
}
