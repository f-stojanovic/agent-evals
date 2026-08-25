/**
 * The README checked against itself, and against the last run.
 *
 * `docs.test.ts` checks documents against the code. Nothing checked the README
 * against the README, which is how it came to hold five contradictions at once
 * — including a "there is no remote" claim sitting under two CI badges, and the
 * pre-defect semantic margin printed a page from the corrected one.
 *
 * See ADR 020.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_NAMES, closeMarker, openMarker, readBlocks, readFigures } from './readme.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
const figures = await readFigures(join(ROOT, 'evals/published-figures.json'));

/** See ADR 018 — a check that inspected nothing has abstained, not passed. */
function expectNonEmptyCorpus(items: { length: number }, label: string): void {
  if (items.length === 0) {
    throw new Error(`This check inspected nothing: ${label}. That is a failure, not a pass.`);
  }
}

describe('generated README blocks', () => {
  it('every declared block is present and delimited', () => {
    expectNonEmptyCorpus(BLOCK_NAMES, 'no generated block names declared');

    const missing = BLOCK_NAMES.filter(
      (name) => !readme.includes(openMarker(name)) || !readme.includes(closeMarker(name)),
    );

    expect(missing).toEqual([]);
  });

  it('every block matches the committed figures exactly', () => {
    const current = readBlocks(readme);
    expectNonEmptyCorpus([...current.keys()], 'no generated blocks found in README.md');

    /* A stale README fails the build the same way a stale baseline does. The
       remedy is `npm run readme:refresh`, never editing inside the markers. */
    const drifted = BLOCK_NAMES.filter(
      (name) => current.get(name) !== figures.blocks[name].trim(),
    );

    expect(drifted).toEqual([]);
  });
});

describe('figures quoted in prose', () => {
  it('never repeats a generated figure outside its block', () => {
    /* NARROWED DELIBERATELY, to a named list rather than every number.
       "Any number that also appears in a block" is unusable: the blocks contain
       0.05, 1.00, 3 and 5, which occur legitimately all over the prose — in the
       floor constant's description, in the Quickstart snippet, in sentence
       counts. The check would either be disabled or would train people to
       reword around it.
       So it guards the three figures that actually went stale in the incident
       this exists for: the suite score, the semantic margin, and the judge MAE.
       Historical figures are handled by the next test rather than exempted —
       each is anchored to a committed archive file. */
    const guarded = Object.entries(figures.guarded);
    expectNonEmptyCorpus(guarded, 'no guarded figures declared in published-figures.json');

    /* A `±0.096` is a derived tolerance, never one of the three published
       figures, and the two collide on digits sooner or later — the judge MAE
       landed on 0.096 while the regression-demo transcript quoted a tolerance
       of ±0.096. Dropping tolerances is narrower than exempting the whole
       block: a hand-copied MAE sitting in that same transcript would still be
       caught. */
    const outsideBlocks = stripGeneratedBlocks(readme).replace(/±\s*\d+(\.\d+)?/g, '');
    const leaked = guarded
      .filter(([, value]) => outsideBlocks.includes(value))
      .map(([name, value]) => `${name} (${value}) appears in prose outside its generated block`);

    expect(leaked).toEqual([]);
  });
});

/**
 * Historical figures quoted in prose are anchored to a committed archive.
 *
 * The Before/After section quotes 0.751 → 0.953, which is accurate history and
 * therefore cannot be generated from the current run. Left alone, that is the
 * same defect as any other transcribed number, just slower: 0.751 happened to
 * still match `baseline.freetext.json`, and 0.953 matched nothing at all once
 * the live baseline had been re-recorded three times.
 *
 * So each historical figure names a file that holds it. If somebody edits the
 * prose figure, or replaces an archive, this fails.
 */
type ArchivedBaseline = {
  totals: { weightedScore: number };
  cases: Record<string, { scorers: Record<string, number | { mean: number }> }>;
};

/** Pulls one scorer's mean out of an archive, across the v2 and v3 shapes. */
const scorerMean =
  (caseId: string, scorer: string) =>
  (archive: ArchivedBaseline): number => {
    const entry = archive.cases[caseId]?.scorers[scorer];
    if (entry === undefined) throw new Error(`no ${scorer} on ${caseId}`);
    return typeof entry === 'number' ? entry : entry.mean;
  };

