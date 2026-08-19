import { describe, expect, it } from 'vitest';
import { PRICES, costOf, priceFor } from './pricing.js';

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

describe('costOf', () => {
  it('prices input and output separately', () => {
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'claude-opus-5');

    expect(cost?.inputUsd).toBeCloseTo(5);
    expect(cost?.outputUsd).toBeCloseTo(25);
    expect(cost?.totalUsd).toBeCloseTo(30);
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

    expect(cost?.cacheReadUsd).toBeCloseTo(0.5);
    expect(cost?.cacheWriteUsd).toBeCloseTo(6.25);
  });

  it('omits cache costs when the usage does not report them', () => {
    const cost = costOf({ inputTokens: 10, outputTokens: 10 }, 'claude-opus-5');

    expect(cost).not.toHaveProperty('cacheReadUsd');
  });

  it('returns undefined for an unknown model rather than guessing zero', () => {
    /* A silently free model makes a suite look cheaper than it is, which is
       the wrong direction for a number people budget against. */
    expect(costOf({ inputTokens: 1000, outputTokens: 1000 }, 'some-other-model')).toBeUndefined();
  });

  it('prices a local model at zero, explicitly', () => {
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 0 }, 'Xenova/all-MiniLM-L6-v2');

    expect(cost?.totalUsd).toBe(0);
  });
});
