/**
 * Documentation checks, as tests.
 *
 * WHY THESE EXIST
 * ---------------
 * Three rounds of manually re-reading every ADR against the code found three
 * real divergences — a document and its code stating opposite things. Every one
 * had the same cause: the pass that updated one part of a document left another
 * part of the SAME document asserting the opposite, and the author who made both
 * edits was the person least able to notice.
 *
 * A recurring defect from a stable cause gets a check, not more care. "Review
 * more carefully" has been tried three times and found three defects, which is
 * the definition of a control that does not work.
 *
 * These cover only what a machine can decide. Whether an ADR's reasoning is
 * sound, whether an Evidence line is honest about what was observed, whether a
 * README paragraph oversells — none of that is here, and the manual pass still
 * has to happen. What it no longer has to do is check whether a symbol exists.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DOCS = join(ROOT, 'docs', 'decisions');

async function walk(dir: string, match: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, match)));
    else if (entry.isFile() && match.test(entry.name)) files.push(full);
  }
  return files.sort();
}

const sourceFiles = await walk(SRC, /\.ts$/);
const sources = new Map<string, string>(
  await Promise.all(
    sourceFiles.map(async (f) => [f, await readFile(f, 'utf8')] as [string, string]),
  ),
);
const allSource = [...sources.values()].join('\n');

const adrFiles = (await walk(DOCS, /^\d{3}-.*\.md$/)).sort();
const adrs = new Map<string, string>(
  await Promise.all(adrFiles.map(async (f) => [f, await readFile(f, 'utf8')] as [string, string])),
);

const readme = await readFile(join(ROOT, 'README.md'), 'utf8');

function relative(file: string): string {
  return file.slice(ROOT.length);
}

/**
 * Fails when a check has nothing to inspect.
 *
 * THE THIRD APPEARANCE OF ONE BUG. A suite that scores no case reports green.
 * A case that no scorer measures reports green. And when C1 below was first
 * written, an injected defect went undetected because the injection replaced a
 * string that did not exist — the check found no broken links because it found
 * no links, and reported pass.
 *
 * Every one of those is emptiness read as success. The harness already refuses
 * the first two (ADR 005); this refuses the third. A check that inspected
 * nothing has not passed, it has abstained, and the two must not look alike.
 *
 * The message names what was expected and where it was looked for, because the
 * realistic cause is a rename: somebody retitles the README's `## Status`
 * heading and C2's corpus silently empties.
 */
