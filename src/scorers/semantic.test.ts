import { describe, expect, it } from 'vitest';
import { cosineSimilarity, semanticSimilarity } from './semantic.js';
import { evalCase, scoreArgs, subjectOutput } from '../testing.js';
import type { Embedder } from './semantic.js';
import type { LockedModel } from '../models-lock.js';

const LOCKED: LockedModel = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: 'test-revision',
  dtype: 'fp32',
};

/**
 * Deterministic stand-in for a sentence encoder.
 *
 * Every unit test here is about arithmetic — the zero-vector guard,
 * max-over-alternatives, projection — none of which needs a real model. A fake
 * keeps these tests offline and immune to a slow mirror. The real model is
 * exercised by the tagged integration test at the bottom.
 */
function fakeEmbedder(vectors: Record<string, readonly number[]>): Embedder {
  return {
    locked: () => Promise.resolve(LOCKED),
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const vector = vectors[text];
          if (vector === undefined) throw new Error(`fakeEmbedder: no vector for "${text}"`);
          return vector;
        }),
      ),
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical direction and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    /* 0/0. Guarded here rather than left for invokeScorer: relying on the
       caller to catch your own division by zero also turns "the response was
       empty" into "this scorer is broken". */
    const result = cosineSimilarity([0, 0, 0], [1, 2, 3]);

    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(0);
  });

  it('returns 0 when both vectors are zero', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('throws on a length mismatch, which is always a bug', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/lengths differ/);
  });
});

