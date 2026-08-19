/**
 * Rendering a run.
 *
 * Two outputs: markdown to stdout for a human, and a JSON artifact for
 * anything that wants to re-analyse the run later. The artifact is where the
 * material the baseline refuses to carry lives — per-sample values, extraction
 * detail, scorer meta (ADR 003).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatUncalibratedReport } from './uncalibrated.js';
import type { BaselineComparison, CaseComparison } from './baseline.js';
import type { LockedModel } from './models-lock.js';
import type { RunSummary } from './runner.js';

export const ARTIFACT_DIR = '.artifacts';

export type ReportInput = {
  readonly run: RunSummary;
  readonly comparison: BaselineComparison;
  readonly models: Record<string, LockedModel>;
};

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

export function formatReport({ run, comparison, models }: ReportInput): string {
  const byId = new Map(comparison.comparisons.map((c) => [c.caseId, c]));
  const scorerNames = [
    ...new Set(run.results.flatMap((r) => r.scores.map((s) => s.scorer))),
  ].sort();

  const header = ['case', ...scorerNames, 'mean', 'sd', 'Δ vs baseline', 'cost', 'ms'];
  const rows = run.results.map((result) => {
    const comparisonRow = byId.get(result.caseId);
    return [
      `${statusMark(comparisonRow)} ${result.caseId}`,
      ...scorerNames.map((name) => {
        const score = result.scores.find((s) => s.scorer === name);
        return score === undefined ? '—' : score.value.toFixed(2);
      }),
      result.status === 'errored' ? '—' : result.value.toFixed(3),
      result.stdDev === undefined ? '—' : result.stdDev.toFixed(3),
      formatDelta(comparisonRow),
      result.cost === undefined ? '—' : `$${result.cost.totalUsd.toFixed(4)}`,
      String(result.latencyMs),
    ];
  });

  const lines: string[] = [
    `# Eval run — ${run.suiteId}`,
    '',
    `${run.startedAt} · ${run.results.length} cases · ${(run.durationMs / 1000).toFixed(1)}s`,
    '',
    markdownTable(header, rows),
    '',
  ];

  if (comparison.erroredCases.length > 0) {
    lines.push(
      '## Errored',
      '',
      /* Errored is not failed. These cases produced no measurement at all, so
         they are excluded from the baseline rather than recorded as zero. */
      'These cases could not be evaluated. They are excluded from the baseline —',
      'a score of 0 would assert the model was wrong, which was never established.',
      '',
      ...run.results
        .filter((r) => r.status === 'errored')
        .map((r) => `- **${r.caseId}** — ${r.error?.message ?? 'unknown error'}`),
      '',
    );
  }

  if (comparison.regressions.length > 0) {
    lines.push(
      '## Regressions',
      '',
      ...comparison.regressions.map(
        (c) =>
          `- **${c.caseId}** ${c.baselineMean?.toFixed(3)} → ${c.currentMean.toFixed(3)} ` +
          `(${signed(c.delta ?? 0)}, tolerance ±${(c.tolerance ?? 0).toFixed(3)})`,
      ),
      '',
    );
  }

  if (comparison.missingCases.length > 0) {
    lines.push(
      '## Missing from the suite',
      '',
      'The baseline records these cases and the suite no longer contains them.',
      'Deleting a failing case is the cheapest way to make a gate green, so this fails the run.',
      '',
      ...comparison.missingCases.map((id) => `- ${id}`),
      '',
    );
  }

  if (comparison.newCases.length > 0) {
    lines.push(
      '## New cases',
      '',
      'No history, so nothing to regress against. Record them with `--update-baseline`.',
      '',
      ...comparison.newCases.map((c) => `- ${c.caseId} — ${c.currentMean.toFixed(3)}`),
      '',
    );
  }

  if (comparison.modelMismatches.length > 0) {
    lines.push('## Model mismatch', '', ...comparison.modelMismatches.map((m) => `- ${m}`), '');
  }

  lines.push(
    '## Totals',
    '',
    `- cases: ${run.totals.cases} · passed ${run.totals.passed} · failed ${run.totals.failed} · errored ${run.totals.errored}`,
    `- weighted score: **${run.totals.weightedScore.toFixed(3)}**`,
    `- latency: p50 ${run.latency.p50Ms}ms · p95 ${run.latency.p95Ms}ms · max ${run.latency.maxMs}ms`,
    ...costLines(run),
    '',
    '### Output format distribution',
    '',
    /* A metric, not an assertion: it describes how payloads arrived across the
       whole run and grades nothing. `format-compliance` is the scorer that
       grades, per case, against what that case declared. */
    ...formatViaDistribution(run),
    '',
    '### Models',
    '',
    ...(Object.keys(models).length === 0
      ? ['- none (no model-backed scorer ran)']
      : Object.entries(models).map(
          ([slot, model]) =>
            `- ${slot}: \`${model.modelId}\` @ ${model.revision ?? 'unpinned'} (${model.dtype})`,
        )),
    '',
    '### Assumptions',
    '',
    ...formatUncalibratedReport([...run.uncalibrated, ...comparison.uncalibrated])
      .split('\n')
      .map((line) => line.trimEnd()),
    '',
  );

  return lines.join('\n');
}

function costLines(run: RunSummary): string[] {
  if (run.cost === undefined) return ['- cost: not priced (no price table entry for this model)'];
  const subject = run.subjectCost?.totalUsd ?? 0;
  const judge = run.judgeCost?.totalUsd ?? 0;
  return [
    `- cost: **$${run.cost.totalUsd.toFixed(4)}** — subject $${subject.toFixed(4)}, judge $${judge.toFixed(4)}`,
    `- tokens: ${run.usage.inputTokens} in / ${run.usage.outputTokens} out`,
  ];
}

function formatViaDistribution(run: RunSummary): string[] {
  const entries = Object.entries(run.viaDistribution).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return ['- no samples'];
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return entries.map(
    ([via, count]) => `- ${via}: ${count} (${((count / total) * 100).toFixed(0)}%)`,
  );
}

function statusMark(comparison: CaseComparison | undefined): string {
  switch (comparison?.status) {
    case 'regressed':
      return '🔴';
    case 'improved':
      return '🟢';
    case 'errored':
      return '⚠️';
    case 'new':
      return '🆕';
    default:
      return '  ';
  }
}

function formatDelta(comparison: CaseComparison | undefined): string {
  if (comparison === undefined || comparison.delta === undefined) return '—';
  return `${signed(comparison.delta)} (±${(comparison.tolerance ?? 0).toFixed(3)})`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(' | ')} |`;

  return [
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * JSON artifact
 * ------------------------------------------------------------------ */

/**
 * Writes the full run, including everything the baseline refuses to carry.
 *
 * `.artifacts/` is gitignored on purpose: this file exists so a regression can
 * be investigated after the fact, not so it can be reviewed in a diff.
 */
export async function writeArtifact(
  input: ReportInput,
  path = join(ARTIFACT_DIR, 'run.json'),
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        run: input.run,
        comparison: input.comparison,
        models: input.models,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

/** The only thing CI reads. */
export function exitCode(comparison: BaselineComparison): 0 | 1 {
  return comparison.ok ? 0 : 1;
}
