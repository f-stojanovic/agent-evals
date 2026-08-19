/**
 * These builders are public API, so their defaults are a contract other tests
 * (and other people's tests) assert against. That makes them worth testing
 * directly rather than only through the scorers that use them.
 */

import { describe, expect, it } from 'vitest';
import { evalCase, subjectContext, subjectOutput } from './testing.js';

describe('subjectOutput', () => {
  it('produces a complete SubjectOutput from no arguments', () => {
    expect(subjectOutput()).toEqual({
      raw: null,
      model: 'test-model',
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
    });
  });

  it('omits text and toolCalls unless supplied', () => {
    const output = subjectOutput();

    /* Matters under exactOptionalPropertyTypes, and matters more for the
       extraction tests: "no text" and "empty text" are different cases. */
    expect('text' in output).toBe(false);
    expect('toolCalls' in output).toBe(false);
  });

  it('applies overrides without dropping the defaults', () => {
    const output = subjectOutput({ text: '{}', model: 'claude-opus-5', latencyMs: 42 });

    expect(output.text).toBe('{}');
    expect(output.model).toBe('claude-opus-5');
    expect(output.latencyMs).toBe(42);
    expect(output.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('evalCase', () => {
  it('produces a valid EvalCase from no arguments', () => {
    expect(evalCase()).toEqual({ id: 'test-case', input: null, expect: {} });
  });

  it('keeps optional keys absent unless supplied', () => {
    const testCase = evalCase();

    expect('description' in testCase).toBe(false);
    expect('tags' in testCase).toBe(false);
    expect('meta' in testCase).toBe(false);
  });

  it('carries through every field it is given', () => {
    const testCase = evalCase({
      id: 'refund-01',
      input: { body: 'hello' },
      expect: { fields: { intent: 'refund' } },
      tags: ['smoke'],
      weight: 2,
      meta: { owner: 'filip' },
    });

    expect(testCase).toEqual({
      id: 'refund-01',
      input: { body: 'hello' },
      expect: { fields: { intent: 'refund' } },
      tags: ['smoke'],
      weight: 2,
      meta: { owner: 'filip' },
    });
  });
});

describe('subjectContext', () => {
  it('defaults to a first attempt with a signal that is not aborted', () => {
    const ctx = subjectContext();

    expect(ctx.attempt).toBe(0);
    expect(ctx.caseId).toBe('test-case');
    expect(ctx.signal.aborted).toBe(false);
  });

  it('accepts a retry attempt and an aborted signal', () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = subjectContext({ attempt: 2, signal: controller.signal, caseId: 'refund-01' });

    expect(ctx.attempt).toBe(2);
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.caseId).toBe('refund-01');
  });
});
