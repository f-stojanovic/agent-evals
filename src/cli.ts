/**
 * `npm run eval` — load, validate, run, compare, report, exit.
 *
 * The exit code is the whole interface for CI: 0 or 1, nothing else parsed.
 */

import { loadCases } from './cases.js';
import { validateExpectations } from './scorers/registry.js';
import { callsTool, exactFields, matchesSchema } from './scorers/exact.js';
import { llmJudge } from './scorers/judge.js';
import { fixtureJudge, fixtureSubject, loadFixtures } from './fixtures.js';
import { CACHE_OFF, DEFAULT_CACHE_DIR, runSuite } from './runner.js';
import {
  baselineFrom,
  compareToBaseline,
  describeBaselineChange,
  readBaseline,
  writeBaseline,
} from './baseline.js';
import { exitCode, formatReport, writeArtifact } from './report.js';
import type { LockedModel } from './models-lock.js';
import type { CacheMode, RunSummary } from './runner.js';
import type { Scorer, Subject } from './types.js';

export type CliOptions = {
  fixture: boolean;
  updateBaseline: boolean;
  samples: number;
  cache: boolean;
  casesDir: string;
  fixturesDir: string;
  baselinePath: string;
  concurrency: number;
};

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    fixture: argv.includes('--fixture'),
    updateBaseline: argv.includes('--update-baseline'),
    samples: numberFlag(argv, '--samples') ?? 3,
    /* Opt-in, never opt-out. A cache that is on unless disabled is how a
       baseline ends up recorded from replayed responses (ADR 007). */
    cache: argv.includes('--cache'),
    casesDir: stringFlag(argv, '--cases') ?? 'evals/cases',
    fixturesDir: stringFlag(argv, '--fixtures') ?? 'evals/fixtures',
    baselinePath: stringFlag(argv, '--baseline') ?? 'evals/baseline.json',
    concurrency: numberFlag(argv, '--concurrency') ?? 4,
  };

  if (options.cache && options.updateBaseline) {
    throw new Error(
      'Refusing to record a baseline with the cache enabled. A baseline built from ' +
        'replayed responses records the cache, not the model (ADR 007).',
    );
  }
  if (options.cache && process.env['CI'] === 'true') {
    throw new Error('Refusing to use the response cache in CI (ADR 007).');
  }
  return options;
}

function stringFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function numberFlag(argv: readonly string[], flag: string): number | undefined {
  const raw = stringFlag(argv, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${flag} expects a number, got "${raw}"`);
  return value;
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);

  const cases = await loadCases(options.casesDir);

  const fixtures = options.fixture ? await loadFixtures(options.fixturesDir) : undefined;
  const subject: Subject = options.fixture
    ? fixtureSubject(fixtures ?? new Map())
    : notImplementedSubject;

  const scorers: Scorer[] = [
    exactFields(),
    matchesSchema(),
    callsTool(),
    options.fixture ? llmJudge({ judge: fixtureJudge(fixtures ?? new Map()) }) : llmJudge(),
  ];

  validateExpectations(cases, scorers);

  const cache: CacheMode = options.cache ? { kind: 'disk', dir: DEFAULT_CACHE_DIR } : CACHE_OFF;

  const run = await runSuite({
    cases,
    subject,
    subjectId: options.fixture ? 'fixture' : 'live',
    scorers,
    samples: options.samples,
    concurrency: options.concurrency,
    cache,
    suiteId: options.fixture ? 'fixture' : 'live',
  });

  const models = collectModels(run);
  const previous = await readBaseline(options.baselinePath);
  const comparison = compareToBaseline(run, previous, models);

  console.log(formatReport({ run, comparison, models }));
  const artifact = await writeArtifact({ run, comparison, models });
  console.log(`\nArtifact: ${artifact}`);

  if (options.updateBaseline) {
    const next = baselineFrom(run, models);
    await writeBaseline(next, options.baselinePath);
    console.log(`\n${describeBaselineChange(previous, next)}`);
    return 0;
  }

  return exitCode(comparison);
}

/**
 * Harvests the locked model identities from the scores the run produced.
 *
 * Read off the results rather than asked of the scorers, because a scorer that
 * was registered but never applicable never loaded its model, and recording a
 * model the run did not use would put a false pin in the baseline.
 */
function collectModels(run: RunSummary): Record<string, LockedModel> {
  const models: Record<string, LockedModel> = {};
  for (const result of run.results) {
    for (const score of result.scores) {
      const judge = score.meta?.['judgeModel'];
      if (isLockedModel(judge)) models['judge'] = judge;
      const embedding = score.meta?.['model'];
      if (isLockedModel(embedding)) models['embedding'] = embedding;
    }
  }
  return models;
}

function isLockedModel(value: unknown): value is LockedModel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LockedModel).modelId === 'string' &&
    typeof (value as LockedModel).dtype === 'string'
  );
}

const notImplementedSubject: Subject = () =>
  Promise.reject(
    new Error(
      'No live subject is wired up. This repository ships the harness, not a ' +
        'particular agent: point `runSuite` at your own Subject, or run with ' +
        '--fixture to exercise the harness against recorded outputs.',
    ),
  );

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'));

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
