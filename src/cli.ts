/**
 * `npm run eval` — load, validate, run, compare, report, exit.
 *
 * The exit code is the whole interface for CI: 0 or 1, nothing else parsed.
 */

import { loadCases } from './cases.js';
import { validateExpectations } from './scorers/registry.js';
import { callsTool, exactFields, matchesSchema } from './scorers/exact.js';
import { formatCompliance } from './scorers/format.js';
import { semanticSimilarity } from './scorers/semantic.js';
import { llmJudge } from './scorers/judge.js';
import { fixtureJudge, fixtureSubject, loadFixtures } from './fixtures.js';
import { anthropicJudge } from './scorers/judge.js';
import { SUBJECT_ID, supportExtractionSubject } from './subjects/support-extraction.js';
import { CACHE_OFF, DEFAULT_CACHE_DIR, runSuite } from './runner.js';
import {
  BaselineVersionError,
  baselineFrom,
  compareToBaseline,
  describeBaselineChange,
  readBaseline,
  writeBaseline,
} from './baseline.js';
import { exitCode, formatReport, writeArtifact } from './report.js';
import { summariseProvenance } from './provenance.js';
import type { LockedModel } from './models-lock.js';
import type { CacheMode } from './runner.js';
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
    /* Five, not three. A stdDev from five draws is a weak estimate and a
       stdDev from three is barely one, and ADR 012 derives the screen's
       allowance from exactly that number. */
    samples: numberFlag(argv, '--samples') ?? 5,
    /* Opt-in, never opt-out. A cache that is on unless disabled is how a
       baseline ends up recorded from replayed responses (ADR 007). */
    cache: argv.includes('--cache'),
    casesDir: stringFlag(argv, '--cases') ?? 'evals/cases',
    fixturesDir: stringFlag(argv, '--fixtures') ?? 'evals/fixtures',
    /* SEPARATE BASELINES, and not for convenience. The fixture run grades with
       a replaying judge and the live run grades with claude-opus-5, and ADR 009
       says scores from different judge models are not comparable — so a single
       file would make one of the two runs fail on a model mismatch every time,
       correctly and uselessly. Two files, each recorded by the run that owns
       it. */
    baselinePath:
      stringFlag(argv, '--baseline') ??
      (argv.includes('--fixture') ? 'evals/baseline.fixture.json' : 'evals/baseline.json'),
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
    : supportExtractionSubject();

  const judge = options.fixture ? fixtureJudge(fixtures ?? new Map()) : anthropicJudge();

  const scorers: Scorer[] = [
    exactFields(),
    matchesSchema(),
    callsTool(),
    /* Projected onto `summary`, the one field with no single correct wording.
       Embedding the whole payload would measure punctuation and key names. */
    semanticSimilarity({ compare: 'summary' }),
    formatCompliance(),
    llmJudge({ judge }),
  ];

  validateExpectations(cases, scorers);

  const cache: CacheMode = options.cache ? { kind: 'disk', dir: DEFAULT_CACHE_DIR } : CACHE_OFF;

  const run = await runSuite({
    cases,
    subject,
    subjectId: options.fixture ? 'fixture' : SUBJECT_ID,
    scorers,
    samples: options.samples,
    concurrency: options.concurrency,
    cache,
    suiteId: options.fixture ? 'fixture' : 'live',
  });

  /* Asked of the judge rather than scraped from scores: a lock the run
     actually took is the one that belongs in the baseline. */
  const models: Record<string, LockedModel> = { judge: await judge.locked() };
  let previous;
  try {
    previous = await readBaseline(options.baselinePath);
  } catch (error) {
    if (error instanceof BaselineVersionError) {
      /* `--update-baseline` IS the remedy the message recommends, so refusing
         it here would tell the reader to run a command that then declines. An
         out-of-date file is not an obstacle to overwriting it — it just means
         there is nothing to compare against first. */
      if (!options.updateBaseline) {
        console.error(`\nBaseline out of date\n\n${error.message}\n`);
        return 1;
      }
      console.error(`\nReplacing an out-of-date baseline: ${error.message}\n`);
      previous = undefined;
    } else {
      throw error;
    }
  }
  const scorerNames = scorers.map((scorer) => scorer.name);
  const comparison = compareToBaseline(run, previous, models, scorerNames);

  const provenance =
    fixtures === undefined
      ? undefined
      : summariseProvenance('fixtures', [...fixtures.values()]);

  const reportInput = { run, comparison, models, ...(provenance !== undefined && { provenance }) };
  console.log(formatReport(reportInput));
  const artifact = await writeArtifact(reportInput);
  console.log(`\nArtifact: ${artifact}`);

  if (options.updateBaseline) {
    const next = baselineFrom(run, models, scorerNames);
    await writeBaseline(next, options.baselinePath);
    console.log(`\n${describeBaselineChange(previous, next)}`);
    return 0;
  }

  return exitCode(comparison);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'));

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
