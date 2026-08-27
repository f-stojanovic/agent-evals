/**
 * The SDK response boundary.
 *
 * WHY THIS EXISTS, AND WHY IT DID NOT BEFORE
 * ------------------------------------------
 * This repository puts Zod where untrusted or unstable data enters, and
 * nowhere else. Until `@anthropic-ai/sdk` became a peer dependency it was
 * neither: `dependencies` pinned it to a caret range, so the shape of
 * `response.usage` was fixed at install time and the TypeScript types were a
 * real guarantee about the object that would arrive at run time.
 *
 * ADR 024 widened that to `>=0.117.1 <1` so a consumer runs one SDK copy
 * rather than two. That decision moved the response into the unstable
 * category, because the version compiled against and the version executed are
 * now allowed to differ by an arbitrary number of minors — and under semver a
 * `0.x` minor may break. THE RANGE IS WIDE BECAUSE THIS BOUNDARY IS
 * VALIDATED, NOT IN SPITE OF IT. Without the check the honest range would be
 * narrow, and a narrow range charges a push, a tag and a re-pin in every
 * consumer for each SDK minor.
 *
 * WHAT IT COST TO LEAVE OUT, MEASURED
 * -----------------------------------
 * `usage` was read structurally. A field this code names that the SDK no
 * longer sends reads as `undefined`, and `undefined / 1_000_000 * price` is
 * `NaN`, and `JSON.stringify(NaN)` is `null`. So a renamed field produced a
 * cost of `null` in `.artifacts/` — indistinguishable from free — in the
 * artifact this repository points at when it claims its figures are
 * attributable. See ADR 026.
 *
 * `z.object`, NOT `z.strictObject`
 * --------------------------------
 * Deliberate, and the opposite of what `cases.ts` and `fixtures.ts` do. Those
 * validate files a human wrote, where an unrecognised key is a typo and
 * failing loudly is the whole point. This validates a payload a vendor wrote,
 * where new keys appear on a normal release schedule and are not errors.
 * `strictObject` here would reject every additive SDK change — turning the
 * validator into the exact treadmill the wide range exists to avoid.
 *
 * So: the fields this code reads must be present and must be numbers. Fields
 * it does not read are none of its business.
 */

import { z } from 'zod';
import type { Usage } from './types.js';

/**
 * The SDK sent something this code cannot price.
 *
 * Distinct from a model failure and from a transport failure: the request
 * succeeded, the model answered, and the accounting attached to that answer is
 * not what this code knows how to read. That is a fact about the SDK version
 * in the tree, and the message says so, because the reader's next move is to
 * look at which version resolved rather than at their prompt.
 */
export class SdkUsageError extends Error {
  override readonly name = 'SdkUsageError';
  constructor(source: string, issues: readonly string[]) {
    super(
      `${source}: the SDK returned a usage object this build cannot read — ` +
        `${issues.join('; ')}.\n\n` +
        `agent-evals declares @anthropic-ai/sdk as a peer dependency at ` +
        `">=0.117.1 <1" (ADR 024), so the installed version may be newer than ` +
        `the one this code was compiled against. Check which version resolved ` +
        `(npm ls @anthropic-ai/sdk).\n\n` +
        `This is refused rather than defaulted. A missing token count used to ` +
        `produce NaN, which JSON.stringify writes as null, and a null cost in ` +
        `a run artifact is indistinguishable from a free one (ADR 026).`,
    );
  }
}

/* Token counts: required, integral, non-negative. Cache counts: optional, and
   `nullish` because the SDK sends `null` rather than omitting them on requests
   that used no cache. */
const nonNegativeInt = z.number().int().nonnegative();

const sdkUsageSchema = z.object({
  input_tokens: nonNegativeInt,
  output_tokens: nonNegativeInt,
  cache_read_input_tokens: nonNegativeInt.nullish(),
  cache_creation_input_tokens: nonNegativeInt.nullish(),
});

/**
 * Reads an SDK `usage` object, or refuses.
 *
 * `source` names the call site — "judge", "support-extraction" — so a failure
 * says which request produced it without a stack trace.
 */
export function parseSdkUsage(raw: unknown, source: string): Usage {
  const parsed = sdkUsageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SdkUsageError(
      source,
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`,
      ),
    );
  }

  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    parsed.data;

  return {
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    ...(cache_read_input_tokens != null && { cacheReadTokens: cache_read_input_tokens }),
    ...(cache_creation_input_tokens != null && { cacheWriteTokens: cache_creation_input_tokens }),
  };
}
