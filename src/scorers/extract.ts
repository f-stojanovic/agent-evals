/**
 * Getting structured data out of whatever the model actually produced.
 *
 * Every scorer that compares fields needs this, and every scorer needs it to
 * behave the same way, or two scorers will disagree about whether the same
 * response contained JSON at all.
 */

import type { SubjectOutput } from '../types.js';

/**
 * Success carries the parsed value; failure carries a sentence a human can
 * read in a report. A discriminated union rather than `data: unknown | null`,
 * so `null` stays available as a legitimate extracted value.
 */
export type Extraction = { data: unknown } | { error: string };

/**
 * Pulls the structured payload out of a subject's output.
 *
 * Resolution order, most to least trustworthy:
 *
 *   1. The input of the first tool call. If the model was given a tool, using
 *      it is the intended path, and the provider has already parsed and
 *      (usually) schema-checked the arguments.
 *   2. `output.text` parsed as JSON — the response-format / "just return JSON"
 *      path.
 *   3. `output.text` with a leading and trailing markdown fence stripped, then
 *      parsed. Chat-tuned models wrap JSON in ```json ... ``` constantly, and
 *      penalising that would measure formatting compliance rather than
 *      extraction quality.
 *
 * WHY THIS NEVER THROWS
 * ---------------------
 * A model returning prose where JSON was expected is a *result*, not an
 * exception. It is one of the most interesting things a suite can tell you:
 * it means the prompt lost its grip on the output format, and you want that
 * recorded as 0.0 with a reason, sitting in the baseline next to every other
 * case, visible as a regression the day it starts happening.
 *
 * Throwing would instead abort the case, and a runner cannot tell "the model
 * wrote an essay" apart from "the API connection dropped". One is a quality
 * signal to act on; the other is infrastructure noise to retry. That
 * distinction is most of what separates an eval harness from a test runner —
 * a test runner is entitled to treat unexpected output as an error, because
 * its subject is deterministic. Ours is not.
 */
export function extractStructured(output: SubjectOutput): Extraction {
  const firstCall = output.toolCalls?.[0];
  if (firstCall !== undefined) return { data: firstCall.input };

  const text = output.text;
  if (text === undefined || text.trim() === '') {
    return {
      error: output.toolCalls?.length === 0
        ? 'the subject returned an empty tool call list and no text'
        : 'the subject returned no text and made no tool calls',
    };
  }

  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  const unfenced = stripFence(text);
  if (unfenced !== undefined) {
    const fenced = tryParseJson(unfenced);
    if (fenced !== undefined) return fenced;
  }

  return {
    error:
      `expected JSON but the response did not parse as JSON` +
      `${unfenced !== undefined ? ' (a markdown fence was stripped first)' : ''}: ${snippet(text)}`,
  };
}

/** `undefined` means "not JSON", distinct from a successful parse of the
 *  literal `null`, which is a valid JSON document. */
function tryParseJson(text: string): Extraction | undefined {
  try {
    return { data: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Strips a fence that wraps the *whole* response. Returns `undefined` when
 * there is no such fence.
 *
 * Deliberately not a scan for the first fenced block anywhere in the text: a
 * model that writes three paragraphs and then a code block has not complied
 * with the output format, and digging the JSON out of the prose would hide
 * that from the score. Leniency here silently changes what the suite measures
 * — extraction quality becomes extraction quality *plus* however clever the
 * harness is at scavenging.
 */
function stripFence(text: string): string | undefined {
  const match = /^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return match?.[1];
}

function snippet(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 80 ? `"${flat.slice(0, 80)}…"` : `"${flat}"`;
}