function expectNonEmptyCorpus(items: { length: number }, label: string): void {
  if (items.length === 0) {
    throw new Error(
      `This check inspected nothing: ${label}. That is a failure, not a pass — ` +
        `a check with an empty corpus cannot distinguish "no defects" from ` +
        `"never looked". Most likely something it locates by name was renamed or moved.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * C1 — every {@link Type.member} resolves
 * ------------------------------------------------------------------ */

describe('JSDoc links', () => {
  it('every {@link Type.member} names a type and member that exist', () => {
    /* Text analysis rather than the TypeScript AST: it cannot see through
       re-exports or generics, so it is deliberately conservative — it only
       checks links whose TYPE it can find a declaration for. That is enough to
       catch the failure it was written for, a link to a field deleted in the
       same commit that left the sentence behind. */
    const declarations = new Map<string, string>();
    const declPattern =
      /export (?:type|interface) (\w+)(?:<[^>]*>)?\s*=?\s*\{([\s\S]*?)\n\};?/g;
    for (const [, text] of sources) {
      for (const match of text.matchAll(declPattern)) {
        const [, name, body] = match;
        if (name !== undefined && body !== undefined) declarations.set(name, body);
      }
    }

    const links = [...sources.values()].flatMap((text) => [
      ...text.matchAll(/\{@link (\w+)\.(\w+)\}/g),
    ]);
    expectNonEmptyCorpus(links, 'no {@link Type.member} found in src/**/*.ts');
    expectNonEmptyCorpus(
      [...declarations.keys()],
      'no exported type declarations parsed out of src/**/*.ts',
    );

    const broken: string[] = [];
    for (const [file, text] of sources) {
      for (const match of text.matchAll(/\{@link (\w+)\.(\w+)\}/g)) {
        const [, type, member] = match;
        if (type === undefined || member === undefined) continue;
        const body = declarations.get(type);
        if (body === undefined) continue; // type not resolvable from source text
        if (!new RegExp(`(^|\\n)\\s*(readonly\\s+)?${member}[?]?:`).test(body)) {
          broken.push(`${relative(file)}: {@link ${type}.${member}} — ${type} has no ${member}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * C2 — README scorers are actually registered
 * ------------------------------------------------------------------ */

describe('README scorer claims', () => {
  it('every scorer named in the Status section is registered by the CLI', () => {
    /* The Status checklist only — bounded at the next heading. Prose further
       down legitimately names a scorer while discussing it. */
    const from = readme.indexOf('## Status');
    const next = readme.indexOf('\n## ', from + 1);
    const status = readme.slice(from, next === -1 ? undefined : next);
    const claimed = [
      ...new Set(
        [...status.matchAll(/`(exactFields|matchesSchema|callsTool|formatCompliance|semanticSimilarity|llmJudge)`/g)].map(
          (m) => m[1] as string,
        ),
      ),
    ].sort();

    expectNonEmptyCorpus(
      claimed,
      'no scorer names found in the README `## Status` section (was the heading renamed?)',
    );

    const cli = sources.get(join(SRC, 'cli.ts')) ?? '';
    const registered = claimed.filter((name) => new RegExp(`${name}\\(`).test(cli));

    /* A scorer that ships, is tested, and is never invoked by any run is a
       reasonable thing to have — but the Status section must not imply the
       suite exercises it. */
    expect(claimed).toEqual(registered);
  });
});

/* ------------------------------------------------------------------ *
 * C3 — baseline files and the docs agree
 * ------------------------------------------------------------------ */

describe('baseline files', () => {
  it('every baseline on disk is documented, and every documented one exists', async () => {
    const onDisk = (await readdir(join(ROOT, 'evals')))
      .filter((f) => f.startsWith('baseline') && f.endsWith('.json'))
      .sort();

    expectNonEmptyCorpus(onDisk, 'no baseline*.json files found under evals/');

    const prose = [readme, ...adrs.values()].join('\n');
    const undocumented = onDisk.filter((f) => !prose.includes(f));

    const mentioned = [
      ...new Set([...prose.matchAll(/evals\/(baseline[\w.]*\.json)/g)].map((m) => m[1] as string)),
    ].sort();
    const missing = mentioned.filter((f) => !onDisk.includes(f));

    expect({ undocumented, missing }).toEqual({ undocumented: [], missing: [] });
  });
});

/* ------------------------------------------------------------------ *
 * C4 — supersession is bidirectional
 * ------------------------------------------------------------------ */

describe('ADR supersession', () => {
  it('every "superseded by NNN" is answered by NNN naming it back', () => {
    const withStatus = [...adrs.values()].filter((text) => statusBlock(text) !== '');
    expectNonEmptyCorpus(withStatus, 'no ADR with a parseable Status block');

    const problems: string[] = [];

    for (const [file, text] of adrs) {
      const self = /(\d{3})-/.exec(file.split('/').pop() ?? '')?.[1];
      if (self === undefined) continue;

      const status = statusBlock(text);
      for (const match of status.matchAll(/superseded by (?:ADR )?(\d{3})/gi)) {
        const target = match[1] as string;
        const targetFile = [...adrs.keys()].find((f) => f.includes(`/${target}-`));
        if (targetFile === undefined) {
          problems.push(`ADR ${self} says superseded by ${target}, which does not exist`);
          continue;
        }
        /* Both directions asserted: a one-way pointer leaves the superseding
           record free to describe a world where the old rule still holds. */
        const targetStatus = statusBlock(adrs.get(targetFile) ?? '');
        if (!new RegExp(`supersedes[^.]*\\b${self}\\b`, 'i').test(targetStatus)) {
          problems.push(`ADR ${target} does not name ${self} as superseded in its Status`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * C5 — every ADR states its evidence
 * ------------------------------------------------------------------ */

describe('ADR evidence', () => {
  it('every ADR has a non-empty Evidence line', () => {
    expectNonEmptyCorpus([...adrs.keys()], 'no ADR files found under docs/decisions/');

    const missing: string[] = [];

    for (const [file, text] of adrs) {
      const match = /^Evidence:[ \t]*(\S.*)$/m.exec(text);
      /* "None." is a valid answer and the point of the field. A missing line
         is not: it leaves a reader unable to tell whether the decision was
         checked or merely reasoned about. */
      if (match === null) missing.push(`${relative(file)}: no Evidence line`);
    }

    expect(missing).toEqual([]);
  });

  it('every ADR has a Status line', () => {
    expectNonEmptyCorpus([...adrs.keys()], 'no ADR files found under docs/decisions/');

    const missing = [...adrs.entries()]
      .filter(([, text]) => !/^Status:[ \t]*\S/m.test(text))
      .map(([file]) => relative(file));

    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * A check on the checks
 * ------------------------------------------------------------------ */

describe('these checks', () => {
  it('every check in this file proves it inspected something', async () => {
    /* Yes, a check on the checks, and that is the point. Everything above
       guards a document against drifting from the code; nothing guarded the
       guards. A check whose corpus quietly empties keeps reporting pass, so
       the file that exists to catch silent vacuity was the last place in the
       repository still able to be silently vacuous.
       This test reads its own source, which is why it is the only one that
       cannot be fooled by a rename somewhere else. */
    const self = await readFile(fileURLToPath(import.meta.url), 'utf8');

    /* Split on `it(` at test-body indentation, so each block is one check. */
    const blocks = self.split(/\n  it\(/).slice(1);
    expectNonEmptyCorpus(blocks, 'no `it(` blocks found in docs.test.ts itself');

    const withoutGuard = blocks
      .map((block) => ({
        title: /^'([^']+)'/.exec(block)?.[1] ?? '(untitled)',
        guarded: block.includes('expectNonEmptyCorpus('),
      }))
      .filter((check) => !check.guarded)
      .map((check) => check.title);

    expect(withoutGuard).toEqual([]);
  });
});

/** Status plus its wrapped continuation lines, stopping at Evidence or a
 *  heading — supersession notes routinely wrap. */
function statusBlock(text: string): string {
  const start = text.indexOf('\nStatus:');
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const end = Math.min(
    ...[rest.indexOf('\nEvidence:'), rest.indexOf('\n## ')].filter((i) => i !== -1),
  );
  return end === Infinity ? rest : rest.slice(0, end);
}

/* Referenced so an unused-variable rule cannot quietly disable the corpus. */
export const CHECKED_SOURCES = allSource.length;
