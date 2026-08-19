/**
 * Where a piece of test data came from, as a required field.
 *
 * WHY THIS IS A TYPE AND NOT A COMMENT
 * ------------------------------------
 * `src/fixtures.ts` used to open with "This is not a mock in the testing sense.
 * The recorded outputs are real responses from a real model, frozen". They were
 * not. They were written by hand, in the same session that wrote the sentence
 * claiming otherwise, and the committed YAML repeated it: "These are frozen
 * responses, not hand-written mocks."
 *
 * Nothing caught it. It was a plausible-sounding claim about provenance,
 * sitting in a doc comment, and doc comments are not reviewed against reality —
 * they are read as context by whoever is already trusting the file. It survived
 * until a separate pass forced every claim in the repository to be checked
 * against what had actually been executed.
 *
 * A false claim about where data came from is categorically worse than a
 * documented limitation. A limitation is a fact a reader can price in; a false
 * provenance claim makes every number derived from that data uninterpretable,
 * because the reader cannot tell which of the other claims were checked either.
 *
 * So provenance stops being prose. Every fixture and every calibration case
 * carries this field, it is required by the schema, and the two arms are
 * structurally different — a hand-authored entry has no place to put a model
 * name, and a recorded one cannot omit when it was captured. Writing a fixture
 * without saying where it came from is now a load-time error, and dressing a
 * hand-written one up as a recording takes deliberate lying rather than an
 * unchecked adjective.
 */

import { z } from 'zod';

export type Provenance =
  /** Written by a person. The honest label for most test data, and the one
   *  that must never be silently upgraded to `recorded`. */
  | { kind: 'hand-authored'; author: string; note?: string }
  /** Captured from a real model run. `capturedAt` is required because a
   *  recording with no date cannot be checked against the model it claims. */
  | { kind: 'recorded'; model: string; revision?: string; capturedAt: string };

export const provenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hand-authored'),
    author: z.string().min(1),
    note: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('recorded'),
    model: z.string().min(1),
    revision: z.string().optional(),
    /** ISO date or timestamp. */
    capturedAt: z.string().min(1),
  }),
]);

/** Rebuilds the parsed value so absent optional keys stay absent under
 *  `exactOptionalPropertyTypes`, matching what the loaders do elsewhere. */
export function toProvenance(parsed: z.infer<typeof provenanceSchema>): Provenance {
  if (parsed.kind === 'hand-authored') {
    return {
      kind: 'hand-authored',
      author: parsed.author,
      ...(parsed.note !== undefined && { note: parsed.note }),
    };
  }
  return {
    kind: 'recorded',
    model: parsed.model,
    capturedAt: parsed.capturedAt,
    ...(parsed.revision !== undefined && { revision: parsed.revision }),
  };
}

export type ProvenanceSummary = {
  /** What the data is for, e.g. "fixtures" or "calibration set". */
  label: string;
  total: number;
  handAuthored: number;
  recorded: number;
  /** Distinct models named by the recorded entries. */
  models: string[];
  /** Distinct authors named by the hand-authored entries. */
  authors: string[];
};

export function summariseProvenance(
  label: string,
  items: readonly { provenance: Provenance }[],
): ProvenanceSummary {
  const handAuthored = items.filter((i) => i.provenance.kind === 'hand-authored');
  const recorded = items.filter(
    (i): i is { provenance: Extract<Provenance, { kind: 'recorded' }> } =>
      i.provenance.kind === 'recorded',
  );

  return {
    label,
    total: items.length,
    handAuthored: handAuthored.length,
    recorded: recorded.length,
    models: [...new Set(recorded.map((i) => i.provenance.model))].sort(),
    authors: [
      ...new Set(
        handAuthored.map((i) => (i.provenance as Extract<Provenance, { kind: 'hand-authored' }>).author),
      ),
    ].sort(),
  };
}

/**
 * One line for the report.
 *
 * A suite running entirely on hand-authored data says so in its own output,
 * not only in a document somebody has to go and read. The number in front of a
 * reader should carry the provenance of the data that produced it.
 */
export function formatProvenance(summary: ProvenanceSummary): string[] {
  if (summary.total === 0) return [`- ${summary.label}: none`];

  const parts: string[] = [];
  if (summary.recorded > 0) {
    parts.push(
      `${summary.recorded} recorded${summary.models.length > 0 ? ` from ${summary.models.join(', ')}` : ''}`,
    );
  }
  if (summary.handAuthored > 0) {
    parts.push(
      `${summary.handAuthored} hand-authored${summary.authors.length > 0 ? ` by ${summary.authors.join(', ')}` : ''}`,
    );
  }

  const lines = [`- ${summary.label}: ${summary.total} total — ${parts.join(', ')}`];

  if (summary.recorded === 0) {
    /* Stated outright rather than left to be inferred from a count: a run whose
       inputs were all invented is testing the harness, not the model, and the
       report is where that belongs. */
    lines.push(
      `  ⚠ every input was written by hand. This run exercised the harness, not ` +
        `the model that would produce these responses.`,
    );
  }

  return lines;
}
