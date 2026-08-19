/**
 * Fixture builders for the domain types. PUBLIC API, exported from the package
 * root and covered by its own tests.
 *
 * Deliberate, not incidental. The main reason to use this harness is to write
 * scorers for your own domain, and testing a scorer means constructing a
 * `SubjectOutput` — which without these means restating `raw`, `model`,
 * `usage`, and `latencyMs` in every single test, noise that buries the one
 * field the test is actually about. Leaving consumers to hand-roll that is
 * leaving the most common task in the package unsupported.
 *
 * Being API has consequences, which is the point of saying so:
 *
 *   - The defaults are part of the contract. Tests elsewhere assert against
 *     them, so changing `model` from `'test-model'` is a breaking change, not
 *     a tidy-up.
 *   - Every builder takes overrides and omits absent optional keys rather than
 *     setting them to `undefined`, matching what the loader produces under
 *     `exactOptionalPropertyTypes`. A fixture that is subtly a different shape
 *     from real data is worse than no fixture.
 *   - It ships in `dist`. It is small, dependency-free, and importing it does
 *     not pull in a test framework.
 */

import { extractStructured } from './scorers/extract.js';
import type {
  EvalCase,
  Extraction,
  ScoreArgs,
  SubjectContext,
  SubjectOutput,
  ToolCall,
} from './types.js';

/**
 * A `SubjectOutput` with plausible defaults, overridable per field.
 *
 * `text` and `toolCalls` are only set when supplied, so a caller can produce
 * an output that genuinely has neither — the case that matters most when
 * testing extraction.
 */
export function subjectOutput(
  overrides: {
    text?: string;
    toolCalls?: ToolCall[];
    raw?: unknown;
    model?: string;
    latencyMs?: number;
  } = {},
): SubjectOutput {
  return {
    raw: overrides.raw ?? null,
    model: overrides.model ?? 'test-model',
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: overrides.latencyMs ?? 0,
    ...(overrides.text !== undefined && { text: overrides.text }),
    ...(overrides.toolCalls !== undefined && { toolCalls: overrides.toolCalls }),
  };
}

/** An `EvalCase` with a default id and input, so a test states only the
 *  expectations it is exercising. */
export function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  const { id, input, expect: expectations, ...rest } = overrides;
  return {
    id: id ?? 'test-case',
    input: input ?? null,
    expect: expectations ?? {},
    ...rest,
  };
}

/**
 * The argument object a scorer receives, with `extraction` derived from the
 * output exactly as the runner derives it.
 *
 * Deriving rather than requiring the caller to supply it keeps tests honest:
 * a hand-written extraction could disagree with what the real pipeline would
 * produce, and a scorer test that passes against an impossible input is worth
 * nothing. Pass `extraction` explicitly only to exercise a case the real
 * extractor cannot reach.
 */
export function scoreArgs(
  overrides: { case?: EvalCase; output?: SubjectOutput; extraction?: Extraction } = {},
): ScoreArgs {
  const output = overrides.output ?? subjectOutput();
  return {
    case: overrides.case ?? evalCase(),
    output,
    extraction: overrides.extraction ?? extractStructured(output),
  };
}

/** A `SubjectContext` for a first attempt, with a signal that never aborts. */
export function subjectContext(overrides: Partial<SubjectContext> = {}): SubjectContext {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    caseId: overrides.caseId ?? 'test-case',
    attempt: overrides.attempt ?? 0,
  };
}
