import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatUncalibratedReport,
  resetUncalibratedRegistry,
  uncalibrated,
  uncalibratedConstants,
} from './uncalibrated.js';

beforeEach(() => {
  resetUncalibratedRegistry();
});

describe('uncalibrated', () => {
  it('returns the value unchanged, so it can wrap a constant in place', () => {
    expect(uncalibrated(0.8, 'a-threshold', 'a guess')).toBe(0.8);
  });

  it('records what was declared', () => {
    uncalibrated(0.25, 'spread', 'disagreement cutoff');

    expect(uncalibratedConstants()).toEqual([
      { id: 'spread', value: 0.25, note: 'disagreement cutoff' },
    ]);
  });

  it('counts a repeated declaration once', () => {
    /* A factory called five times declares the same assumption five times.
       Reporting it five times would overstate how many there are. */
    for (let i = 0; i < 5; i += 1) uncalibrated(3, 'judge-samples', 'k');

    expect(uncalibratedConstants()).toHaveLength(1);
  });

  it('throws when one id is declared with two different values', () => {
    uncalibrated(0.7, 'threshold', 'first');

    /* Otherwise the report would describe at least one of them wrongly. */
    expect(() => uncalibrated(0.9, 'threshold', 'second')).toThrow(/declared as 0.7/);
  });

  it('sorts the report by id so it is stable across runs', () => {
    uncalibrated(1, 'zulu', 'z');
    uncalibrated(2, 'alpha', 'a');

    expect(uncalibratedConstants().map((c) => c.id)).toEqual(['alpha', 'zulu']);
  });
});

describe('formatUncalibratedReport', () => {
  it('says plainly when nothing was guessed', () => {
    expect(formatUncalibratedReport()).toBe('This run used no uncalibrated constants.');
  });

  it('counts and lists the assumptions', () => {
    uncalibrated(0.8, 'semantic-threshold', 'cosine cutoff, not measured');
    uncalibrated(3, 'judge-samples', 'verdicts per case');

    const rendered = formatUncalibratedReport();

    expect(rendered).toContain('2 uncalibrated constants');
    expect(rendered).toContain('semantic-threshold = 0.8');
    expect(rendered).toContain('cosine cutoff, not measured');
  });

  it('uses the singular for one', () => {
    uncalibrated(1, 'only', 'one');

    expect(formatUncalibratedReport()).toContain('1 uncalibrated constant:');
  });
});
