import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  calibrateSemantic,
  formatSemanticCalibration,
  loadSemanticPairs,
} from './calibrate-semantic.js';
import type { SemanticPair } from './calibrate-semantic.js';
import type { Embedder } from './scorers/semantic.js';

/** Vectors keyed by text, so a test states the geometry it is about. */
function fakeEmbedder(vectors: Record<string, readonly number[]>): Embedder {
  return {
    locked: () => Promise.resolve({ modelId: 'fake', revision: null, dtype: 'test' }),
    embed: (texts) =>
      Promise.resolve(
        texts.map((t) => {
          const v = vectors[t];
          if (v === undefined) throw new Error(`no vector for "${t}"`);
          return v;
        }),
      ),
  };
}

const pair = (
  id: string,
  label: 'correct' | 'incorrect',
  candidate: string,
  reference: string,
): SemanticPair => ({
  id,
  label,
  candidate,
  reference: [reference],
  provenance: { kind: 'hand-authored', author: 'test' },
});

describe('calibrateSemantic', () => {
  it('recommends the midpoint when the groups separate cleanly', async () => {
    const embedder = fakeEmbedder({
      ref: [1, 0],
      near: [0.99, 0.141], // ~0.98
      far: [0.6, 0.8], //     0.60
    });

    const report = await calibrateSemantic({
      pairs: [pair('a', 'correct', 'near', 'ref'), pair('b', 'incorrect', 'far', 'ref')],
      embedder,
    });

    expect(report.separates).toBe(true);
    expect(report.threshold).toBeCloseTo(0.79, 1);
    expect(report.overlapping).toEqual([]);
  });

  it('refuses to recommend a threshold when the groups overlap', async () => {
    const embedder = fakeEmbedder({
      ref: [1, 0],
      good: [0.6, 0.8], //  0.60 — a correct pair scoring low
      bad: [0.99, 0.141], // 0.98 — an incorrect pair scoring high
    });

    const report = await calibrateSemantic({
      pairs: [pair('a', 'correct', 'good', 'ref'), pair('b', 'incorrect', 'bad', 'ref')],
      embedder,
    });

    /* A failed calibration is a result. Picking a number that splits
       overlapping data would look measured and would not be. */
    expect(report.separates).toBe(false);
    expect(report).not.toHaveProperty('threshold');
    expect(report.margin).toBeLessThan(0);
    expect(report.overlapping.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('takes the maximum over references, matching what the scorer does', async () => {
    const embedder = fakeEmbedder({
      'ref-far': [0, 1],
      'ref-near': [1, 0],
      candidate: [1, 0],
      other: [0, 1],
    });

    const report = await calibrateSemantic({
      pairs: [
        {
          id: 'multi',
          label: 'correct',
          candidate: 'candidate',
          /* Far reference first, so a min or a first-wins implementation
             would score 0 here instead of 1. */
          reference: ['ref-far', 'ref-near'],
          provenance: { kind: 'hand-authored', author: 'test' },
        },
        pair('neg', 'incorrect', 'other', 'ref-near'),
      ],
      embedder,
    });

    /* Calibrating against a different statistic than the scorer uses would
       produce a threshold that does not apply to it. */
    expect(report.scored.find((p) => p.id === 'multi')?.similarity).toBeCloseTo(1);
  });

  it('needs at least one pair of each label to say anything', async () => {
    await expect(
      calibrateSemantic({
        pairs: [pair('a', 'correct', 'x', 'y')],
        embedder: fakeEmbedder({ x: [1, 0], y: [1, 0] }),
      }),
    ).rejects.toThrow(/one pair of each label/);
  });

  it('refuses an empty set rather than reporting on nothing', async () => {
    await expect(
      calibrateSemantic({ pairs: [], embedder: fakeEmbedder({}) }),
    ).rejects.toThrow(/no pairs/);
  });
});

describe('formatSemanticCalibration', () => {
  it('names the overlapping pairs and recommends no threshold', async () => {
    const embedder = fakeEmbedder({ ref: [1, 0], good: [0.6, 0.8], bad: [0.99, 0.141] });
    const report = await calibrateSemantic({
      pairs: [pair('a', 'correct', 'good', 'ref'), pair('b', 'incorrect', 'bad', 'ref')],
      embedder,
    });

    const rendered = formatSemanticCalibration(report);

    expect(rendered).toContain('DOES NOT SEPARATE');
    expect(rendered).toContain('a (correct)');
    expect(rendered).toContain('b (incorrect)');
    expect(rendered).toContain('not relying on this scorer alone');
  });
});

describe('the committed calibration set', () => {
  it('loads, is hand-authored, and carries both labels', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration-semantic', import.meta.url));

    const pairs = await loadSemanticPairs(dir);

    expect(pairs.length).toBeGreaterThanOrEqual(10);
    expect(pairs.every((p) => p.provenance.kind === 'hand-authored')).toBe(true);
    expect(pairs.some((p) => p.label === 'correct')).toBe(true);
    expect(pairs.some((p) => p.label === 'incorrect')).toBe(true);
  });

  it('includes fluent-but-wrong negatives, not only off-topic ones', async () => {
    const dir = fileURLToPath(new URL('../evals/calibration-semantic', import.meta.url));

    const pairs = await loadSemanticPairs(dir);
    const fluentLies = pairs.filter((p) => p.label === 'incorrect' && p.id.includes('fluent'));

    /* A calibration set whose negatives are all gibberish reports a flattering
       separation and says nothing about the failure that matters. */
    expect(fluentLies.length).toBeGreaterThanOrEqual(3);
  });
});
