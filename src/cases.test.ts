import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CaseLoadError, loadCases } from './cases.js';
import { validateExpectations } from './scorers/registry.js';
import { callsTool, exactFields, matchesSchema } from './scorers/exact.js';

/* Temp dirs rather than committed fixtures: each test states the exact YAML it
   is about, so a reader never has to open a second file to understand it. The
   one exception is the real evals/cases directory, which is the point of the
   last test. */
const created: string[] = [];

async function tempSuite(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return dir;
}

/** Runs `loadCases` expecting failure and returns the error. Keeps the
 *  assertion in the test body instead of behind a try/catch each time. */
async function loadFailure(dir: string): Promise<CaseLoadError> {
  const error = await loadCases(dir).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CaseLoadError);
  return error as CaseLoadError;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadCases', () => {
  it('loads a list of cases and a single-mapping case, including nested dirs', async () => {
    const dir = await tempSuite({
      'a.yaml': [
        '- id: beta',
        '  input: { text: hello }',
        '  expect: { intent: greeting }',
        '- id: alpha',
        '  description: second in the file',
        '  tags: [smoke]',
        '  weight: 2',
        '  input: 42',
        '  expect: { intent: number }',
      ].join('\n'),
      'nested/b.yml': ['id: gamma', 'input: null', 'expect: {}'].join('\n'),
    });

    const cases = await loadCases(dir);

    expect(cases.map((c) => c.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(cases[0]).toEqual({
      id: 'alpha',
      description: 'second in the file',
      tags: ['smoke'],
      weight: 2,
      input: 42,
      expect: { intent: 'number' },
    });
    /* `input: null` is a real, deliberate value — not a missing field. */
    expect(cases[2]?.input).toBeNull();
  });

  it('omits absent optional keys rather than setting them to undefined', async () => {
    const dir = await tempSuite({
      'a.yaml': ['id: minimal', 'input: hi', 'expect: {}'].join('\n'),
    });

    const [only] = await loadCases(dir);

    /* Matters under exactOptionalPropertyTypes: `{ description: undefined }`
       and `{}` are different types, and only the latter matches EvalCase. */
    expect(only && 'description' in only).toBe(false);
    expect(only && 'tags' in only).toBe(false);
    expect(only && 'weight' in only).toBe(false);
  });

  it('carries `meta` through untouched, as free-form authoring annotation', async () => {
    const dir = await tempSuite({
      'a.yaml': [
        'id: annotated',
        'input: hi',
        'expect: {}',
        'meta:',
        '  owner: filip',
        '  ticket: EVAL-12',
        '  nested: { anything: [1, 2] }',
      ].join('\n'),
    });

    const [only] = await loadCases(dir);

    expect(only?.meta).toEqual({
      owner: 'filip',
      ticket: 'EVAL-12',
      nested: { anything: [1, 2] },
    });
  });

  it('names the case id in errors from single-mapping files too', async () => {
    const dir = await tempSuite({
      'list.yaml': ['- id: in-a-list', '  input: hi'].join('\n'),
      'mapping.yaml': ['id: on-its-own', 'input: hi'].join('\n'),
    });

    const error = await loadFailure(dir);

    /* Uniform across both file shapes: the id is what the author searches
       for, and the index only means something in a list. */
    expect(error.problems.find((p) => p.includes('list.yaml'))).toContain(
      '[case 0 · id "in-a-list"]',
    );
    expect(error.problems.find((p) => p.includes('mapping.yaml'))).toContain(
      '[id "on-its-own"]',
    );
  });

  it('reports malformed YAML with the file path and position', async () => {
    const dir = await tempSuite({
      'broken.yaml': ['id: oops', '  input: badly indented', 'expect: {}'].join('\n'),
    });

    const error = await loadFailure(dir);

    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain('broken.yaml');
    expect(error.problems[0]).toContain('invalid YAML');
    expect(error.problems[0]).toMatch(/line \d+/);
  });

  it('reports a missing required field with the case id and the issue path', async () => {
    const dir = await tempSuite({
      'cases.yaml': ['- id: has-no-expect', '  input: hi'].join('\n'),
    });

    const error = await loadFailure(dir);

    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain('cases.yaml');
    expect(error.problems[0]).toContain('has-no-expect');
    expect(error.problems[0]).toContain('expect:');
  });

  it('requires `input` to be present, since null is a legal value', async () => {
    const dir = await tempSuite({
      'cases.yaml': ['- id: no-input', '  expect: {}'].join('\n'),
    });

    const error = await loadFailure(dir);

    expect(error.problems[0]).toContain('input:');
    expect(error.problems[0]).toContain('input: null');
  });

  it('rejects unknown keys so that typos are not silently ignored', async () => {
    const dir = await tempSuite({
      'cases.yaml': ['id: typo', 'input: hi', 'expect: {}', 'tag: smoke'].join('\n'),
    });

    const error = await loadFailure(dir);

    expect(error.problems[0]).toContain('tag');
  });

  it('reports every problem in one pass instead of failing fast', async () => {
    const dir = await tempSuite({
      'a.yaml': ['- id: ""', '  input: hi', '  expect: {}'].join('\n'),
      'b.yaml': ['- id: bad-weight', '  input: hi', '  expect: {}', '  weight: -1'].join('\n'),
    });

    const error = await loadFailure(dir);

    expect(error.problems).toHaveLength(2);
    expect(error.message).toContain('2 problems');
  });

  it('rejects a duplicate id and names both files', async () => {
    const dir = await tempSuite({
      'first.yaml': ['id: shared-id', 'input: one', 'expect: {}'].join('\n'),
      'second.yaml': ['id: shared-id', 'input: two', 'expect: {}'].join('\n'),
    });

    const error = await loadFailure(dir);

    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain('shared-id');
    expect(error.problems[0]).toContain('first.yaml');
    expect(error.problems[0]).toContain('second.yaml');
  });

  it('returns an empty array for a directory with no case files', async () => {
    const dir = await tempSuite({ 'README.md': 'not a case file', 'empty.yaml': '' });

    await expect(loadCases(dir)).resolves.toEqual([]);
  });

  it('throws an actionable error for a directory that does not exist', async () => {
    const error = await loadFailure(join(tmpdir(), 'agent-evals-does-not-exist-xyz'));

    expect(error.problems[0]).toContain('case directory not found');
  });

  it('orders by id, not by filename or filesystem order', async () => {
    const dir = await tempSuite({
      'z-first.yaml': ['- id: aaa', '  input: 1', '  expect: {}'].join('\n'),
      'a-last.yaml': ['- id: zzz', '  input: 2', '  expect: {}'].join('\n'),
      'm-middle.yaml': ['- id: mmm', '  input: 3', '  expect: {}'].join('\n'),
    });

    /* Loaded twice: ordering must be a property of the loader, not of whatever
       order the filesystem happened to hand back this time. */
    const first = await loadCases(dir);
    const second = await loadCases(dir);

    expect(first.map((c) => c.id)).toEqual(['aaa', 'mmm', 'zzz']);
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it('loads the example suite committed to this repo', async () => {
    const dir = fileURLToPath(new URL('../evals/cases', import.meta.url));

    const cases = await loadCases(dir);

    expect(cases).toHaveLength(3);
    expect(cases.map((c) => c.id)).toEqual([
      'cancellation-or-complaint-01',
      'outage-escalation-01',
      'refund-damaged-item-01',
    ]);
    expect(cases.some((c) => c.tags?.includes('ambiguous'))).toBe(true);
  });

  it('the example suite is wired to scorers that actually measure it', async () => {
    const dir = fileURLToPath(new URL('../evals/cases', import.meta.url));

    const cases = await loadCases(dir);

    /* The check the repo's own examples must pass, or the README is lying:
       every expectation key is claimed, and no case is measured by nothing. */
    expect(() =>
      validateExpectations(cases, [exactFields(), matchesSchema(), callsTool()]),
    ).not.toThrow();
  });
});
