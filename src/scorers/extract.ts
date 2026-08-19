/**
 * Getting structured data out of whatever the model actually produced.
 *
 * Every scorer that compares fields needs this, and every scorer needs it to
 * behave the same way, or two scorers will disagree about whether the same
 * response contained JSON at all.
 */

import type { SubjectOutput } from '../types.js';

/**
 * How the payload had to be recovered, from most to least compliant.
 *
 *   - `tool-call`  — the model used the tool it was given.
 *   - `json`       — the whole response was JSON.
 *   - `fenced`     — the whole response was a single markdown code fence.
 *   - `scavenged`  — a fenced block had to be dug out of surrounding prose.
 */
export type ExtractionRoute = 'tool-call' | 'json' | 'fenced' | 'scavenged';

/**
 * Success carries the parsed value and the route it came by; failure carries a
 * sentence a human can read in a report. A discriminated union rather than
 * `data: unknown | null`, so `null` stays available as a legitimate extracted
 * value.
 */
export type Extraction = { data: unknown; via: ExtractionRoute } | { error: string };

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
 * are different properties of a response. A scorer that refuses to parse the
 * prose-wrapped case is not measuring extraction strictly — it is measuring
 * the two properties multiplied together, and reporting a number that cannot
 * distinguish a model that misread the email from one that read it perfectly
 * and said "Here you go:" first. Those call for completely different fixes.
 *
 * So this recovers the payload wherever it is, records HOW it had to be
 * recovered in `via`, and leaves format to `formatCompliance`, which scores
 * `via` directly. Two readable numbers instead of one muddled one.
 *
 * The direction of this choice also matters for the baseline. Being lenient
 * now and measuring format separately is additive: existing recorded scores
 * stay valid and a new column appears next to them. Being strict now and
 * relaxing later would move every extraction score upward at once, which is
 * indistinguishable in the baseline from the model getting better — a silent
 * rewrite of history that the gate cannot flag.
 *
 * WHY THIS NEVER THROWS
 * ---------------------
 * A model returning prose where JSON was expected is a *result*, not an
 * exception. It belongs in the baseline as 0.0 with a reason, visible as a
 * regression the day it starts happening. Throwing would abort the case, and
 * a runner cannot tell "the model wrote an essay" apart from "the connection
 * dropped" — one is a quality signal to act on, the other is infrastructure
 * noise to retry. That distinction is most of what separates an eval harness
 * from a test runner, whose subject is entitled to be deterministic.
 */
export function extractStructured(output: SubjectOutput): Extraction {
  const firstCall = output.toolCalls?.[0];
  if (firstCall !== undefined) return { data: firstCall.input, via: 'tool-call' };

  const text = output.text;
  if (text === undefined || text.trim() === '') {
    return {
      error:
        output.toolCalls?.length === 0
          ? 'the subject returned an empty tool call list and no text'
          : 'the subject returned no text and made no tool calls',
    };
  }

  const direct = tryParseJson(text);
  if (direct !== undefined) return { data: direct.data, via: 'json' };

  const whole = stripWholeStringFence(text);
  if (whole !== undefined) {
    const parsed = tryParseJson(whole);
    if (parsed !== undefined) return { data: parsed.data, via: 'fenced' };
  }

  for (const block of fencedBlocks(text)) {
    const parsed = tryParseJson(block);
    if (parsed !== undefined) return { data: parsed.data, via: 'scavenged' };
  }

  return { error: `expected JSON but no parseable JSON was found: ${snippet(text)}` };
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

/** Every fenced block in the text, in order. The first one that parses wins:
 *  a model that emits several is usually showing its working before the
 *  answer, and later blocks are as often commentary as payload. */
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
