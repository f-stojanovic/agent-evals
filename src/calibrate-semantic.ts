/**
 * Calibrating the semantic threshold, or establishing that it cannot be.
 *
 * The semantic scorer's cutoff defaults to 0.8, and that number was invented.
 * On the live suite it marks three demonstrably correct summaries — 0.54, 0.76,
 * 0.79 — as below threshold, which says something about the constant and
 * nothing about the model. This file replaces the guess with a measurement
 * against hand-labelled pairs.
 *
 * A FAILED CALIBRATION IS A RESULT. If the correct and incorrect groups
 * overlap, there is no threshold that separates them, and picking one anyway
 * would encode a number that splits data it cannot split — the exact failure
 * ADR 010 exists to prevent, committed with a calibration report attached to
 * make it look earned. So the report says the groups overlap, names the pairs
 * responsible, and recommends leaving the constant declared as uncalibrated.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { cosineSimilarity, localEmbedder } from './scorers/semantic.js';
import { formatProvenance, provenanceSchema, summariseProvenance, toProvenance } from './provenance.js';
import type { Embedder } from './scorers/semantic.js';
import type { Provenance } from './provenance.js';

/**
 * The texts, with no label attached.
 *
 * The label used to live here, under an id that spelled it out
 * (`sem-good-refund-01`, `sem-wrong-topic-01`) beside a note that said it
 * outright ("THE FLUENT LIE"). This file is what an annotator opens, so all
 * three were an answer key sitting in front of the person being asked for the
 * answer. See ADR 021.
 */
const pairSchema = z.strictObject({
  id: z.string().min(1),
  provenance: provenanceSchema,
  reference: z.array(z.string().min(1)).min(1),
  candidate: z.string().min(1),
});

/** The answer key, loaded from a file the annotator is not looking at. */
const labelSchema = z.strictObject({
  label: z.enum(['correct', 'incorrect']),
  /** Who assigned it. Only `human` satisfies ADR 021; `generated` is the
   *  outgoing state and is recorded rather than hidden. */
  source: z.enum(['human', 'generated']),
  /**
   * For an `incorrect` pair, HOW it is wrong.
   *
   * This used to be inferable from the id — `sem-wrong-fluent-action-01` said
   * "fluent" in its name, and a test filtered on that substring to assert the
   * set contains real fluent lies rather than only gibberish. Opaque ids
   * removed the substring, and it cannot be recovered from the text: lexical
   * overlap ranks the fluent-severity pair (0.128) BELOW the off-topic one
   * (0.167), because its fluency is semantic. So the property is recorded
   * rather than inferred, and it lives here because it is answer key.
   */
  negativeKind: z.enum(['fluent', 'off-topic', 'vacuous']).optional(),
  /** The original descriptive id, kept so the renaming is reversible and the
   *  pairing can be audited without trusting that it was done correctly. */
  wasId: z.string().min(1).optional(),
  wasNote: z.string().optional(),
});

export type LabelSource = 'human' | 'generated';
export type NegativeKind = 'fluent' | 'off-topic' | 'vacuous';

export type SemanticPair = {
  id: string;
  provenance: Provenance;
  label: 'correct' | 'incorrect';
  labelSource: LabelSource;
  negativeKind?: NegativeKind;
  reference: string[];
  candidate: string;
};

export const DEFAULT_LABELS_FILE = 'evals/calibration-semantic-labels.yaml';

