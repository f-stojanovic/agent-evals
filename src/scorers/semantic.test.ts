import { describe, expect, it } from 'vitest';
import {
  SemanticScorerUnavailableError,
  cosineSimilarity,
  loadTransformers,
  semanticSimilarity,
} from './semantic.js';
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

  it('never exceeds 1, even when floating point says otherwise', () => {
    /* A real 384-dimension normalised vector dotted with itself came back as
       1.0000000000000002, which invokeScorer rejects as out of range — so an
       identical pair errored the case and read as a broken scorer. */
    const v = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 19.6);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const unit = v.map((x) => x / norm);

    const self = cosineSimilarity(unit, unit);

    expect(self).toBeLessThanOrEqual(1);
    expect(self).toBeCloseTo(1, 10);
  });

  it('never drops below -1 either', () => {
    const v = Array.from({ length: 384 }, (_, i) => Math.cos(i));
    expect(cosineSimilarity(v, v.map((x) => -x))).toBeGreaterThanOrEqual(-1);
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

/**
 * The missing-peer path.
 *
 * `@huggingface/transformers` is an optional peer (ADR 025), so npm does not
 * install it into a consumer and this is a path real consumers WILL take. It
 * is tested through the injected importer rather than by uninstalling the
 * package, because uninstalling it would also disable the integration test
 * above and the calibration script, for a failure mode that is entirely about
 * how one rejected promise is wrapped.
 *
 * WHAT THAT DOES NOT COVER, stated rather than left for someone to discover:
 * the injected importer proves the wrapping, not the wiring. It does not prove
 * that the real `await import('@huggingface/transformers')` is the thing that
 * throws when the package is absent, because in this repo it never is absent.
 * That half is covered outside the unit tests, by installing the branch into a
 * scratch consumer with no transformers and calling `localEmbedder().embed()`
 * there — the measurement recorded in ADR 025's Evidence line.
 */
describe('loadTransformers, when the optional peer is absent', () => {
  const absent = (): Promise<never> =>
    Promise.reject(
      Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
    );

  /* `promise.catch(e => e)` widens to `Resolved | Error`, which does not have
     `.message`. Narrowing here keeps every assertion below readable and makes a
     promise that unexpectedly RESOLVES a test failure rather than a type error
     six lines later. */
  const rejection = async (promise: Promise<unknown>): Promise<Error> => {
    const outcome = await promise.then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    if (outcome === undefined) throw new Error('expected a rejection, got a resolved value');
    return outcome;
  };

  it('throws SemanticScorerUnavailableError rather than the raw import failure', async () => {
    await expect(loadTransformers(absent)).rejects.toBeInstanceOf(SemanticScorerUnavailableError);
  });

  /**
   * NO FIGURE IN THE STRING, DELIBERATELY.
   *
   * This message used to carry the calibration numbers — margin, pair count.
   * A number in a string literal is anchored to nothing: no test recomputes it,
   * no file feeds it, and it goes stale silently. That is the same defect as
   * the `fixtures.ts` docstring C6 now bans, one layer down. The claim stays
   * because it changes the reader's decision about installing 340MB; the
   * evidence moves to the ADR, which is where a figure lives.
   */
  it('cites the calibration finding without restating its figures', async () => {
    const error = await rejection(loadTransformers(absent));

    expect(error.message).toContain('never');
    expect(error.message).toContain('ADR 010');
    /* No figure of any kind: not the calibration margin, not the pair count,
       and not the install size, which was the same defect wearing a unit. Each
       is measured somewhere that something reads; none of them is anchored by
       sitting in a string. */
    expect(error.message).not.toMatch(/-?0\.\d{3}/);
    expect(error.message).not.toContain('eight of ten');
    expect(error.message).not.toMatch(/\d+\s*[MG]B/i);
    expect(error.message).toContain('ADR 025');
  });

  it('names the package, the install command, and the way out', async () => {
    const error = await rejection(loadTransformers(absent));

    /* Each of these is a thing the reader has to be able to do something with.
       A stack trace carries none of them. */
    expect(error.message).toContain('@huggingface/transformers');
    expect(error.message).toContain('npm i -D @huggingface/transformers');
    expect(error.message).toContain('OPTIONAL peer dependency');
    expect(error.message).toContain('semanticSimilarity');
  });

  it('keeps the original failure as `cause` rather than swallowing it', async () => {
    const error = await rejection(loadTransformers(absent));

    expect((error.cause as Error | undefined)?.message).toContain(
      "Cannot find package '@huggingface/transformers'",
    );
    /* And repeats it in the text, because `cause` is invisible in most logs. */
    expect(error.message).toContain("Cannot find package '@huggingface/transformers'");
  });

  it('does not fire when the peer loads', async () => {
    const present = (): Promise<{ pipeline: () => unknown }> =>
      Promise.resolve({ pipeline: () => ({}) });

    await expect(loadTransformers(present)).resolves.toHaveProperty('pipeline');
  });
});
