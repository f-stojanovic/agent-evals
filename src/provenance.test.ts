import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { formatProvenance, provenanceSchema, summariseProvenance } from './provenance.js';
import { loadFixtures } from './fixtures.js';
import type { Provenance } from './provenance.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureDir(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-prov-'));
  created.push(dir);
  await writeFile(join(dir, 'f.yaml'), yaml, 'utf8');
  return dir;
}

const OUTPUT = `  output:\n    model: m\n    text: '{}'\n`;

describe('provenanceSchema', () => {
  it('accepts a hand-authored entry', () => {
    expect(provenanceSchema.safeParse({ kind: 'hand-authored', author: 'Filip' }).success).toBe(true);
  });

  it('accepts a recorded entry with a capture date', () => {
    expect(
      provenanceSchema.safeParse({
        kind: 'recorded',
        model: 'claude-sonnet-5',
        capturedAt: '2026-08-19',
      }).success,
    ).toBe(true);
  });

  it('rejects a recorded entry with no capture date', () => {
    /* A recording with no date cannot be checked against the model it claims. */
    expect(
      provenanceSchema.safeParse({ kind: 'recorded', model: 'claude-sonnet-5' }).success,
    ).toBe(false);
  });

  it('refuses to let a hand-authored entry name a model', () => {
    /* The two arms are structurally different so that dressing hand-written
       data up as a recording takes deliberate lying, not a loose adjective. */
    expect(
      provenanceSchema.safeParse({
        kind: 'hand-authored',
        author: 'Filip',
        model: 'claude-sonnet-5',
      }).success,
    ).toBe(false);
  });

  it('rejects an entry with no kind at all', () => {
    expect(provenanceSchema.safeParse({ author: 'Filip' }).success).toBe(false);
  });
});

describe('loadFixtures', () => {
  it('refuses a fixture that does not say where it came from', async () => {
    const dir = await fixtureDir(`- caseId: a\n${OUTPUT}`);

    /* The whole point: adding a fixture without stating provenance is a
       load-time error, not an omission somebody notices a year later. */
    await expect(loadFixtures(dir)).rejects.toThrow(/provenance/);
  });

  it('loads a fixture that declares hand-authored provenance', async () => {
    const dir = await fixtureDir(
      `- caseId: a\n  provenance:\n    kind: hand-authored\n    author: Filip\n${OUTPUT}`,
    );

    const fixtures = await loadFixtures(dir);

    expect(fixtures.get('a')?.provenance).toEqual({ kind: 'hand-authored', author: 'Filip' });
  });

  it('every committed fixture declares hand-authored provenance', async () => {
    const dir = fileURLToPath(new URL('../evals/fixtures', import.meta.url));

    const fixtures = await loadFixtures(dir);

    /* These were written by hand. A code comment once claimed otherwise; this
       assertion is what makes the claim checkable. ADR 015. */
    expect([...fixtures.values()].every((f) => f.provenance.kind === 'hand-authored')).toBe(true);
  });
});

describe('summariseProvenance', () => {
  const hand = (author: string): { provenance: Provenance } => ({
    provenance: { kind: 'hand-authored', author },
  });
  const rec = (model: string): { provenance: Provenance } => ({
    provenance: { kind: 'recorded', model, capturedAt: '2026-08-19' },
  });

  it('counts each kind and lists the models and authors', () => {
    const summary = summariseProvenance('fixtures', [hand('Filip'), rec('sonnet'), rec('sonnet')]);

    expect(summary).toMatchObject({
      total: 3,
      handAuthored: 1,
      recorded: 2,
      models: ['sonnet'],
      authors: ['Filip'],
    });
  });

  it('warns in the rendered output when nothing was recorded', () => {
    const rendered = formatProvenance(summariseProvenance('fixtures', [hand('Filip')]));

    /* A suite running entirely on invented inputs says so in its own output. */
    expect(rendered.join('\n')).toContain('every input was written by hand');
    expect(rendered.join('\n')).toContain('exercised the harness, not the model');
  });

  it('does not warn when the data was captured', () => {
    const rendered = formatProvenance(summariseProvenance('fixtures', [rec('sonnet')]));

    expect(rendered.join('\n')).not.toContain('written by hand');
    expect(rendered.join('\n')).toContain('1 recorded from sonnet');
  });

  it('handles an empty set without claiming anything', () => {
    expect(formatProvenance(summariseProvenance('fixtures', []))).toEqual(['- fixtures: none']);
  });
});
