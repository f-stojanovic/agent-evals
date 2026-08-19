/**
 * Loading and validating eval cases from YAML.
 *
 * This module is the single trust boundary for case data. Everything upstream
 * is untyped text a human edited; everything downstream may assume it holds a
 * valid `EvalCase`. Validation happens here, once. No scorer, runner, or
 * reporter should ever re-check whether `id` is a string.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import type { EvalCase } from './types.js';

const YAML_FILE = /\.ya?ml$/i;

/**
 * Mirrors {@link EvalCase}. `strictObject` rejects unknown keys, which turns
 * the single most common authoring mistake — `tag:` instead of `tags:` — from
 * a silently ignored field into a loud error at load time.
 */
export const evalCaseSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  /* `unknown` accepts any value including an explicit null, but the key itself
     is still required — omitting `input:` is an authoring mistake, whereas
     `input: null` may be deliberate. */
  input: z.unknown(),
  expect: z.record(z.string(), z.unknown()),
  tags: z.array(z.string().min(1)).optional(),
  weight: z.number().positive().optional(),
});

/**
 * Aggregates every problem found across every file rather than throwing on
 * the first one.
 *
 * Fail-fast is the wrong trade here: a human editing twelve YAML files wants
 * all twelve mistakes in one pass, not twelve edit-run cycles.
 */
export class CaseLoadError extends Error {
  override readonly name = 'CaseLoadError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      problems.length === 1
        ? `Failed to load eval cases: ${problems[0]}`
        : `Failed to load eval cases (${problems.length} problems):\n` +
          problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.problems = problems;
  }
}

/**
 * Reads every `*.yaml` / `*.yml` under `dir` (recursively), parses, validates,
 * and returns the cases sorted by id.
 *
 * A file may contain either a single case (a mapping) or a list of cases
 * (a sequence). Empty files are skipped, not treated as errors.
 *
 * @throws {CaseLoadError} on a missing directory, unparseable YAML, a schema
 * violation, or a duplicate id. Every problem found is reported at once.
 */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  const files = await collectYamlFiles(dir);

  const problems: string[] = [];
  const cases: EvalCase[] = [];
  /* First file each id was seen in, so a duplicate can name both sides. */
  const seen = new Map<string, string>();

  for (const file of files) {
    const source = await readFile(file, 'utf8');

    let document: unknown;
    try {
      document = parseYaml(source);
    } catch (error) {
      problems.push(`${display(file)}: ${describeYamlError(error)}`);
      continue;
    }

    /* An empty file parses to null. Treat it as "no cases here" — a
       placeholder file is a normal thing to have in a work-in-progress suite. */
    if (document === null || document === undefined) continue;

    const entries: unknown[] = Array.isArray(document) ? document : [document];
    const isList = Array.isArray(document);

    for (const [index, entry] of entries.entries()) {
      const at = location(file, index, isList, entry);

      const result = evalCaseSchema.safeParse(entry);
      if (!result.success) {
        for (const issue of result.error.issues) {
          problems.push(`${at}: ${formatPath(issue.path)}${describeIssue(issue)}`);
        }
        continue;
      }

      const parsed = result.data;
      const previous = seen.get(parsed.id);
      if (previous !== undefined) {
        problems.push(
          `duplicate case id "${parsed.id}": first defined in ${display(previous)}, ` +
            `redefined at ${at}`,
        );
        continue;
      }
      seen.set(parsed.id, file);

      /* Rebuilt field-by-field rather than spread wholesale. Under
         `exactOptionalPropertyTypes`, Zod's `description?: string | undefined`
         is not assignable to our `description?: string` — a present-but-
         undefined key is a different thing from an absent one. Conditional
         spread omits the key entirely, which is what we actually mean. */
      cases.push({
        id: parsed.id,
        input: parsed.input,
        expect: parsed.expect,
        ...(parsed.description !== undefined && { description: parsed.description }),
        ...(parsed.tags !== undefined && { tags: parsed.tags }),
        ...(parsed.weight !== undefined && { weight: parsed.weight }),
      });
    }
  }

  if (problems.length > 0) throw new CaseLoadError(problems);

  /* Sorted by id, not by filesystem order: readdir order varies by platform
     and filesystem, and a suite whose case order changes between machines is
     not reproducible. Plain codepoint comparison rather than `localeCompare`,
     which is locale-dependent and would reorder under a different LANG. */
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cases;
}

/** Recursive walk, entries sorted so error output is stable across runs. */
async function collectYamlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CaseLoadError([`case directory not found: ${display(dir)}`]);
    if (code === 'ENOTDIR') throw new CaseLoadError([`not a directory: ${display(dir)}`]);
    throw error;
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectYamlFiles(full)));
    } else if (entry.isFile() && YAML_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Names the offending case as precisely as the data allows: the id if the
 * entry has one (that is what the author searches for), the index otherwise.
 */
function location(file: string, index: number, isList: boolean, entry: unknown): string {
  const path = display(file);
  if (!isList) return path;

  const id =
    typeof entry === 'object' && entry !== null && 'id' in entry
      ? (entry as { id: unknown }).id
      : undefined;

  return typeof id === 'string' && id.length > 0
    ? `${path} [case ${index} · id "${id}"]`
    : `${path} [case ${index}]`;
}

/** Indexed access on the issue union, rather than importing Zod's internal
 *  issue type — this stays correct if the library reshapes it. */
type Issue = z.ZodError['issues'][number];

/**
 * Rewrites Zod messages that are accurate but unhelpful to a YAML author.
 *
 * A missing key reports as "expected nonoptional, received undefined", which
 * describes the schema rather than the mistake. The file being validated is
 * hand-written by a human, so the message has to be about their edit.
 */
function describeIssue(issue: Issue): string {
  if (issue.code === 'invalid_type' && issue.expected === 'nonoptional') {
    /* `input` is the one field where "just add the key" is bad advice — the
       author may well have meant a genuinely empty input. */
    return issue.path.length === 1 && issue.path[0] === 'input'
      ? 'Required (use `input: null` if the case genuinely has no input)'
      : 'Required';
  }
  return issue.message;
}

/** `["expect", "fields", 0]` -> `"expect.fields[0]: "`. Empty path -> `""`. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '';
  const rendered = path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`))
    .join('')
    .replace(/^\./, '');
  return `${rendered}: `;
}

function describeYamlError(error: unknown): string {
  if (error instanceof YAMLParseError) {
    const pos = error.linePos?.[0];
    const where = pos ? ` (line ${pos.line}, column ${pos.col})` : '';
    return `invalid YAML${where}: ${error.message}`;
  }
  return `invalid YAML: ${error instanceof Error ? error.message : String(error)}`;
}

/** Repo-relative paths when possible — absolute paths in an error message are
 *  noise the reader has to visually strip before finding the useful part. */
function display(target: string): string {
  const rel = relative(process.cwd(), target);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? target : rel;
}
