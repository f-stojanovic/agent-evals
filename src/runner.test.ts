import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_OFF, backoffMs, isRetryable, mapWithConcurrency, runSuite } from './runner.js';
import { evalCase, subjectOutput } from './testing.js';
import type { Score, ScoreArgs, Scorer, Subject, SubjectOutput } from './types.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-run-'));
  created.push(dir);
  return dir;
}

/** Scores the `n` field of the extracted payload, so a test can drive the
 *  value from the subject's output. */
function fieldScorer(name = 'field', consumesExtraction = true): Scorer {
  return {
    name,
    claims: [{ key: 'fields', required: true }],
    consumesExtraction,
    score: ({ extraction }: ScoreArgs): Promise<Score> => {
      const value =
        extraction.via === 'none' ? 0 : Number((extraction.data as { n?: number }).n ?? 0);
      return Promise.resolve({ scorer: name, value, passed: value >= 1 });
    },
  };
}

/** Reads output.text directly, so extraction failure is irrelevant to it. */
function textScorer(name = 'text'): Scorer {
  return {
    name,
    claims: [{ key: 'fields', required: true }],
    consumesExtraction: false,
    score: ({ output }: ScoreArgs): Promise<Score> =>
      Promise.resolve({
        scorer: name,
        value: (output.text ?? '').length > 0 ? 1 : 0,
        passed: true,
      }),
  };
}

const oneCase = [evalCase({ id: 'a', expect: { fields: { n: 1 } } })];
const jsonSubject = (n: number | (() => number)): Subject =>
  () =>
    Promise.resolve(
      subjectOutput({ text: JSON.stringify({ n: typeof n === 'function' ? n() : n }) }),
    );

const base = { subjectId: 'test', cache: CACHE_OFF, sleep: () => Promise.resolve() };

