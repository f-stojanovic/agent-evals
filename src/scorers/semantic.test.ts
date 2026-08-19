import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  cosineSimilarity,
  localEmbedder,
  rescale,
  semanticSimilarity,
} from './semantic.js';
import { evalCase, subjectOutput } from '../testing.js';
import type { Embedder } from './semantic.js';

/**
 * Deterministic stand-in for a sentence encoder.
 *
 * Every unit test here is about arithmetic — rescaling, the zero-vector guard,
 * max-over-alternatives — none of which needs a real model. A fake keeps these
 * tests offline, in milliseconds, and immune to a slow mirror. The real model
 * is exercised by the tagged integration test at the bottom.
 */
function fakeEmbedder(vectors: Record<string, readonly number[]>): Embedder {
  return {
    descriptor: DEFAULT_EMBEDDING_MODEL,
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

describe('rescale', () => {
  it('maps the floor to 0 and the ceiling to 1', () => {
    expect(rescale(0.3, 0.3, 0.95)).toBe(0);
    expect(rescale(0.95, 0.3, 0.95)).toBe(1);
  });

  it('clamps outside the band', () => {
    expect(rescale(0.1, 0.3, 0.95)).toBe(0);
    expect(rescale(0.99, 0.3, 0.95)).toBe(1);
  });

  it('spreads the middle of the band linearly', () => {
    expect(rescale(0.625, 0.3, 0.95)).toBeCloseTo(0.5);
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

  it('scores a near-paraphrase near 1', async () => {
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar('the customer wants a refund'),
      output: subjectOutput({ text: 'the customer wants their money back' }),
    });

    expect(score.value).toBeGreaterThan(0.9);
    expect(score.passed).toBe(true);
  });

  it('scores unrelated text at 0 after rescaling', async () => {
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar('the server is on fire'),
      output: subjectOutput({ text: 'the customer wants their money back' }),
    });

    /* Raw cosine 0 is already below the 0.3 floor, so it clamps. */
    expect(score.value).toBe(0);
  });

  it('takes the maximum across alternatives, not the mean', async () => {
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar([
        'the server is on fire',
        'the customer wants a refund',
        'the customer has a billing question',
      ]),
      output: subjectOutput({ text: 'the customer wants their money back' }),
    });

    /* The alternatives are a set of acceptable answers; matching one of them
       perfectly is a perfect answer. Averaging would punish it for being
       unlike the answers it correctly did not give. */
    expect(score.value).toBeGreaterThan(0.9);
    expect(score.meta?.['rawMax']).toBeCloseTo(0.98);
  });

  it('accepts a bare string as a single expectation', async () => {
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar('the customer wants a refund'),
      output: subjectOutput({ text: 'the customer wants their money back' }),
    });

    expect(Array.isArray(score.meta?.['similarities'])).toBe(true);
    expect((score.meta?.['similarities'] as unknown[]).length).toBe(1);
  });

  it('records the embedding model descriptor on every score', async () => {
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar('the customer wants a refund'),
      output: subjectOutput({ text: 'the customer wants their money back' }),
    });

    /* The number is only comparable to another from the same encoder, so the
       identity travels with it. */
    expect(score.meta?.['model']).toEqual(DEFAULT_EMBEDDING_MODEL);
  });

  it('scores 0 with a reason when the subject produced no text', async () => {
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar('the customer wants a refund'),
      output: subjectOutput({}),
    });

    expect(score.value).toBe(0);
    expect(Number.isNaN(score.value)).toBe(false);
    expect(score.reason).toContain('no text');
  });

  it('scores 0 for whitespace-only output without embedding it', async () => {
    /* The fake would throw on an unknown string, so reaching the embedder at
       all would fail this test — which is the assertion. */
    const score = await semanticSimilarity({ embedder }).score({
      case: caseSimilar('the customer wants a refund'),
      output: subjectOutput({ text: '   \n  ' }),
    });

    expect(score.value).toBe(0);
  });

  it('honours a calibrated floor and ceiling', async () => {
    const score = await semanticSimilarity({ embedder, floor: 0, ceiling: 1 }).score({
      case: caseSimilar('the customer has a billing question'),
      output: subjectOutput({ text: 'the customer wants their money back' }),
    });

    /* Raw 0.5, unrescaled by a 0..1 band. The defaults are a starting point,
       not a truth — this is what calibrating them looks like. */
    expect(score.value).toBeCloseTo(0.5);
  });

  it('rejects a ceiling that is not above the floor', () => {
    expect(() => semanticSimilarity({ embedder, floor: 0.9, ceiling: 0.9 })).toThrow(
      /must be greater than floor/,
    );
  });

  it('throws on a case that declares no `similar`', async () => {
    await expect(
      semanticSimilarity({ embedder }).score({
        case: evalCase({ expect: {} }),
        output: subjectOutput({ text: 'anything' }),
      }),
    ).rejects.toThrow(/declares no `expect.similar`/);
  });

  it('throws on an empty expectation string, which would match everything', async () => {
    await expect(
      semanticSimilarity({ embedder }).score({
        case: caseSimilar(['   ']),
        output: subjectOutput({ text: 'anything' }),
      }),
    ).rejects.toThrow(/empty string/);
  });

  it('throws on a non-string expectation', async () => {
    await expect(
      semanticSimilarity({ embedder }).score({
        case: caseSimilar([42]),
        output: subjectOutput({ text: 'anything' }),
      }),
    ).rejects.toThrow(/invalid `expect.similar`/);
  });

  it('pins the embedding model to an immutable revision', () => {
    /* A floating ref would let `npm update` shift every score in the suite at
       once, which is indistinguishable from a quality regression. */
    expect(DEFAULT_EMBEDDING_MODEL.revision).not.toBe('main');
    expect(DEFAULT_EMBEDDING_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(localEmbedder().descriptor).toEqual(DEFAULT_EMBEDDING_MODEL);
  });
});

/**
 * The only test that touches the real model. Downloads ~90 MB on first run,
 * so it is excluded by default:
 *
 *     npm test                       # unit tests only
 *     RUN_MODEL_TESTS=1 npm test     # includes this
 */
describe.skipIf(process.env['RUN_MODEL_TESTS'] !== '1')('semanticSimilarity [integration]', () => {
  it('ranks a paraphrase above unrelated text using the real encoder', async () => {
    const scorer = semanticSimilarity();
    const output = subjectOutput({ text: 'The customer is asking for their money back.' });

    const close = await scorer.score({
      case: evalCase({ expect: { similar: 'The customer wants a refund.' } }),
      output,
    });
    const far = await scorer.score({
      case: evalCase({ expect: { similar: 'The build server ran out of disk space.' } }),
      output,
    });

    expect(close.value).toBeGreaterThan(far.value);
    expect(Number.isFinite(close.value)).toBe(true);
  }, 120_000);
});
