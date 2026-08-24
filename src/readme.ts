/**
 * Generating the README's published figures instead of transcribing them.
 *
 * WHY
 * ---
 * Every number this README quotes was, at some point, copied by hand out of a
 * terminal. A hand-copied number goes stale the instant anything is re-run, and
 * nobody re-reads it, because from the author's point of view nothing changed —
 * they did not touch that paragraph.
 *
 * That produced five contradictions in a public README simultaneously: a
 * "there is no remote" claim under two CI badges, a Known-limitations entry
 * recommending the fix an ADR three sections up rejects with reasons, a
 * superseded baseline described as current, and the pre-defect semantic margin
 * printed a page from the corrected one.
 *
 * So the figures come from one place. Marked regions are rendered from
 * `evals/published-figures.json`, which is itself regenerated from run
 * artifacts by `npm run readme:refresh`. A test asserts the README matches, so
 * a stale README fails the build exactly like a stale baseline.
 *
 * Everything OUTSIDE the markers is prose a human writes and owns. This file
 * has no opinion about it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { formatUncalibratedReport } from './uncalibrated.js';

export const README_PATH = 'README.md';
export const FIGURES_PATH = 'evals/published-figures.json';

/**
 * Blocks the README delegates. `run-block` carries the provenance summary and
 * the uncalibrated-constant list inside it, because they are produced by one
 * report and splitting them would let the three drift apart.
 */
export const BLOCK_NAMES = ['run-block', 'semantic-calibration', 'judge-calibration'] as const;
export type BlockName = (typeof BLOCK_NAMES)[number];

export type PublishedFigures = {
  /** When the figures were regenerated, not when the README was edited. */
  generatedAt: string;
  /** Which suite produced them. Published figures come from a live run; a
   *  fixture run's artifacts are a different measurement and comparing the two
   *  reports a difference that is correct. */
  suiteId: string;
  blocks: Record<BlockName, string>;
  /**
   * The figures a reader might be tempted to repeat in prose. Extracted so a
   * test can assert they appear ONLY inside a generated block.
   */
  guarded: {
    weightedScore: string;
    semanticMargin: string;
    judgeMae: string;
  };
};

/* ------------------------------------------------------------------ *
 * Markers
 * ------------------------------------------------------------------ */

export function openMarker(name: BlockName): string {
  return `<!-- generated:${name} -->`;
}
export function closeMarker(name: BlockName): string {
  return `<!-- /generated:${name} -->`;
}

/** Extracts the current content of every marked block. */
export function readBlocks(readme: string): Map<BlockName, string> {
  const blocks = new Map<BlockName, string>();
  for (const name of BLOCK_NAMES) {
    const open = readme.indexOf(openMarker(name));
    const close = readme.indexOf(closeMarker(name));
    if (open === -1 || close === -1 || close < open) continue;
    blocks.set(name, readme.slice(open + openMarker(name).length, close).trim());
  }
  return blocks;
}