describe('runSuite', () => {
  it('samples a case n times and records the mean, spread and every draw', async () => {
    const values = [1, 0, 1];
    let index = 0;

    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: jsonSubject(() => values[index++] ?? 0),
      scorers: [fieldScorer()],
      samples: 3,
    });

    const result = run.results[0];
    expect(result?.sampleValues).toEqual([1, 0, 1]);
    expect(result?.value).toBeCloseTo(2 / 3);
    expect(result?.stdDev).toBeCloseTo(0.4714, 3);
    expect(result?.samples).toBe(3);
  });

  it('leaves stdDev absent for a single sample rather than claiming 0', async () => {
    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: jsonSubject(1),
      scorers: [fieldScorer()],
      samples: 1,
    });

    /* 0 would assert the case is perfectly stable when it has never been
       re-run. */
    expect(run.results[0]).not.toHaveProperty('stdDev');
  });

  it('marks a case errored, not zero, when extraction fails', async () => {
    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: () => Promise.resolve(subjectOutput({ text: 'I think it is probably fine.' })),
      scorers: [fieldScorer()],
    });

    /* Zero would assert the model was wrong. We could not read an answer,
       which is a different claim — and errored cases stay out of the baseline. */
    expect(run.results[0]?.status).toBe('errored');
    expect(run.results[0]?.error?.message).toContain('declined to decide');
    expect(run.totals.errored).toBe(1);
    expect(run.totals.failed).toBe(0);
  });

  it('marks a case errored when several fenced blocks parse', async () => {
    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: () =>
        Promise.resolve(
          subjectOutput({ text: 'One:\n```json\n{"n":1}\n```\nTwo:\n```json\n{"n":0}\n```' }),
        ),
      scorers: [fieldScorer()],
    });

    expect(run.results[0]?.status).toBe('errored');
    expect(run.results[0]?.extraction.via).toBe('none');
  });

  it('does not let a failed extraction stop a scorer that never reads it', async () => {
    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: () => Promise.resolve(subjectOutput({ text: 'prose, no JSON at all' })),
      scorers: [textScorer()],
    });

    /* Blast radius is the scorers that consume the extraction, not the case. */
    expect(run.results[0]?.status).toBe('scored');
    expect(run.results[0]?.value).toBe(1);
  });

  it('refuses to start when samples are below a scorer\'s floor', async () => {
    const needsThree: Scorer = { ...fieldScorer(), minSamples: 3 };

    await expect(
      runSuite({ ...base, cases: oneCase, subject: jsonSubject(1), scorers: [needsThree], samples: 1 }),
    ).rejects.toThrow(/requires at least 3 samples/);
  });

  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    const subject: Subject = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(Object.assign(new Error('slow down'), { status: 429 }));
      return Promise.resolve(subjectOutput({ text: '{"n":1}' }));
    };

    const run = await runSuite({ ...base, cases: oneCase, subject, scorers: [fieldScorer()] });

    expect(calls).toBe(2);
    expect(run.results[0]?.status).toBe('scored');
  });

  it('never retries a 400', async () => {
    let calls = 0;
    const subject: Subject = () => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('bad request'), { status: 400 }));
    };

    const run = await runSuite({ ...base, cases: oneCase, subject, scorers: [fieldScorer()] });

    /* A malformed request will be malformed again; retrying turns one clear
       error into the same error arriving slowly. */
    expect(calls).toBe(1);
    expect(run.results[0]?.status).toBe('errored');
  });

  it('errors a case whose subject hangs past the timeout', async () => {
    const subject: Subject = (_input, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject,
      scorers: [fieldScorer()],
      timeoutMs: 20,
    });

    expect(run.results[0]?.status).toBe('errored');
  });

  it('passes the attempt number to the subject', async () => {
    const attempts: number[] = [];
    const subject: Subject = (_input, ctx) => {
      attempts.push(ctx.attempt);
      if (ctx.attempt === 0) {
        return Promise.reject(Object.assign(new Error('boom'), { status: 503 }));
      }
      return Promise.resolve(subjectOutput({ text: '{"n":1}' }));
    };

    await runSuite({ ...base, cases: oneCase, subject, scorers: [fieldScorer()] });

    expect(attempts).toEqual([0, 1]);
  });

  it('writes and reuses a disk cache entry when caching is on', async () => {
    const dir = await tempDir();
    let calls = 0;
    const subject: Subject = () => {
      calls += 1;
      return Promise.resolve(subjectOutput({ text: '{"n":1}' }));
    };
    const options = {
      ...base,
      cache: { kind: 'disk' as const, dir },
      cases: oneCase,
      subject,
      scorers: [fieldScorer()],
    };

    await runSuite(options);
    await runSuite(options);

    expect(calls).toBe(1);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('does not touch the cache when caching is off', async () => {
    const dir = await tempDir();
    let calls = 0;
    const subject: Subject = () => {
      calls += 1;
      return Promise.resolve(subjectOutput({ text: '{"n":1}' }));
    };

    await runSuite({ ...base, cases: oneCase, subject, scorers: [fieldScorer()] });
    await runSuite({ ...base, cases: oneCase, subject, scorers: [fieldScorer()] });

    expect(calls).toBe(2);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('bypasses the cache on a retry', async () => {
    const dir = await tempDir();
    let calls = 0;
    const subject: Subject = (_input, ctx) => {
      calls += 1;
      if (ctx.attempt === 0) {
        return Promise.reject(Object.assign(new Error('boom'), { status: 503 }));
      }
      return Promise.resolve(subjectOutput({ text: '{"n":1}' }));
    };

    /* A retry exists to re-roll the sample. Serving the cached response would
       return the identical failure and prove nothing. */
    await runSuite({
      ...base,
      cache: { kind: 'disk', dir },
      cases: oneCase,
      subject,
      scorers: [fieldScorer()],
    });

    expect(calls).toBe(2);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('records the extraction route of every sample for the run-level metric', async () => {
    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: jsonSubject(1),
      scorers: [fieldScorer()],
      samples: 3,
    });

    expect(run.results[0]?.vias).toEqual(['json', 'json', 'json']);
    expect(run.viaDistribution).toEqual({ json: 3 });
  });

  it('collects uncalibrated constants from the scorers it was given', async () => {
    const guessing: Scorer = {
      ...fieldScorer(),
      uncalibrated: [{ id: 'field.threshold', value: 0.5, note: 'a guess' }],
    };

    const run = await runSuite({
      ...base,
      cases: oneCase,
      subject: jsonSubject(1),
      scorers: [guessing],
    });

    expect(run.uncalibrated).toEqual([{ id: 'field.threshold', value: 0.5, note: 'a guess' }]);
  });

  it('keeps errored cases out of the pass/fail tallies', async () => {
    const cases = [
      evalCase({ id: 'good', expect: { fields: { n: 1 } } }),
      evalCase({ id: 'broken', expect: { fields: { n: 1 } } }),
    ];
    const subject: Subject = (_input, ctx) =>
      Promise.resolve(
        subjectOutput({ text: ctx.caseId === 'good' ? '{"n":1}' : 'not json' }),
      );

    const run = await runSuite({ ...base, cases, subject, scorers: [fieldScorer()] });

    expect(run.totals).toMatchObject({ cases: 2, passed: 1, failed: 0, errored: 1 });
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the output', async () => {
    const result = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n));
      return n * 10;
    });

    expect(result).toEqual([30, 10, 20]);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return null;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty input', async () => {
    await expect(mapWithConcurrency([], 4, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});

describe('isRetryable', () => {
  it('retries 429 and 5xx', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it('does not retry other 4xx', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable({ status })).toBe(false);
    }
  });

  it('retries transport failures', () => {
    expect(isRetryable(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('does not retry a plain programming error', () => {
    expect(isRetryable(new RangeError('nope'))).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows exponentially and stays within the jitter window', () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(0, () => 0)).toBe(0);
  });

  it('caps the ceiling so a long retry chain does not stall CI', () => {
    expect(backoffMs(20, () => 1)).toBe(30_000);
  });
});

/** Guards the one option with no default, since the cost of forgetting it is a
 *  baseline recorded from replayed responses. */
describe('cache mode', () => {
  it('is a required option with no implicit default', () => {
    const options: Parameters<typeof runSuite>[0] = {
      cases: oneCase,
      subject: jsonSubject(1),
      subjectId: 'x',
      scorers: [fieldScorer()],
      cache: CACHE_OFF,
    };

    expect(options.cache).toEqual({ kind: 'off' });
  });
});

/** Kept out of the way of the behavioural tests above. */
export type _Unused = SubjectOutput;
