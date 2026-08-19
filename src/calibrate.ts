/**
 * Measuring the judge.
 *
 * THE ARGUMENT
 * ------------
 * An LLM judge is a probabilistic system with unknown accuracy. Adopting one
 * without measuring it does not remove the unmeasured part of your pipeline —
 * it moves it one level down and attaches a number to it, which is worse than
 * leaving it visible, because now there is a figure in the baseline that looks
 * like a measurement.
 *
 * The only thing that makes a judge's scores admissible is a number saying how
 * close it lands to human judgement on cases where a human already decided.
 * That is what this file computes. It is deliberately small: a set of cases
 * with hand-assigned scores, the judge run against the same outputs, and the
 * mean absolute error between them, plus the cases where the two diverge most.
 *
 * A judge with an MAE of 0.08 against a spread calibration set is a usable
 * instrument. One with an MAE of 0.35 is a random number generator with good
 * manners, and no amount of prompt engineering elsewhere in the suite fixes
 * that. You cannot know which you have without running this.
 *
 * WHAT THE NUMBER DOES NOT SAY
 * ----------------------------
 * MAE against a small hand-labelled set is itself an estimate, with its own
 * error, on a set the author chose. It is a floor on honesty, not a
 * certificate. The cases are deliberately spread across the range — clearly
 * right, clearly wrong, and genuinely borderline — because a calibration set
 * made only of easy cases reports a flattering number that says nothing about
 * the cases you actually needed a judge for.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { llmJudge } from './scorers/judge.js';
import { extractStructured } from './scorers/extract.js';
import { formatProvenance, provenanceSchema, summariseProvenance, toProvenance } from './provenance.js';
import type { Provenance, ProvenanceSummary } from './provenance.js';
import type { EvalCase, Scorer, SubjectOutput, Usage } from './types.js';

/**
 * A case whose correct score is already known, because a human assigned it.
 *
 * The FIXED `output` is the whole point: calibration must run the judge against
 * an output that does not move, not against a fresh generation. If the subject
 * were re-run, a changed score could mean the judge drifted or the subject did,
 * and the measurement would be uninterpretable.
 *
 * Fixed is not the same as captured. `provenance` says which — every case here
 * is currently hand-authored, which means the MAE measures the judge against a
 * human's labels on a human's invented outputs. See ADR 015.
 */
export type CalibrationCase = {
  id: string;
  provenance: Provenance;
  description?: string;
  /** The human's score, 0..1. The reference the judge is measured against. */
  humanScore: number;
  /** Why the human scored it that way. Not shown to the judge — it is the
   *  answer key, and showing it would measure the judge's reading
   *  comprehension rather than its judgement. */
  humanReason?: string;
  expect: Record<string, unknown>;
  /** Frozen subject output. */
  output: SubjectOutput;
};

const usageSchema = z.strictObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
});

const calibrationCaseSchema = z.strictObject({
  id: z.string().min(1),
  /* Required, for the same reason it is required on a fixture. */
  provenance: provenanceSchema,
  description: z.string().optional(),
  humanScore: z.number().min(0).max(1),
  humanReason: z.string().optional(),
  expect: z.record(z.string(), z.unknown()),
  output: z.strictObject({
    text: z.string().optional(),
    toolCalls: z
      .array(z.strictObject({ name: z.string(), input: z.unknown(), id: z.string().optional() }))
      .optional(),
    model: z.string().min(1),
    usage: usageSchema.optional(),
    latencyMs: z.number().nonnegative().optional(),
  }),
});