/** Replaces the content of every marked block, leaving prose untouched. */
export function applyBlocks(readme: string, blocks: Record<BlockName, string>): string {
  let out = readme;
  for (const name of BLOCK_NAMES) {
    const open = openMarker(name);
    const close = closeMarker(name);
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start === -1 || end === -1 || end < start) {
      throw new Error(
        `${README_PATH} has no ${open} … ${close} region. A generated block cannot be ` +
          `refreshed if the markers are gone — restore them rather than hand-writing the ` +
          `content back.`,
      );
    }
    out = `${out.slice(0, start + open.length)}\n\n${blocks[name]}\n\n${out.slice(end)}`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Building the figures from artifacts
 * ------------------------------------------------------------------ */

type RunArtifact = {
  run: {
    suiteId: string;
    startedAt: string;
    durationMs: number;
    totals: { cases: number; failed: number; errored: number; weightedScore: number };
    uncalibrated: { id: string; value: number; note: string }[];
  };
};

export async function figuresFromArtifacts(
  read = readJson,
  /* Live by default: the published figures describe real model behaviour, and
     a fixture run is a different measurement. */
  suiteId = 'live',
): Promise<PublishedFigures> {
  const run = (await read(`.artifacts/run.${suiteId}.json`)) as RunArtifact &
    Record<string, unknown>;

  /* A RUN THAT MEASURED NOTHING IS NOT A SOURCE OF PUBLISHED FIGURES.
     An expired API key errors every case, and the report renders perfectly
     well with a weighted score of 0.000 — so refreshing from it would publish
     an infrastructure failure as a quality result, which is the errored/failed
     confusion this project spends most of its design budget avoiding. This
     happened: a live run hit "credit balance is too low", every case errored,
     and the next `readme:refresh` would have written 0.000 into the README. */
  if (run.run.totals.errored > 0) {
    throw new Error(
      `.artifacts/run.${suiteId}.json records ${run.run.totals.errored} errored case(s) ` +
        `of ${run.run.totals.cases}. A run that could not evaluate its cases is not a ` +
        `source of published figures — fix the run and repeat it rather than publishing ` +
        `what it produced.`,
    );
  }
  const semantic = (await read('.artifacts/calibrate-semantic.json')) as {
    report: { minCorrect: number; maxIncorrect: number; margin: number; separates: boolean };
  };
  const judge = (await read('.artifacts/calibrate-judge.json')) as {
    cases: number;
    report: {
      meanAbsoluteError: number;
      meanAbsoluteErrorGroundTruth: number;
      meanSignedError: number;
      results: { labelKind: string }[];
    };
  };

  const { formatReport } = await import('./report.js');
  const artifact = run as unknown as Parameters<typeof formatReport>[0];
  const runBlock = ['```', formatReport(artifact).trimEnd(), '```'].join('\n');

  const { formatSemanticCalibration } = await import('./calibrate-semantic.js');
  const semanticBlock = [
    '```',
    formatSemanticCalibration(semantic.report as never).trimEnd(),
    '```',
  ].join('\n');

  const mae = judge.report.meanAbsoluteError.toFixed(3);
  const groundTruthCases = judge.report.results.filter((r) => r.labelKind === 'ground-truth').length;
  const judgeBlock =
    `**Measured: MAE ${mae} over n=${judge.cases}**, mean signed error ` +
    `${judge.report.meanSignedError >= 0 ? '+' : ''}${judge.report.meanSignedError.toFixed(3)}. ` +
    `Over the ${groundTruthCases} cases that have a ground truth it is ` +
    `${judge.report.meanAbsoluteErrorGroundTruth.toFixed(3)}; the remainder are contested labels, ` +
    `where no right answer exists and judge error is disagreement rather than inaccuracy. ` +
    `The labels are one pass by one human annotator. The outputs and rubrics they grade were ` +
    `written by a model (ADR 021).`;

  return {
    generatedAt: new Date().toISOString(),
    suiteId: run.run.suiteId,
    blocks: {
      'run-block': runBlock,
      'semantic-calibration': semanticBlock,
      'judge-calibration': judgeBlock,
    },
    guarded: {
      weightedScore: run.run.totals.weightedScore.toFixed(3),
      semanticMargin: `${semantic.report.margin >= 0 ? '+' : ''}${semantic.report.margin.toFixed(3)}`,
      judgeMae: mae,
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${path} is missing. The published figures are generated from run artifacts, so ` +
          `refreshing them requires a live run first: npm run eval, ` +
          `npm run calibrate, npm run calibrate:semantic.`,
      );
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Reading and writing the committed figures
 * ------------------------------------------------------------------ */

export async function readFigures(path = FIGURES_PATH): Promise<PublishedFigures> {
  return JSON.parse(await readFile(path, 'utf8')) as PublishedFigures;
}

export async function writeFigures(
  figures: PublishedFigures,
  path = FIGURES_PATH,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(figures, null, 2)}\n`);
}

/** True when every marked block already matches the committed figures. */
export function isUpToDate(readme: string, figures: PublishedFigures): boolean {
  const current = readBlocks(readme);
  return BLOCK_NAMES.every((name) => current.get(name) === figures.blocks[name].trim());
}

/* Re-exported so the refresh CLI and its test share one renderer. */
export { formatUncalibratedReport };
