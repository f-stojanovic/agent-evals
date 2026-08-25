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
import { formatProvenance } from './provenance.js';
import type { ProvenanceSummary } from './provenance.js';
import type { BaselineComparison, CaseComparison } from './baseline.js';
import type { LockedModel } from './models-lock.js';
import type { RunSummary } from './runner.js';

export const ARTIFACT_DIR = '.artifacts';

export type ReportInput = {
  readonly run: RunSummary;
  readonly comparison: BaselineComparison;
  readonly models: Record<string, LockedModel>;
  /** Where the replayed inputs came from, when the run replayed any. Absent
   *  for a live run, which has no test data to attribute. */
  readonly provenance?: ProvenanceSummary;
};

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

export function formatReport({ run, comparison, models, provenance }: ReportInput): string {
  const byId = new Map(comparison.comparisons.map((c) => [c.caseId, c]));
  const scorerNames = [
    ...new Set(run.results.flatMap((r) => r.scores.map((s) => s.scorer))),
  ].sort();

  const header = ['case', ...scorerNames, 'mean', 'sd', 'Δ vs baseline', 'via', 'cost', 'ms'];
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
      /* Per case, not only suite-wide. The first live run fenced 5/5 on one
         case, 4/5 on another and 0/5 on a third under an identical system
         prompt — so the envelope tracks the INPUT, not the instruction, and a
         suite total would have averaged that finding away. */
      formatCaseVias(result.vias),
      result.cost === undefined ? '—' : `$${result.cost.totalUsd.toFixed(4)}`,
      String(result.latencyMs),
    ];
  });

  const lines: string[] = [
    `# Eval run — ${run.suiteId}`,
    '',
    `${run.startedAt} · ${run.results.length} cases · ${(run.durationMs / 1000).toFixed(1)}s`,
    '',
    /* THE GATE'S ANSWER, FIRST AND ON ITS OWN LINE.
       An earlier version printed "passed 0 · failed 3" above an exit code of 0,
       which reads as a broken suite. Those are different questions: the tally
       counts cases below each scorer's own threshold, and the gate asks only
       whether anything got worse than the recorded baseline. A suite can be
       usefully green while every case is imperfect — that is the normal state
       of an eval suite, and the report should not make it look like failure. */
    gateVerdict(comparison),
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
      ...comparison.regressions.flatMap((c) => [
        `- **${c.caseId}** ${c.baselineMean?.toFixed(3)} → ${c.currentMean.toFixed(3)} ` +
          `(${signed(c.delta ?? 0)}, tolerance ±${(c.tolerance ?? 0).toFixed(3)})`,
        /* Named individually. A case flagged only by the per-scorer screen has
           a case mean sitting comfortably inside tolerance, so printing the
           mean alone would read as a gate firing on a number that did not
           move — which is how a correct failure gets dismissed as a flake. */
        ...(c.scorerRegressions ?? []).map(
          (s) =>
            `  - \`${s.scorer}\` ${s.baselineMean.toFixed(3)} → ${s.currentMean.toFixed(3)} ` +
            `(${signed(s.delta)}, tolerance ±${s.tolerance.toFixed(3)}) — this scorer alone`,
        ),
      ]),
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

  if (comparison.scorerSetMismatch.length > 0) {
    /* Its own heading, not folded into the regressions list. The whole point
       of detecting this is that it is NOT a regression. */
    lines.push(
      '## Scorer set changed',
      '',
      ...comparison.scorerSetMismatch.map((m) => `- ${m}`),
      '',
    );
  }

  lines.push(
    '## Totals',
    '',
    `- cases: ${run.totals.cases} · below threshold: ${run.totals.failed} of ${run.totals.cases} · errored ${run.totals.errored}`,
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
    '### Test data provenance',
    '',
    /* Printed on every run, not left to a document. A suite whose inputs were
       all invented is testing the harness rather than the model, and the
       report is where a reader finds that out. */
    ...(provenance === undefined
      ? ['- live subject: responses came from the model, not from replayed data']
      : formatProvenance(provenance)),
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

/** One line, unmissable, saying what the exit code will be and why. */
function gateVerdict(comparison: BaselineComparison): string {
  if (comparison.ok) return '**GATE: PASS** — no regression against the baseline.';

  const reasons: string[] = [];
  if (comparison.regressions.length > 0) {
    /* Distinguished on the verdict line, because the two look completely
       different in the table: a mean regression shows a number that visibly
       moved, a scorer-only one shows a case sitting inside its tolerance. A
       reader who is not told which they are looking at concludes the gate
       misfired. */
    const scorerOnly = comparison.regressions.filter(
      (c) => (c.scorerRegressions?.length ?? 0) > 0 && !((c.delta ?? 0) < -(c.tolerance ?? 0)),
    ).length;
    reasons.push(
      `${comparison.regressions.length} regression${comparison.regressions.length === 1 ? '' : 's'}` +
        (scorerOnly > 0 ? ` (${scorerOnly} in a single scorer, with the case mean inside tolerance)` : ''),
    );
  }
  if (comparison.erroredCases.length > 0) reasons.push(`${comparison.erroredCases.length} errored`);
  if (comparison.missingCases.length > 0) {
    reasons.push(`${comparison.missingCases.length} missing from the suite`);
  }
  if (comparison.modelMismatches.length > 0) reasons.push('model mismatch');
  if (comparison.scorerSetMismatch.length > 0) reasons.push('scorer set changed');

  return `**GATE: FAIL** — ${reasons.join(', ')}.`;
}

/** `fenced 4/5` when a case was not unanimous, `tool-call` when it was. */
function formatCaseVias(vias: readonly string[]): string {
  if (vias.length === 0) return '—';
  const counts = new Map<string, number>();
  for (const via of vias) counts.set(via, (counts.get(via) ?? 0) + 1);

  const ordered = [...counts.entries()].sort(([, a], [, b]) => b - a);
  if (ordered.length === 1) return ordered[0]?.[0] ?? '—';
  return ordered.map(([via, count]) => `${via} ${count}/${vias.length}`).join(', ');
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
    case 'incomparable':
      return '≠ ';
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
  /* Named per suite so a fixture run never clobbers a live one. They are
     different measurements, and the published figures are generated from the
     live artifact — overwriting it with a fixture run silently destroys the
     source of every number in the README. */
  path = join(ARTIFACT_DIR, `run.${input.run.suiteId}.json`),
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