describe('semanticSimilarity', () => {
  const embedder = fakeEmbedder({
    'the customer wants their money back': [1, 0, 0],
    'the customer wants a refund': [0.98, 0.199, 0],
    'the customer has a billing question': [0.5, 0.866, 0],
    'the server is on fire': [0, 0, 1],
  });

  const caseSimilar = (similar: unknown) => evalCase({ id: 'sem-01', expect: { similar } });
  const said = (text: string) => subjectOutput({ text });

  it('reports the raw cosine similarity, unrescaled', async () => {
    const score = await semanticSimilarity({ embedder }).score(
      scoreArgs({
        case: caseSimilar('the customer wants a refund'),
        output: said('the customer wants their money back'),
      }),
    );

    /* The value IS the cosine. No floor, no ceiling, no invented band — the
       number is comparable to any published similarity figure. */
    expect(score.value).toBeCloseTo(0.98, 2);
  });

  it('scores unrelated text near 0 without clamping it there', async () => {
    const score = await semanticSimilarity({ embedder }).score(
      scoreArgs({
        case: caseSimilar('the server is on fire'),
        output: said('the customer wants their money back'),
      }),
    );

    expect(score.value).toBeCloseTo(0, 5);
    expect(score.passed).toBe(false);
  });

  it('takes the maximum across alternatives, not the mean', async () => {
    const score = await semanticSimilarity({ embedder }).score(
      scoreArgs({
        case: caseSimilar([
          'the server is on fire',
          'the customer wants a refund',
          'the customer has a billing question',
        ]),
        output: said('the customer wants their money back'),
      }),
    );

    /* Alternatives are a set of acceptable answers; matching one perfectly is
       a perfect answer. A mean would punish it for being unlike the answers it
       correctly did not give. */
    expect(score.value).toBeCloseTo(0.98, 2);
  });

  it('records the locked model on every score', async () => {
    const score = await semanticSimilarity({ embedder }).score(
      scoreArgs({
        case: caseSimilar('the customer wants a refund'),
        output: said('the customer wants their money back'),
      }),
    );

    /* A similarity is only comparable to another from the same encoder, so the
       number never travels without its model. */
    expect(score.meta?.['model']).toEqual(LOCKED);
  });

  it('throws rather than embedding serialised JSON when there is no text', async () => {
    /* The tempting fallback — stringify the payload and embed that — produces
       a similarity between a JSON document and an English sentence, reported
       in the same column and on the same scale as a real one. */
    await expect(
      semanticSimilarity({ embedder }).score(
        scoreArgs({
          case: caseSimilar('the customer wants a refund'),
          output: subjectOutput({ toolCalls: [{ name: 'record', input: { intent: 'refund' } }] }),
        }),
      ),
    ).rejects.toThrow(/Set `compare` to a path/);
  });

  it('embeds a projected field when `compare` names one', async () => {
    const projecting = semanticSimilarity({ embedder, compare: 'summary' });

    const score = await projecting.score(
      scoreArgs({
        case: caseSimilar('the customer wants a refund'),
        output: subjectOutput({
          toolCalls: [
            {
              name: 'record',
              input: { intent: 'refund', summary: 'the customer wants their money back' },
            },
          ],
        }),
      }),
    );

    expect(score.value).toBeCloseTo(0.98, 2);
    expect(score.meta?.['compare']).toBe('summary');
  });

  it('follows a dotted path into the payload', async () => {
    const score = await semanticSimilarity({ embedder, compare: 'fields.summary' }).score(
      scoreArgs({
        case: caseSimilar('the customer wants a refund'),
        output: subjectOutput({
          text: JSON.stringify({ fields: { summary: 'the customer wants their money back' } }),
        }),
      }),
    );

    expect(score.value).toBeCloseTo(0.98, 2);
  });

  it('throws when the compare path resolves to nothing', async () => {
    await expect(
      semanticSimilarity({ embedder, compare: 'fields.missing' }).score(
        scoreArgs({
          case: caseSimilar('the customer wants a refund'),
          output: subjectOutput({ text: '{"fields":{}}' }),
        }),
      ),
    ).rejects.toThrow(/resolved to nothing/);
  });

  it('scores 0 for whitespace-only output without embedding it', async () => {
    /* The fake throws on an unknown string, so reaching the embedder at all
       would fail this test — which is the assertion. */
    const score = await semanticSimilarity({ embedder }).score(
      scoreArgs({ case: caseSimilar('the customer wants a refund'), output: said('   \n  ') }),
    );

    expect(score.value).toBe(0);
    expect(Number.isNaN(score.value)).toBe(false);
  });

  it('throws on a case that declares no `similar`', async () => {
    await expect(
      semanticSimilarity({ embedder }).score(
        scoreArgs({ case: evalCase({ expect: {} }), output: said('anything') }),
      ),
    ).rejects.toThrow(/declares no `expect.similar`/);
  });

  it('throws on an empty expectation string, which would match everything', async () => {
    await expect(
      semanticSimilarity({ embedder }).score(
        scoreArgs({ case: caseSimilar(['   ']), output: said('anything') }),
      ),
    ).rejects.toThrow(/empty string/);
  });

  it('throws on a non-string expectation', async () => {
    await expect(
      semanticSimilarity({ embedder }).score(
        scoreArgs({ case: caseSimilar([42]), output: said('anything') }),
      ),
    ).rejects.toThrow(/invalid `expect.similar`/);
  });
});

/**
 * The only test that touches the real model. Downloads ~90 MB on first run and
 * writes models.lock.json, so it is excluded by default:
 *
 *     npm test                       # unit tests only
 *     RUN_MODEL_TESTS=1 npm test     # includes this
 */
describe.skipIf(process.env['RUN_MODEL_TESTS'] !== '1')('semanticSimilarity [integration]', () => {
  it('ranks a paraphrase above unrelated text using the real encoder', async () => {
    const scorer = semanticSimilarity();
    const output = subjectOutput({ text: 'The customer is asking for their money back.' });

    const close = await scorer.score(
      scoreArgs({ case: evalCase({ expect: { similar: 'The customer wants a refund.' } }), output }),
    );
    const far = await scorer.score(
      scoreArgs({
        case: evalCase({ expect: { similar: 'The build server ran out of disk space.' } }),
        output,
      }),
    );

    expect(close.value).toBeGreaterThan(far.value);
    expect(Number.isFinite(close.value)).toBe(true);
  }, 300_000);
});
