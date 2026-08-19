/**
 * Measuring how much the judge disagrees with itself.
 *
 * A SEPARATE QUESTION, ASKED SEPARATELY
 * -------------------------------------
 * A suite run measures how much the SUBJECT varies: each sample is a fresh
 * generation, and the spread that lands in the baseline is the spread
 * production sees. The judge votes once per sample there, on purpose — see the
 * note in scorers/judge.ts. Averaging k verdicts inside a case would shrink the
 * recorded variance by roughly √k and make the baseline claim a stability the
 * deployed system does not have.
 *
 * Judge variance is a real thing worth knowing and it is a different
 * measurement: hold the output FIXED, ask the judge k times, and look at the
 * spread. Here averaging is the goal rather than a contaminant, because the
 * only thing that can move between votes is the judge.
 *
 * The two numbers answer different questions and neither substitutes for the
 * other:
 *
 *   - high subject variance → the model is inconsistent; the case may be a coin
 *     flip in production.
 *   - high judge variance   → the rubric does not decide the case, or the judge
 *     cannot apply it. The scores are noisy regardless of the model.
 *
 * Run against the calibration set, whose outputs are already frozen for exactly
 * this reason.
 */

import { llmJudge } from './scorers/judge.js';
import { loadCalibrationCases } from './calibrate.js';
import { extractStructured } from './scorers/extract.js';
import type { CalibrationCase } from './calibrate.js';
import type { Scorer } from './types.js';

/** Verdicts per output. Odd, so the median is a real sample. */
export const VARIANCE_SAMPLES = 5;

export type JudgeVarianceCase = {
  caseId: string;
  values: number[];
  median: number;
  /** max − min. The blunt measure, and the one a reader can check by eye. */
  spread: number;
  stdDev: number;
  confidences: number[];
};

export type JudgeVarianceReport = {
  samples: number;
  cases: JudgeVarianceCase[];
  meanSpread: number;
  /** Cases whose spread exceeds the judge's own disagreement threshold. */
  contested: JudgeVarianceCase[];
};

export async function measureJudgeVariance(args: {
  cases: readonly CalibrationCase[];
  scorer: Scorer;
  disagreementThreshold?: number;
}): Promise<JudgeVarianceReport> {
  const threshold = args.disagreementThreshold ?? 0.25;
  const cases: JudgeVarianceCase[] = [];

  for (const calibrationCase of args.cases) {
    const score = await args.scorer.score({
      case: { id: calibrationCase.id, input: null, expect: calibrationCase.expect },
      output: calibrationCase.output,
      extraction: extractStructured(calibrationCase.output),
    });

    const values = numbers(score.meta?.['values']);
    cases.push({
      caseId: calibrationCase.id,
      values,
      median: score.value,
      spread: values.length === 0 ? 0 : Math.max(...values) - Math.min(...values),
      stdDev: populationStdDev(values),
      confidences: numbers(score.meta?.['confidences']),
    });
  }

  return {
    samples: VARIANCE_SAMPLES,
    cases,
    meanSpread: mean(cases.map((c) => c.spread)),
    contested: cases.filter((c) => c.spread > threshold),
  };
}

export function formatJudgeVarianceReport(report: JudgeVarianceReport): string {
  const rows = report.cases.map((c) => ({
    id: c.caseId,
    median: c.median.toFixed(2),
    spread: c.spread.toFixed(2),
    sd: c.stdDev.toFixed(3),
    values: c.values.map((v) => v.toFixed(2)).join(' '),
  }));

  const width = (key: keyof (typeof rows)[number], header: string): number =>
    Math.max(header.length, ...rows.map((row) => row[key].length));
  const widths = {
    id: width('id', 'case'),
    median: width('median', 'median'),
    spread: width('spread', 'spread'),
    sd: width('sd', 'sd'),
    values: width('values', 'verdicts'),
  };
  const line = (id: string, median: string, spread: string, sd: string, values: string): string =>
    `  ${id.padEnd(widths.id)}  ${median.padStart(widths.median)}  ` +
    `${spread.padStart(widths.spread)}  ${sd.padStart(widths.sd)}  ${values}`;

  return [
    `Judge self-consistency — ${report.samples} verdicts per fixed output`,
    '',
    line('case', 'median', 'spread', 'sd', 'verdicts'),
    line(
      '-'.repeat(widths.id),
      '-'.repeat(widths.median),
      '-'.repeat(widths.spread),
      '-'.repeat(widths.sd),
      '-'.repeat(widths.values),
    ),
    ...rows.map((row) => line(row.id, row.median, row.spread, row.sd, row.values)),
    '',
    `  mean spread : ${report.meanSpread.toFixed(3)}`,
    `  contested   : ${report.contested.length} of ${report.cases.length} case(s)`,
    ...(report.contested.length > 0
      ? [
          '',
          '  The judge disagreed with itself on:',
          ...report.contested.map(
            (c) => `    ${c.caseId} — ${c.values.map((v) => v.toFixed(2)).join(', ')}`,
          ),
          '',
          '  That is a finding about the rubric, not noise to average away: a case',
          '  the judge cannot decide twice the same way is a case the rubric does',
          '  not settle.',
        ]
      : []),
    '',
    '  This is the judge holding still while the output does. It says nothing',
    '  about how much the SUBJECT varies — that is what a suite run measures,',
    '  with the judge voting once per sample.',
  ].join('\n');
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function populationStdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/* `npm run judge:variance`. Guarded so importing this module never fires an
   API call. */
if (process.argv[1] !== undefined && process.argv[1].endsWith('judge-variance.ts')) {
  const cases = await loadCalibrationCases('evals/calibration');
  const scorer = llmJudge({ samples: VARIANCE_SAMPLES });
  console.log(formatJudgeVarianceReport(await measureJudgeVariance({ cases, scorer })));
  const { formatProvenance, summariseProvenance } = await import('./provenance.js');
  console.log(`\n${formatProvenance(summariseProvenance('calibration set', cases)).join('\n')}`);
}