export async function loadSemanticPairs(
  dir: string,
  labelsFile: string = DEFAULT_LABELS_FILE,
): Promise<SemanticPair[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();

  const labels = await loadLabels(labelsFile);

  const pairs: SemanticPair[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const document: unknown = parseYaml(await readFile(file, 'utf8'));
    if (document === null || document === undefined) continue;

    for (const [index, entry] of (Array.isArray(document) ? document : [document]).entries()) {
      const parsed = pairSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(
          `${file} [pair ${index}]: ${parsed.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`,
        );
      }
      const label = labels.get(parsed.data.id);
      /* An unlabelled pair must not load as an unmeasured row. Splitting the
         files bought secrecy from the annotator and cost the guarantee that a
         label exists at all, so the join replaces it. */
      if (label === undefined) {
        throw new Error(
          `${file} [pair ${index}]: "${parsed.data.id}" has no label in ${labelsFile}. ` +
            `Every pair needs one, or it is carried through the calibration measuring nothing.`,
        );
      }
      /* A `negativeKind` on a positive label is a relabelling half done: the
         label flipped and the metadata describing how it was wrong did not. */
      if (label.label === 'correct' && label.negativeKind !== undefined) {
        throw new Error(
          `${labelsFile} [${parsed.data.id}]: labelled "correct" but carries ` +
            `negativeKind "${label.negativeKind}", which only describes an incorrect pair.`,
        );
      }
      seen.add(parsed.data.id);
      pairs.push({
        id: parsed.data.id,
        provenance: toProvenance(parsed.data.provenance),
        label: label.label,
        labelSource: label.source,
        reference: [...parsed.data.reference],
        candidate: parsed.data.candidate,
        ...(label.negativeKind !== undefined && { negativeKind: label.negativeKind }),
      });
    }
  }

  /* And the other direction: a label with no pair means a rename went half
     done, and the pair it used to describe is now unlabelled somewhere else —
     or was deleted, which is the cheapest way to drop an inconvenient row. */
  const orphaned = [...labels.keys()].filter((id) => !seen.has(id)).sort();
  if (orphaned.length > 0) {
    throw new Error(
      `${labelsFile}: labels with no matching pair: ${orphaned.join(', ')}. ` +
        `Either the pair was renamed and the label was not, or it was deleted.`,
    );
  }

  pairs.sort((a, b) => (a.id < b.id ? -1 : 1));
  return pairs;
}

async function loadLabels(
  file: string,
): Promise<Map<string, z.infer<typeof labelSchema>>> {
  const document: unknown = parseYaml(await readFile(file, 'utf8'));
  if (document === null || document === undefined || typeof document !== 'object') {
    throw new Error(`${file}: expected a mapping of pair id to label`);
  }

  const labels = new Map<string, z.infer<typeof labelSchema>>();
  for (const [id, raw] of Object.entries(document as Record<string, unknown>)) {
    const parsed = labelSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${file} [${id}]: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    labels.set(id, parsed.data);
  }
  return labels;
}

export type ScoredPair = SemanticPair & { similarity: number };

export type SemanticCalibration = {
  scored: ScoredPair[];
  /** Lowest similarity among pairs a human called correct. */
  minCorrect: number;
  /** Highest similarity among pairs a human called incorrect. */
  maxIncorrect: number;
  /** minCorrect − maxIncorrect. Positive means the groups separate. */
  margin: number;
  separates: boolean;
  /** Only when the groups separate: the midpoint of the gap. */
  threshold?: number;
  /** Pairs sitting inside the overlap, which are why it failed. */
  overlapping: ScoredPair[];
};

