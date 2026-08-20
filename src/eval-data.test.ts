/**
 * Integrity checks on the committed eval data.
 *
 * WHY THIS EXISTS
 * ---------------
 * A calibration pair scored exactly 1.000 cosine — two different sentences
 * producing an identical embedding, which does not happen. The cause was YAML:
 * in a plain scalar, ` #` starts a comment, so
 *
 *     - A customer received a broken ceramic mug in order #48812 and wants a refund.
 *
 * loaded as `"A customer received a broken ceramic mug in order"`. Both sides of
 * the pair were truncated at the same point, became byte-identical, and scored a
 * perfect 1.000 that looked like a dramatic finding.
 *
 * It also silently truncated a case's email subject to `"Order"` and one of its
 * semantic reference paraphrases, in data that had already been through a live
 * run and been written up.
 *
 * Nothing about the failure was visible from reading the file: the YAML is
 * valid, the loader is correct, and the truncation is exactly what the spec
 * says should happen. So the check is on the source text, where the mistake is,
 * rather than on the parsed value, where it is already gone.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EVALS = fileURLToPath(new URL('../evals', import.meta.url));

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await yamlFiles(full)));
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(full);
  }
  return files.sort();
}

const files = await yamlFiles(EVALS);
const sources = await Promise.all(
  files.map(async (f) => ({ file: f.slice(EVALS.length + 1), text: await readFile(f, 'utf8') })),
);

/** See ADR 018. A check that inspected nothing has abstained, not passed. */
function expectNonEmptyCorpus(items: { length: number }, label: string): void {
  if (items.length === 0) {
    throw new Error(`This check inspected nothing: ${label}. That is a failure, not a pass.`);
  }
}

describe('committed eval data', () => {
  it('never puts an unquoted " #" in a plain scalar, which YAML truncates', () => {
    expectNonEmptyCorpus(sources, 'no YAML files found under evals/');

    const offenders: string[] = [];

    for (const { file, text } of sources) {
      let inBlockScalar = false;
      let blockIndent = 0;

      text.split('\n').forEach((line, index) => {
        const indent = line.length - line.trimStart().length;

        /* Inside a `|` or `>` block, `#` is literal and safe. Track the block
           by indentation so the check does not flag prose in an email body. */
        if (inBlockScalar) {
          if (line.trim() === '' || indent > blockIndent) return;
          inBlockScalar = false;
        }

        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) return;

        if (/(^|\s)[|>][-+]?\d*\s*$/.test(line)) {
          inBlockScalar = true;
          blockIndent = indent;
          return;
        }

        const match = /^\s*(?:- |[\w.]+:\s+)(.*)$/.exec(line);
        const value = match?.[1];
        if (value === undefined || value === '') return;
        if (value.startsWith('"') || value.startsWith("'")) return;
        /* Flow mappings like { kind: hand-authored } are quoted differently
           but contain no free text, so a `#` in one is still a comment — the
           rule is the same. */
        if (!/\s#/.test(value)) return;

        offenders.push(
          `${file}:${index + 1} — "${value.slice(0, 60)}…" loses everything from " #" onward. Quote it.`,
        );
      });
    }

    expect(offenders).toEqual([]);
  });

  it('loads every reference paraphrase intact, ending in a full sentence', async () => {
    const { loadCases } = await import('./cases.js');
    const cases = await loadCases(join(EVALS, 'cases'));
    const paraphrases = cases.flatMap((c) => (c.expect['similar'] as string[] | undefined) ?? []);

    expectNonEmptyCorpus(paraphrases, 'no expect.similar values found in evals/cases');

    /* A truncated paraphrase ends mid-clause. Not a general grammar check —
       just enough to catch a scalar that lost its tail. */
    const truncated = paraphrases.filter((p) => !/[.!?]$/.test(p.trim()));

    expect(truncated).toEqual([]);
  });
});
