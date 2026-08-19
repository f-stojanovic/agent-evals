/**
 * Format compliance — the other half of the split that `extractStructured`
 * makes possible.
 */

import type { EvalCase, ExtractionRoute, Score, ScoreArgs, Scorer } from '../types.js';

/**
 * What a case declares in `expect.format`.
 *
 * `any` is not a way of opting out of the check — it is a positive statement
 * that this case does not care how the payload arrived, which is a different
 * thing from forgetting to say. Omitting the key entirely skips the scorer.
 */
export const FORMAT_EXPECTATIONS = ['tool-call', 'json', 'fenced', 'any'] as const;
export type FormatExpectation = (typeof FORMAT_EXPECTATIONS)[number];

export type FormatComplianceOptions = {
  readonly name?: string;
};

/**
 * Scores HOW the structured payload arrived against how the case said it
 * should, ignoring entirely whether the content was correct.
 *
 * WHY THIS IS A SEPARATE SCORER
 * -----------------------------
 * `extractStructured` is deliberately lenient: it will dig a fenced JSON block
 * out of a paragraph of preamble, because refusing to would conflate two
 * unrelated properties. A model that reads an email perfectly and says "Sure!
 * Here's the JSON:" first has a formatting problem, not a comprehension
 * problem, and a single number that drops for either reason tells you neither.
 *
 * So the leniency lives there and the judgement lives here. `exactFields`
 * answers "did it understand?"; this answers "did it comply?".
 *
 * WHY THERE IS NO PARTIAL CREDIT FOR A FENCE
 * ------------------------------------------
 * An earlier version scored a fenced response 0.5 by default. That number was
 * invented. Whether a markdown fence is acceptable depends entirely on what
 * consumes the output — a pipeline calling `JSON.parse(response.text)` breaks
 * on it, one using a tolerant client does not — and that is a question the
 * case author can answer and the harness cannot. So the author answers it, per
 * case, by declaring `format: fenced` (fences are fine) or `format: json`
 * (they are not), and the score is 1 or 0 against their declaration. A
 * made-up 0.5 was worse than either: it produced a number that looked
 * calibrated, applied one team's tolerance to everyone, and moved the suite
 * mean for reasons unrelated to the model.
 *
 * `scavenged` never satisfies anything except `any`: whatever your tolerance
 * for envelopes, a payload buried in prose was not the requested output.
 */
export function formatCompliance(options: FormatComplianceOptions = {}): Scorer {
  const name = options.name ?? 'format-compliance';

  return {
    name,
    claims: [{ key: 'format', required: true }],
    async score({ case: evalCase, extraction }: ScoreArgs): Promise<Score> {
      const declared = readFormatExpectation(name, evalCase);

      if (extraction.via === 'none') {
        return {
          scorer: name,
          value: 0,
          passed: false,
          reason: `no structured payload could be found: ${extraction.error}`,
          meta: { declared, via: 'none' },
        };
      }

      const satisfied = satisfies(declared, extraction.via);
      return {
        scorer: name,
        value: satisfied ? 1 : 0,
        passed: satisfied,
        reason: satisfied
          ? `arrived via ${extraction.via}, which satisfies the declared format "${declared}"`
          : `arrived via ${extraction.via}, but the case declares format "${declared}"`,
        meta: { declared, via: extraction.via },
      };
    },
  };
}

/**
 * A declared format accepts its own route and every strictly more compliant
 * one. Declaring `fenced` means "a fence is acceptable", not "a fence is
 * required" — a model that skipped the envelope entirely and returned bare
 * JSON has done better, and failing it for that would be perverse.
 */
function satisfies(declared: FormatExpectation, via: ExtractionRoute): boolean {
  switch (declared) {
    case 'any':
      return true;
    case 'tool-call':
      return via === 'tool-call';
    case 'json':
      return via === 'tool-call' || via === 'json';
    case 'fenced':
      return via === 'tool-call' || via === 'json' || via === 'fenced';
  }
}

function readFormatExpectation(scorerName: string, evalCase: EvalCase): FormatExpectation {
  if (!('format' in evalCase.expect)) {
    throw new Error(
      `Scorer "${scorerName}" ran against case "${evalCase.id}", which declares no ` +
        `\`expect.format\`. A scorer must only be invoked for cases that declare its ` +
        `required claimed keys.`,
    );
  }

  const raw = evalCase.expect['format'];
  if (!isFormatExpectation(raw)) {
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" has \`expect.format\` of ` +
        `${JSON.stringify(raw)}; expected one of ${FORMAT_EXPECTATIONS.join(', ')}`,
    );
  }
  return raw;
}

function isFormatExpectation(value: unknown): value is FormatExpectation {
  return (
    typeof value === 'string' && (FORMAT_EXPECTATIONS as readonly string[]).includes(value)
  );
}
