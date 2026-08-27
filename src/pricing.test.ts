import { describe, expect, it } from 'vitest';
import { PRICES, costOf, priceFor } from './pricing.js';
import type { Cost, CostBreakdown } from './types.js';

describe('the price table', () => {
  it('dates and attributes every entry', () => {
    /* A cost figure with no provenance is a number nobody can check. */
    for (const [model, price] of Object.entries(PRICES)) {
      expect(price.source, model).toBeTruthy();
      expect(price.asOf, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('resolves a dated model snapshot to its base entry', () => {
    expect(priceFor('claude-opus-5-20260101')).toEqual(PRICES['claude-opus-5']);
  });

  it('prefers the longest matching prefix', () => {
    expect(priceFor('claude-opus-4-8')).toEqual(PRICES['claude-opus-4-8']);
  });
});

/** Narrows to the priced arm, failing the test if it is not. Keeps every
 *  assertion below readable without `as` casts. */
function known(cost: Cost): CostBreakdown {
  if (cost.kind !== 'known') throw new Error(`expected a known cost, got ${JSON.stringify(cost)}`);
  return cost.breakdown;
}

describe('costOf', () => {
  it('prices input and output separately', () => {
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'claude-opus-5');

    expect(cost.kind).toBe('known');
    expect(known(cost).inputUsd).toBeCloseTo(5);
    expect(known(cost).outputUsd).toBeCloseTo(25);
    expect(known(cost).totalUsd).toBeCloseTo(30);
  });

  it('prices cache reads and writes against the input rate', () => {
    const cost = costOf(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      'claude-opus-5',
    );

    expect(known(cost).cacheReadUsd).toBeCloseTo(0.5);
    expect(known(cost).cacheWriteUsd).toBeCloseTo(6.25);
  });

  it('omits cache costs when the usage does not report them', () => {
    const cost = costOf({ inputTokens: 10, outputTokens: 10 }, 'claude-opus-5');

    expect(known(cost)).not.toHaveProperty('cacheReadUsd');
  });

  it('reports an unknown model as unpriced rather than guessing zero', () => {
    /* A silently free model makes a suite look cheaper than it is, which is
       the wrong direction for a number people budget against. */
    const cost = costOf({ inputTokens: 1000, outputTokens: 1000 }, 'some-other-model');

    expect(cost).toEqual({
      kind: 'unknown',
      gaps: [{ kind: 'unpriced', model: 'some-other-model' }],
    });
    /* And it carries no figure at all, so nothing downstream can add it in. */
    expect(cost).not.toHaveProperty('pricedPortion');
  });

  it('prices a local model at zero, explicitly', () => {
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 0 }, 'Xenova/all-MiniLM-L6-v2');

    /* `known` and zero, which is a different claim from `unknown` — the report
       prints $0.0000 for this and `?` for that. */
    expect(cost.kind).toBe('known');
    expect(known(cost).totalUsd).toBe(0);
  });
});