export async function calibrateSemantic(args: {
  pairs: readonly SemanticPair[];
  embedder: Embedder;
}): Promise<SemanticCalibration> {
  if (args.pairs.length === 0) throw new Error('calibrateSemantic: no pairs');

  const scored: ScoredPair[] = [];
  for (const pair of args.pairs) {
    const vectors = await args.embedder.embed([pair.candidate, ...pair.reference]);
    const candidate = vectors[0];
    if (candidate === undefined) throw new Error('embedder returned no vectors');
    /* Max over references, matching exactly what the scorer does — calibrating
       against a different statistic than the one in use would be worthless. */
    const similarity = Math.max(
      ...pair.reference.map((_, i) => {
        const reference = vectors[i + 1];
        return reference === undefined ? 0 : cosineSimilarity(candidate, reference);
      }),
    );
    scored.push({ ...pair, similarity });
  }

  const correct = scored.filter((p) => p.label === 'correct');
  const incorrect = scored.filter((p) => p.label === 'incorrect');
  if (correct.length === 0 || incorrect.length === 0) {
    throw new Error('calibrateSemantic: need at least one pair of each label');
  }

  const minCorrect = Math.min(...correct.map((p) => p.similarity));
  const maxIncorrect = Math.max(...incorrect.map((p) => p.similarity));
  const margin = minCorrect - maxIncorrect;
  const separates = margin > 0;

  return {
    scored,
    minCorrect,
    maxIncorrect,
    margin,
    separates,
    ...(separates && { threshold: round((minCorrect + maxIncorrect) / 2) }),
    overlapping: scored.filter((p) =>
      p.label === 'correct' ? p.similarity <= maxIncorrect : p.similarity >= minCorrect,
    ),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatSemanticCalibration(
  report: SemanticCalibration,
  provenanceLine: readonly string[] = [],
): string {
  const rows = [...report.scored].sort((a, b) => b.similarity - a.similarity);
  const width = Math.max(...rows.map((r) => r.id.length), 4);

  const lines = [
    'Semantic threshold calibration',
    '',
    `  ${'pair'.padEnd(width)}  label      cosine`,
    `  ${'-'.repeat(width)}  ---------  ------`,
    ...rows.map(
      (r) => `  ${r.id.padEnd(width)}  ${r.label.padEnd(9)}  ${r.similarity.toFixed(3)}`,
    ),
    '',
    `  lowest correct   : ${report.minCorrect.toFixed(3)}`,
    `  highest incorrect: ${report.maxIncorrect.toFixed(3)}`,
    `  margin           : ${report.margin >= 0 ? '+' : ''}${report.margin.toFixed(3)}`,
    '',
  ];

  if (report.separates) {
    lines.push(
      `  SEPARATES. Every correct pair scores above every incorrect one, so a`,
      `  threshold of ${report.threshold?.toFixed(3)} splits them with room on both sides.`,
      '',
      `  Use it: semanticSimilarity({ threshold: ${report.threshold} }). Once set`,
      `  explicitly it stops being reported as an uncalibrated constant, because`,
      `  it stops being a guess.`,
    );
  } else {
    lines.push(
      `  DOES NOT SEPARATE. ${report.overlapping.length} pair(s) sit in the overlap:`,
      ...report.overlapping.map(
        (p) => `    ${p.id} (${p.label}) at ${p.similarity.toFixed(3)}`,
      ),
      '',
      `  There is no threshold that classifies this set correctly, so none is`,
      `  recommended. Leaving the default declared as an uncalibrated constant is`,
      `  the honest outcome: a number chosen to split overlapping data would look`,
      `  measured and would not be.`,
      '',
      `  What this actually shows is a limit of the scorer, not of the set. A`,
      `  fluent summary that is confidently wrong about a fact sits close to a`,
      `  correct one in embedding space, because it is about the same thing. The`,
      `  fix is not a better threshold; it is not relying on this scorer alone.`,
    );
  }

  /* Who assigned the labels sits next to the number they produced, for the
     same reason provenance does (ADR 015, ADR 021): a separation figure means
     one thing measured against a human's labels and another entirely against
     labels the system under test wrote. */
  const generated = report.scored.filter((p) => p.labelSource === 'generated');
  const labelLine =
    generated.length === 0
      ? ['  Labels: all assigned by a human.']
      : [
          `  ⚠ Labels: ${generated.length} of ${report.scored.length} were GENERATED, not assigned`,
          `    by a human. To that extent this figure is a model agreeing with itself`,
          `    rather than a measurement. See ADR 021.`,
        ];

  return [...lines, '', ...labelLine, ...(provenanceLine.length > 0 ? [''] : []), ...provenanceLine].join('\n');
}

/* `npm run calibrate:semantic`. Local encoder only — no API key, no cost. */
if (process.argv[1] !== undefined && process.argv[1].endsWith('calibrate-semantic.ts')) {
  const pairs = await loadSemanticPairs('evals/calibration-semantic');
  const embedder = localEmbedder();
  const report = await calibrateSemantic({ pairs, embedder });
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    '.artifacts/calibrate-semantic.json',
    `${JSON.stringify({ report, model: await embedder.locked() }, null, 2)}\n`,
  );
  console.log(
    formatSemanticCalibration(report, formatProvenance(summariseProvenance('pairs', pairs))),
  );
}
