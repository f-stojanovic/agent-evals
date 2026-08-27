import { describe, expect, it } from 'vitest';
import { SdkUsageError, parseSdkUsage } from './sdk-usage.js';

describe('parseSdkUsage', () => {
  it('reads the shape the SDK sends today', () => {
    expect(parseSdkUsage({ input_tokens: 1061, output_tokens: 195 }, 'judge')).toEqual({
      inputTokens: 1061,
      outputTokens: 195,
    });
  });

  it('carries cache counts when they are present', () => {
    expect(
      parseSdkUsage(
        {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
        },
        'judge',
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    });
  });

  it('treats null cache counts as absent, because that is what the SDK sends', () => {
    const usage = parseSdkUsage(
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      'judge',
    );
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    /* Absent, not present-and-zero: `exactOptionalPropertyTypes` is on and a
       zero here would price a cache read that never happened. */
    expect('cacheReadTokens' in usage).toBe(false);
  });

  /**
   * THE DEFECT THIS BOUNDARY EXISTS FOR.
   *
   * A renamed or dropped token field used to read as `undefined`, and
   * `undefined / 1_000_000 * price` is `NaN`, and `JSON.stringify(NaN)` is
   * `null`. The run finished, the artifact recorded a null cost, and nothing
   * anywhere said the number was not a number.
   */
  it.each([
    ['a renamed input field', { inputTokens: 10, output_tokens: 5 }],
    ['a missing output field', { input_tokens: 10 }],
    ['a null token count', { input_tokens: null, output_tokens: 5 }],
    ['a string token count', { input_tokens: '10', output_tokens: 5 }],
    ['a fractional token count', { input_tokens: 10.5, output_tokens: 5 }],
    ['a negative token count', { input_tokens: -1, output_tokens: 5 }],
    ['usage missing entirely', undefined],
    ['usage that is not an object', 42],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseSdkUsage(raw, 'judge')).toThrow(SdkUsageError);
  });

  it('names the call site and the peer range, so the reader knows where to look', () => {
    let message = '';
    try {
      parseSdkUsage({ output_tokens: 5 }, 'judge "claude-opus-5"');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('judge "claude-opus-5"');
    expect(message).toContain('input_tokens');
    expect(message).toContain('npm ls @anthropic-ai/sdk');
    expect(message).toContain('>=0.117.1 <1');
  });

  /**
   * `z.object`, not `z.strictObject`, and this is the test that says why.
   *
   * The SDK adds usage fields on a normal release schedule — server-side tool
   * counts, new cache tiers. Rejecting those would make the validator fail on
   * every additive release, which is precisely the treadmill the wide peer
   * range exists to avoid. Unknown keys are the vendor's business.
   */
  it('accepts fields it does not know about', () => {
    expect(
      parseSdkUsage(
        {
          input_tokens: 10,
          output_tokens: 5,
          server_tool_use: { web_search_requests: 3 },
          some_field_invented_next_year: 'whatever',
        },
        'judge',
      ),
    ).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
