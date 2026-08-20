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
 *
 * WHAT IT CANNOT DISTINGUISH
 * --------------------------
 * A deliberate trailing comment and a lost tail are the same bytes:
 *
 *     id: refund-damaged-item-01     # stable forever, it is the baseline key
 *     subject: Order #48812 arrived broken
 *
 * The first is intended and the second is a bug, and no rule on the text can
 * tell them apart. So the check demands quoting in both cases — which costs two
 * characters on an intentional comment and makes the boundary explicit, since a
 * quoted scalar keeps its trailing comment working. The tax is on the rarer,
 * safer case; the guarantee is on the one that has now cost this repo twice.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* No trailing slash: paths are reported by slicing this prefix off, and a
   stray separator eats the first character of every filename. */
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const EVALS = join(ROOT, 'evals');

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

/**
 * YAML fenced blocks inside Markdown, extracted with the line offset of the
 * fence so a report points at the real line in the real file.
 *
 * The corpus started as `evals/` alone, which is why the Quickstart example in
 * README.md carried the exact defect this file exists to catch — an unquoted
 * `#` truncating a scalar — in the snippet a reader copies first. A check is
 * only as good as the corpus it was pointed at (ADR 018).
 */
async function markdownYamlBlocks(dir: string): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: { file: string; text: string }[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...(await markdownYamlBlocks(full)));
      continue;
    }
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;

    const text = await readFile(full, 'utf8');
    const lines = text.split('\n');
    let start = -1;
    lines.forEach((line, index) => {
      if (start === -1 && /^\s*```ya?ml\s*$/i.test(line)) {
        start = index;
        return;
      }
      if (start !== -1 && /^\s*```\s*$/.test(line)) {
        /* Padded so reported line numbers match the Markdown file. */
        const padded = [...Array<string>(start + 1).fill(''), ...lines.slice(start + 1, index)];
        out.push({ file: full.slice(ROOT.length + 1), text: padded.join('\n') });
        start = -1;
      }
    });
  }
  return out;
}

const files = await yamlFiles(EVALS);
const sources = [
  ...(await Promise.all(
    files.map(async (f) => ({ file: f.slice(ROOT.length + 1), text: await readFile(f, 'utf8') })),
  )),
  /* Documentation is part of the corpus: a broken example teaches the defect. */
  ...(await markdownYamlBlocks(ROOT)),
];

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

        /* `- key: value` is a list item AND a mapping, so the leading `- ` has
           to be stripped before the key, or the whole `key: value` is read as
           the value and any legitimate trailing comment looks like a defect. */
        const withoutDash = line.replace(/^(\s*)- /, '$1');
        const match = /^\s*(?:[\w.]+:\s+)?(.*)$/.exec(withoutDash);
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