describe('historical figures', () => {
  const anchors: {
    figure: string;
    file: string;
    describes: string;
    /** Where in the archive the figure lives. Suite totals by default; the
     *  semantic-spread figures are per-scorer values on a single case. */
    read?: (archive: ArchivedBaseline) => number;
    decimals?: number;
  }[] = [
    {
      figure: '0.751',
      file: 'evals/baseline.freetext.json',
      describes: 'the free-text baseline, before requested_action became an enum',
    },
    {
      figure: '0.953',
      file: 'evals/baseline.enums-prescorer.json',
      describes: 'the post-enum baseline, before the scorer set was recorded or expanded',
    },
    {
      figure: '0.77',
      file: 'evals/baseline.semantic-spread-high.json',
      describes: 'the high end of the semantic-similarity spread on outage-escalation-01',
      read: scorerMean('outage-escalation-01', 'semantic-similarity'),
      decimals: 2,
    },
    {
      figure: '0.55',
      file: 'evals/baseline.semantic-spread-low.json',
      describes: 'the low end of the semantic-similarity spread on outage-escalation-01',
      read: scorerMean('outage-escalation-01', 'semantic-similarity'),
      decimals: 2,
    },
    {
      figure: '0.61',
      file: 'evals/baseline.json',
      describes: 'the current semantic-similarity mean on outage-escalation-01',
      read: scorerMean('outage-escalation-01', 'semantic-similarity'),
      decimals: 2,
    },
  ];

  it('every historical figure matches the archive that holds it', async () => {
    expectNonEmptyCorpus(anchors, 'no historical figures declared');

    const mismatches: string[] = [];
    for (const anchor of anchors) {
      const archived = JSON.parse(
        await readFile(join(ROOT, anchor.file), 'utf8'),
      ) as ArchivedBaseline;
      const value = (anchor.read ?? ((a: ArchivedBaseline) => a.totals.weightedScore))(archived);
      const actual = value.toFixed(anchor.decimals ?? 3);
      if (actual !== anchor.figure) {
        mismatches.push(
          `${anchor.file} holds ${actual}, but the README quotes ${anchor.figure} for ${anchor.describes}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('quotes each historical figure only where its archive is cited or in the Before/After', () => {
    const before = readme.slice(
      readme.indexOf('## Before and after'),
      readme.indexOf('## Quickstart'),
    );
    expectNonEmptyCorpus([before], 'the Before/After section is missing');

    /* Confined to the one section that is about history. A historical number
       appearing in Known limitations is how contradiction 3 happened.
       Only the two suite-total figures are confined this way. The
       semantic-spread figures are deliberately IN Known limitations — that is
       the claim they support — and they are two-decimal values like 0.77 that
       occur legitimately in generated tables, so confining them by substring
       would fail on the blocks rather than on any drift. They are anchored to
       their archives by the test above, which is the guarantee that matters. */
    const confined = anchors.filter(({ read }) => read === undefined);
    expectNonEmptyCorpus(confined, 'no suite-total historical figures declared');

    const strays = confined
      .filter(({ figure }) => {
        const elsewhere = readme.split(before).join('');
        return elsewhere.includes(figure);
      })
      .map(({ figure }) => `${figure} appears outside the Before/After section`);

    expect(strays).toEqual([]);
  });

  it('names every archive it relies on, so none can be deleted quietly', () => {
    const missing = anchors.filter(({ file }) => !readme.includes(file));

    expect(missing.map((a) => a.file)).toEqual([]);
  });
});

describe('claims about the repository itself', () => {
  it('does not deny a remote that exists', () => {
    const remotes = execFileSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expectNonEmptyCorpus([readme], 'README.md is empty');

    if (remotes === '') return; // nothing to contradict

    /* The exact sentence that shipped, under two badges pointing at the remote
       it denied. */
    const denials = [
      'There is no remote',
      'there is no remote',
      'Neither GitHub workflow has ever executed',
      'never been pushed',
    ].filter((claim) => readme.includes(claim));

    expect(denials).toEqual([]);
  });

  it('does not claim a workflow has never run while badges advertise it', () => {
    const badged = readme.includes('actions/workflows/ci.yml/badge.svg');
    if (!badged) return;

    expect(readme).not.toMatch(/workflows? has never (executed|run)/i);
  });
});

/** Everything outside `<!-- generated:… -->` regions. */
function stripGeneratedBlocks(text: string): string {
  let out = text;
  for (const name of BLOCK_NAMES) {
    const open = out.indexOf(openMarker(name));
    const close = out.indexOf(closeMarker(name));
    if (open === -1 || close === -1 || close < open) continue;
    out = out.slice(0, open) + out.slice(close + closeMarker(name).length);
  }
  return out;
}