export async function loadCalibrationCases(dir: string): Promise<CalibrationCase[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();

  const cases: CalibrationCase[] = [];
  for (const file of files) {
    const document: unknown = parseYaml(await readFile(file, 'utf8'));
    if (document === null || document === undefined) continue;
    const raw = Array.isArray(document) ? document : [document];

    for (const [index, entry] of raw.entries()) {
      const result = calibrationCaseSchema.safeParse(entry);
      if (!result.success) {
        throw new Error(
          `${file} [case ${index}]: ${result.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      const parsed = result.data;
      cases.push({
        id: parsed.id,
        provenance: toProvenance(parsed.provenance),
        humanScore: parsed.humanScore,
        expect: parsed.expect,
        output: {
          raw: null,
          model: parsed.output.model,
          usage: toUsage(parsed.output.usage),
          latencyMs: parsed.output.latencyMs ?? 0,
          ...(parsed.output.text !== undefined && { text: parsed.output.text }),
          ...(parsed.output.toolCalls !== undefined && {
            toolCalls: parsed.output.toolCalls.map((call) => ({
              name: call.name,
              input: call.input,
              ...(call.id !== undefined && { id: call.id }),
            })),
          }),
        },
        ...(parsed.description !== undefined && { description: parsed.description }),
        ...(parsed.humanReason !== undefined && { humanReason: parsed.humanReason }),
      });
    }
  }

  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cases;
}

export type CalibrationResult = {
  caseId: string;
  humanScore: number;
  judgeScore: number;
  /** Signed, not absolute: the direction matters. A judge that is uniformly
   *  0.15 too generous is miscalibrated and fixable by moving a threshold; one
   *  that is 0.15 off in both directions is noisy and is not. */
  error: number;
  judgeReason: string;
  disagreement: number;
};

export type CalibrationReport = {
  results: CalibrationResult[];
  /** Mean ABSOLUTE error — the headline number. */
  meanAbsoluteError: number;
  /** Mean SIGNED error. Near zero with a high MAE means noise; far from zero
   *  means systematic bias, which is the easier problem to have. */
  meanSignedError: number;
  /** Worst divergences first. */
  worst: CalibrationResult[];
};

/** How many divergent cases the report highlights. */
const WORST_SHOWN = 3;

export async function calibrate(args: {
  cases: readonly CalibrationCase[];
  scorer: Scorer;
}): Promise<CalibrationReport> {
  if (args.cases.length === 0) throw new Error('calibrate: no calibration cases');

  const results: CalibrationResult[] = [];
  for (const calibrationCase of args.cases) {
    const evalCase: EvalCase = {
      id: calibrationCase.id,
      input: null,
      expect: calibrationCase.expect,
    };

    const score = await args.scorer.score({
      case: evalCase,
      output: calibrationCase.output,
      extraction: extractStructured(calibrationCase.output),
    });

    results.push({
      caseId: calibrationCase.id,
      humanScore: calibrationCase.humanScore,
      judgeScore: score.value,
      error: score.value - calibrationCase.humanScore,
      judgeReason: score.reason ?? '',
      disagreement: numberOrZero(score.meta?.['judgeDisagreement']),
    });
  }

  const meanAbsoluteError = mean(results.map((r) => Math.abs(r.error)));
  const meanSignedError = mean(results.map((r) => r.error));
  const worst = [...results]
    .sort((a, b) => Math.abs(b.error) - Math.abs(a.error))
    .slice(0, WORST_SHOWN);

  return { results, meanAbsoluteError, meanSignedError, worst };
}

export function formatCalibrationReport(
  report: CalibrationReport,
  provenance?: ProvenanceSummary,
): string {
  const rows = report.results.map((r) => ({
    id: r.caseId,
    human: r.humanScore.toFixed(2),
    judge: r.judgeScore.toFixed(2),
    error: (r.error >= 0 ? '+' : '') + r.error.toFixed(2),
    spread: r.disagreement.toFixed(2),
  }));

  const width = (key: keyof (typeof rows)[number], header: string): number =>
    Math.max(header.length, ...rows.map((row) => row[key].length));

  const widths = {
    id: width('id', 'case'),
    human: width('human', 'human'),
    judge: width('judge', 'judge'),
    error: width('error', 'error'),
    spread: width('spread', 'spread'),
  };

  const line = (
    id: string,
    human: string,
    judge: string,
    error: string,
    spread: string,
  ): string =>
    `  ${id.padEnd(widths.id)}  ${human.padStart(widths.human)}  ` +
    `${judge.padStart(widths.judge)}  ${error.padStart(widths.error)}  ` +
    `${spread.padStart(widths.spread)}`;

  const lines = [
    'Judge calibration',
    '',
    line('case', 'human', 'judge', 'error', 'spread'),
    line('-'.repeat(widths.id), '-'.repeat(widths.human), '-'.repeat(widths.judge), '-'.repeat(widths.error), '-'.repeat(widths.spread)),
    ...rows.map((row) => line(row.id, row.human, row.judge, row.error, row.spread)),
    '',
    `  mean absolute error : ${report.meanAbsoluteError.toFixed(3)}`,
    `  mean signed error   : ${(report.meanSignedError >= 0 ? '+' : '') + report.meanSignedError.toFixed(3)}`,
    '',
    /* A binary generous/harsh verdict on a signed error of +0.006 would be a
       confident claim about noise. The neutral band is one tenth of the
       absolute error, so the sentence only fires when the bias is a real
       fraction of the spread it sits in. */
    describeBias(report),
    '',
    '  Largest divergences:',
    ...report.worst.map(
      (r) => `    ${r.caseId} (human ${r.humanScore.toFixed(2)}, judge ${r.judgeScore.toFixed(2)}): ${r.judgeReason}`,
    ),
    /* An MAE is agreement between a judge and a set of labels. Saying where the
       labels AND the outputs came from is part of reporting the number. */
    ...(provenance === undefined ? [] : ['', ...formatProvenance(provenance)]),
  ];

  return lines.join('\n');
}

/** Rebuilt key-by-key so absent cache counts stay absent rather than becoming
 *  present-and-undefined, which `exactOptionalPropertyTypes` treats as a
 *  different type — the same conversion the case loader performs. */
function toUsage(usage: z.infer<typeof usageSchema> | undefined): Usage {
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
  };
}

function describeBias(report: CalibrationReport): string {
  const bias = report.meanSignedError;
  /* Half the absolute error. Below that the lean is a fraction of the noise it
     sits in, and naming a direction would be a confident claim about nothing.
     Observed: two consecutive runs of the same calibration set produced signed
     errors of +0.006 and -0.006. */
  if (Math.abs(bias) < report.meanAbsoluteError / 2) {
    return (
      `  No systematic bias: the signed error (${bias >= 0 ? '+' : ''}${bias.toFixed(3)}) is ` +
      `small against the absolute error, so the judge's misses cancel rather than lean.`
    );
  }
  return bias > 0
    ? '  The judge is systematically more generous than the human.'
    : '  The judge is systematically harsher than the human.';
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/* `npm run calibrate`. Guarded so importing this module for its exports — as
   the tests do — never fires an API call. */
if (process.argv[1] !== undefined && process.argv[1].endsWith('calibrate.ts')) {
  const cases = await loadCalibrationCases('evals/calibration');
  const scorer = llmJudge();
  const report = await calibrate({ cases, scorer });
  console.log(formatCalibrationReport(report, summariseProvenance('calibration set', cases)));
  const { collectUncalibrated, formatUncalibratedReport } = await import('./uncalibrated.js');
  console.log(`\n${formatUncalibratedReport(collectUncalibrated([scorer]))}`);
}
