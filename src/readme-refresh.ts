/**
 * `npm run readme:refresh` — regenerate the README's published figures.
 *
 * With `--check` it changes nothing and exits 1 if the README or the committed
 * figures are out of date with the current artifacts. That is the form CI runs
 * after an eval, so "ran the suite and forgot to refresh" fails a build rather
 * than shipping.
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  README_PATH,
  applyBlocks,
  figuresFromArtifacts,
  isUpToDate,
  readFigures,
  writeFigures,
} from './readme.js';
import { BLOCK_NAMES } from './readme.js';

export async function refresh(options: { check: boolean }): Promise<number> {
  const fresh = await figuresFromArtifacts();
  const readme = await readFile(README_PATH, 'utf8');

  if (options.check) {
    let committed;
    try {
      committed = await readFigures();
    } catch {
      console.error(
        `No committed figures found. Run \`npm run readme:refresh\` and commit the result.`,
      );
      return 1;
    }

    const stale = !isUpToDate(readme, committed);

    /* Only compare against artifacts from the same suite. The published figures
       are from a live run; a fixture run is a different measurement, and
       diffing them reports a difference that is correct — which would train
       whoever sees it to ignore this check. */
    /* `figuresFromArtifacts` reads the live artifact by name, so a mismatch
       here means the committed figures predate suite-aware artifacts. */
    const comparable = committed.suiteId === fresh.suiteId;
    const drifted = comparable
      ? BLOCK_NAMES.filter((name) => committed.blocks[name].trim() !== fresh.blocks[name].trim())
      : [];

    if (!comparable) {
      console.log(
        `Checked README against the committed figures only. The artifacts on disk are ` +
          `from the "${fresh.suiteId}" suite and the published figures are from ` +
          `"${committed.suiteId}", so they are not comparable.`,
      );
    }

    if (drifted.length === 0 && !stale) {
      console.log('README figures are current.');
      return 0;
    }

    if (drifted.length > 0) {
      console.error(
        `\nThe committed figures no longer match the current artifacts:\n` +
          drifted.map((n) => `  - ${n}`).join('\n') +
          `\n\nA run happened and the README was not refreshed. Run:\n` +
          `  npm run readme:refresh\n`,
      );
    }
    if (stale) {
      console.error(
        `\n${README_PATH} has been hand-edited inside a generated block, or the ` +
          `committed figures changed without it being re-rendered. Run:\n` +
          `  npm run readme:refresh\n`,
      );
    }
    return 1;
  }

  await writeFigures(fresh);
  await writeFile(README_PATH, applyBlocks(readme, fresh.blocks));
  console.log(
    `Refreshed ${BLOCK_NAMES.length} generated blocks in ${README_PATH} and rewrote ` +
      `evals/published-figures.json.`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('readme-refresh.ts');

if (invokedDirectly) {
  process.exitCode = await refresh({ check: process.argv.includes('--check') });
}
