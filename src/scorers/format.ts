/**
 * Format compliance — the other half of the split that `extractStructured`
 * makes possible.
 */

import { extractStructured } from './extract.js';
import type { ExtractionRoute } from './extract.js';
import type { EvalCase, Score, Scorer, SubjectOutput } from '../types.js';

export type FormatComplianceOptions = {
  readonly name?: string;
  /**
   * Score for a response that was one clean fenced block and nothing else.
   *
   * Partial rather than 0 or 1 because a fence genuinely sits between the two:
   * the model produced the right content with the wrong envelope, and every
   * parser in the world handles it. Whether that matters depends on the
   * consumer — a pipeline reading `response.text` directly into `JSON.parse`
   * breaks on it, one using a tolerant client does not. 0.5 is a starting
   * point, not a finding.
   */
  readonly fencedScore?: number;
  /** `passed` cutoff. Defaults to 1: by default only a clean payload passes. */
  readonly threshold?: number;
};

/**
 * Scores HOW the structured payload arrived, ignoring entirely whether it was
 * correct.
 *
 * WHY THIS IS A SEPARATE SCORER
 * -----------------------------
 * `extractStructured` is deliberately lenient: it will dig a fenced JSON block
 * out of three paragraphs of preamble, because refusing to would conflate two
 * unrelated properties. A model that reads an email perfectly and says "Sure!
 * Here's the JSON:" first has a formatting problem, not a comprehension
 * problem, and a single number that drops for either reason tells you neither.
 *
 * So the leniency lives there and the judgement lives here. `exactFields`
 * answers "did it understand?"; this answers "did it comply?". Both are
 * recorded, both are visible in the baseline, and a regression in one does not
 * masquerade as a regression in the other.
 *
 * This is also why the scorer reads `via` rather than re-parsing the response:
 * there must be exactly one implementation of "how did the payload arrive", or
 * the two scorers will eventually disagree about the same output.
 *
 * `format` is an OPTIONAL claim: this scorer needs no expectation to do its
 * job, and a suite can register it globally to track preamble discipline
 * across every case. `expect.format` is reserved for a future refinement
 * (naming the routes a specific case will accept) and is not read yet.
 */
export function formatCompliance(options: FormatComplianceOptions = {}): Scorer {
  const name = options.name ?? 'format-compliance';
  const fencedScore = options.fencedScore ?? 0.5;
  const threshold = options.threshold ?? 1;

  return {
    name,
    claims: [{ key: 'format', required: false }],
    async score({ case: _case, output }: { case: EvalCase; output: SubjectOutput }): Promise<Score> {
      const extraction = extractStructured(output);

      if ('error' in extraction) {
        return {
          scorer: name,
          value: 0,
          passed: false,
          reason: `no structured payload could be found: ${extraction.error}`,
          meta: { via: null },
        };
      }

      const value = scoreRoute(extraction.via, fencedScore);
      return {
        scorer: name,
        value,
        passed: value >= threshold,
        reason: ROUTE_REASONS[extraction.via],
        meta: { via: extraction.via },
      };
    },
  };
}

/** A switch rather than a lookup table, so adding a route to
 *  {@link ExtractionRoute} fails to compile until it is scored here. */
function scoreRoute(via: ExtractionRoute, fencedScore: number): number {
  switch (via) {
    case 'tool-call':
    case 'json':
      return 1;
    case 'fenced':
      return fencedScore;
    case 'scavenged':
      return 0;
  }
}

const ROUTE_REASONS: Record<ExtractionRoute, string> = {
  'tool-call': 'the model used the tool it was given',
  json: 'the whole response was valid JSON',
  fenced: 'the response was wrapped in a markdown code fence',
  scavenged: 'the payload had to be dug out of surrounding prose',
};
