/**
 * Model prices, as data.
 *
 * Cost is not stored on a run; token counts are (see `Usage`). Cost is derived
 * from those counts and this table, which means an old run can be re-priced
 * when prices change instead of carrying a number that was true in June.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ THIS TABLE IS MAINTAINED BY HAND AND WILL GO STALE.                 │
 * │ Every entry carries `source` and `asOf`. Check them before quoting  │
 * │ a figure from a report to anyone who cares about the number.        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Nothing here fetches prices at runtime, deliberately. A harness that phones
 * a pricing endpoint mid-run makes its own cost figures non-reproducible and
 * adds a network dependency to a calculation that is multiplication. Stale and
 * dated beats live and unattributable.
 */

import type { CostBreakdown, Usage } from './types.js';

export type ModelPrice = {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
  /** USD per million tokens read from the prompt cache. */
  readonly cacheReadPerMTok?: number;
  /** USD per million tokens written to the prompt cache. */
  readonly cacheWritePerMTok?: number;
  /** Where the figure came from. */
  readonly source: string;
  /** ISO date the figure was last checked. */
  readonly asOf: string;
};

const ANTHROPIC_PRICING = 'https://claude.com/pricing#api';
const CHECKED = '2026-06-24';

/**
 * Cache multipliers are the published Anthropic ratios — reads at 0.1x the
 * input rate, 5-minute writes at 1.25x — applied to each model's input price
 * rather than listed as separate figures, so the two cannot drift apart.
 */
const anthropic = (
  inputPerMTok: number,
  outputPerMTok: number,
): ModelPrice => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok: inputPerMTok * 0.1,
  cacheWritePerMTok: inputPerMTok * 1.25,
  source: ANTHROPIC_PRICING,
  asOf: CHECKED,
});

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5': anthropic(10, 50),
  'claude-opus-5': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-sonnet-5': anthropic(3, 15),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-haiku-4-5': anthropic(1, 5),
  /* Local models cost nothing per token. Listed rather than special-cased so
     that "no price for this model" stays a real, reportable condition. */
  'Xenova/all-MiniLM-L6-v2': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    source: 'runs locally; no per-token cost',
    asOf: CHECKED,
  },
};

/** Looks up a price, tolerating the dated-snapshot suffixes some providers
 *  append (`claude-opus-5-20260101`). */
export function priceFor(model: string): ModelPrice | undefined {
  const exact = PRICES[model];
  if (exact !== undefined) return exact;

  const prefix = Object.keys(PRICES)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? undefined : PRICES[prefix];
}

/**
 * Prices one usage record.
 *
 * Returns `undefined` for an unknown model rather than guessing zero. A
 * silently free model would make a suite look cheaper than it is, which is the
 * wrong direction for a number people use to decide what they can afford to
 * run — the report says the model is unpriced instead.
 */
export function costOf(usage: Usage, model: string): CostBreakdown | undefined {
  const price = priceFor(model);
  if (price === undefined) return undefined;

  const inputUsd = (usage.inputTokens / 1_000_000) * price.inputPerMTok;
  const outputUsd = (usage.outputTokens / 1_000_000) * price.outputPerMTok;
  const cacheReadUsd =
    usage.cacheReadTokens !== undefined && price.cacheReadPerMTok !== undefined
      ? (usage.cacheReadTokens / 1_000_000) * price.cacheReadPerMTok
      : undefined;
  const cacheWriteUsd =
    usage.cacheWriteTokens !== undefined && price.cacheWritePerMTok !== undefined
      ? (usage.cacheWriteTokens / 1_000_000) * price.cacheWritePerMTok
      : undefined;

  return {
    inputUsd,
    outputUsd,
    ...(cacheReadUsd !== undefined && { cacheReadUsd }),
    ...(cacheWriteUsd !== undefined && { cacheWriteUsd }),
    totalUsd: inputUsd + outputUsd + (cacheReadUsd ?? 0) + (cacheWriteUsd ?? 0),
  };
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const cacheReadUsd = optionalSum(a.cacheReadUsd, b.cacheReadUsd);
  const cacheWriteUsd = optionalSum(a.cacheWriteUsd, b.cacheWriteUsd);
  return {
    inputUsd: a.inputUsd + b.inputUsd,
    outputUsd: a.outputUsd + b.outputUsd,
    ...(cacheReadUsd !== undefined && { cacheReadUsd }),
    ...(cacheWriteUsd !== undefined && { cacheWriteUsd }),
    totalUsd: a.totalUsd + b.totalUsd,
  };
}

export const ZERO_COST: CostBreakdown = { inputUsd: 0, outputUsd: 0, totalUsd: 0 };

function optionalSum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
