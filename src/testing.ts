/**
 * Fixture builders for the domain types.
 *
 * Shipped rather than kept in a test folder: anyone writing a scorer against
 * this package needs to construct a `SubjectOutput` to test it, and hand-
 * rolling one means restating `raw`, `model`, `usage`, and `latencyMs` on
 * every single test — noise that buries the one field the test is about.
 */

import type { EvalCase, SubjectContext, SubjectOutput, ToolCall } from './types.js';

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

/** A `SubjectContext` for a first attempt, with a signal that never aborts. */
export function subjectContext(overrides: Partial<SubjectContext> = {}): SubjectContext {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    caseId: overrides.caseId ?? 'test-case',
    attempt: overrides.attempt ?? 0,
  };
}
