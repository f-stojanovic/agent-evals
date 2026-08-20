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

const pairSchema = z.strictObject({
  id: z.string().min(1),
  provenance: provenanceSchema,
  label: z.enum(['correct', 'incorrect']),
  note: z.string().optional(),
  reference: z.array(z.string().min(1)).min(1),
  candidate: z.string().min(1),
});

export type SemanticPair = {
  id: string;
  provenance: Provenance;
  label: 'correct' | 'incorrect';
  note?: string;
  reference: string[];
  candidate: string;
};

export async function loadSemanticPairs(dir: string): Promise<SemanticPair[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();

  const pairs: SemanticPair[] = [];
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
      pairs.push({
        id: parsed.data.id,
        provenance: toProvenance(parsed.data.provenance),
        label: parsed.data.label,
        reference: [...parsed.data.reference],
        candidate: parsed.data.candidate,
        ...(parsed.data.note !== undefined && { note: parsed.data.note }),
      });
    }
  }
  pairs.sort((a, b) => (a.id < b.id ? -1 : 1));
  return pairs;
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

  return [...lines, '', ...provenanceLine].join('\n');
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
