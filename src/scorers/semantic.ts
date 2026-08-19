/**
 * Semantic similarity, scored against locally-run sentence embeddings.
 *
 * WHY THE MODEL RUNS LOCALLY
 * --------------------------
 * A suite that needs a third-party API key to pass CI fails for reasons that
 * have nothing to do with the thing under test: an expired key, a rate limit,
 * a provider incident, a fork without secrets. Every one of those shows up as
 * a red build that is not a regression, and a gate that cries wolf gets
 * disabled — which costs you the gate entirely.
 *
 * Embeddings are also the part of the pipeline where a local model is
 * genuinely good enough. A 22M-parameter sentence encoder runs in
 * milliseconds on CPU, needs no key, and after the first download needs no
 * network. The judge scorer will need an API; this does not, and paying for it
 * anyway would be spending both money and reliability for nothing.
 */

import { extractStructured } from './extract.js';
import type { EvalCase, Score, Scorer, SubjectOutput } from '../types.js';

/* ------------------------------------------------------------------ *
 * The embedding model is part of the baseline contract
 * ------------------------------------------------------------------ */

/**
 * Exactly which model produced a number.
 *
 * A cosine similarity is only comparable to another cosine similarity from the
 * same encoder. Swap the model, the revision, or even the quantisation, and
 * every score in the suite shifts — uniformly, silently, and in a way that
 * looks exactly like the model under test getting worse. That is the single
 * most expensive kind of false positive an eval harness can produce: a whole
 * afternoon spent bisecting prompt changes to explain a regression caused by
 * `npm update`.
 *
 * So the identity is pinned in code, exposed here for the runner to record in
 * the run metadata, and never floats.
 *
 * TODO(baseline): the baseline file must carry this descriptor, and the gate
 * must refuse to compare a run against a baseline recorded with a different
 * one — reporting "baseline recorded with X, this run used Y; re-record or
 * pin" rather than a regression. Until that exists, changing any field here
 * silently invalidates every recorded semantic score.
 */
export type EmbeddingModelDescriptor = {
  /** Hugging Face repo id. */
  readonly model: string;
  /** Git revision within that repo. Never `main`: a branch is a moving target,
   *  and the whole point is that this cannot move under us. */
  readonly revision: string;
  /** Quantisation. Changes the numbers, so it is part of the identity. */
  readonly dtype: 'fp32' | 'fp16' | 'q8' | 'q4';
};

/**
 * Small, English, widely used, and cheap on CPU. `revision` is the commit that
 * was current when this was written, pinned deliberately rather than tracking
 * `main`.
 */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelDescriptor = {
  model: 'Xenova/all-MiniLM-L6-v2',
  revision: 'e4ce9877abf3edfe10b0d82785e83bdcb973e22e',
  dtype: 'fp32',
};

/**
 * The seam that keeps a 90 MB model download out of the unit tests.
 *
 * Everything interesting about this scorer — rescaling, the zero-vector guard,
 * max-over-expectations, extraction handling — is arithmetic on vectors, and
 * none of it needs a real encoder to test. Injecting the embedder means those
 * tests are deterministic, run in milliseconds, and cannot fail because a
 * mirror was slow. The one test that does exercise the real model is tagged so
 * CI can exclude it.
 */
export interface Embedder {
  /** Must return unit-comparable vectors of consistent length. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  /** Recorded alongside the scores. See {@link EmbeddingModelDescriptor}. */
  readonly descriptor: EmbeddingModelDescriptor;
}

/**
 * Lazily loads a transformers.js feature-extraction pipeline and caches it.
 *
 * The pipeline is created once per embedder instance, not once per case: model
 * initialisation dominates the cost of embedding by orders of magnitude, and
 * reloading it per case would make a 200-case suite unusable.
 */
export function localEmbedder(
  descriptor: EmbeddingModelDescriptor = DEFAULT_EMBEDDING_MODEL,
): Embedder {
  /* Held as a promise rather than a resolved value so that concurrent cases
     racing to be first all await the same load instead of starting several. */
  let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  const load = async (): Promise<FeatureExtractionPipeline> => {
    if (pipelinePromise === undefined) {
      /* Imported lazily so that merely importing this module does not pull in
         the ONNX runtime — which matters for anyone using the deterministic
         scorers and nothing else. */
      const { pipeline } = await import('@huggingface/transformers');
      pipelinePromise = pipeline('feature-extraction', descriptor.model, {
        revision: descriptor.revision,
        dtype: descriptor.dtype,
      }) as unknown as Promise<FeatureExtractionPipeline>;
    }
    return pipelinePromise;
  };

  return {
    descriptor,
    async embed(texts) {
      const extractor = await load();
      /* Mean pooling and L2 normalisation are what all-MiniLM was trained
         with; `normalize` also makes cosine similarity a plain dot product. */
      const result = await extractor(texts as string[], { pooling: 'mean', normalize: true });
      return result.tolist();
    },
  };
}

/** The slice of transformers.js this module uses, declared locally so the
 *  import above can stay dynamic and type-only elsewhere. */
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/* ------------------------------------------------------------------ *
 * The scorer
 * ------------------------------------------------------------------ */

export type SemanticSimilarityOptions = {
  readonly name?: string;
  /** Defaults to {@link localEmbedder} with {@link DEFAULT_EMBEDDING_MODEL}. */
  readonly embedder?: Embedder;
  /**
   * Raw cosine below this rescales to 0. See {@link rescale}.
   */
  readonly floor?: number;
  /** Raw cosine at or above this rescales to 1. */
  readonly ceiling?: number;
  /** `passed` cutoff, applied to the rescaled value. */
  readonly threshold?: number;
};

/**
 * Raw cosine similarity is a bad 0..1 score, and using it as one is the most
 * common mistake in embedding-based evals.
 *
 * Sentence encoders do not spread their output over [0, 1]. Two unrelated
 * English sentences typically land around 0.2–0.35 simply for being English
 * sentences; near-paraphrases land around 0.9–0.95; genuine 1.0 essentially
 * never happens. So a raw score of 0.3 reads as "30% right" when it means
 * "nothing in common", and the usable signal is squeezed into the top third of
 * the range where a threshold has to be set to three decimal places.
 *
 * Rescaling linearly from [floor, ceiling] to [0, 1] and clamping fixes the
 * readability problem, at the cost of two numbers that are assumptions rather
 * than facts.
 *
 * THESE DEFAULTS ARE A STARTING POINT, NOT A TRUTH. They are reasonable for
 * all-MiniLM-L6-v2 on short English text and wrong for anything else — a
 * different encoder, a different language, or long documents all move the
 * distribution. Calibrate them against your own data: embed a set of pairs you
 * consider clearly unrelated and a set you consider clearly equivalent, and
 * put the floor and ceiling where those two distributions actually sit. Until
 * you do, treat the absolute numbers as arbitrary and only the direction of
 * change as meaningful.
 */
export const DEFAULT_SIMILARITY_FLOOR = 0.3;
export const DEFAULT_SIMILARITY_CEILING = 0.95;

/**
 * Scores the subject's text against `expect.similar` — a string, or a list of
 * strings, any one of which would be an acceptable answer.
 *
 * The score is the MAXIMUM similarity across the expectations, not the mean:
 * the list is a set of alternatives ("refund" or "money back" or "return the
 * payment"), and matching any one of them perfectly is a perfect answer.
 * Averaging would punish a correct response for being unlike the alternatives
 * it correctly did not give.
 */
export function semanticSimilarity(options: SemanticSimilarityOptions = {}): Scorer {
  const name = options.name ?? 'semantic-similarity';
  const embedder = options.embedder ?? localEmbedder();
  const floor = options.floor ?? DEFAULT_SIMILARITY_FLOOR;
  const ceiling = options.ceiling ?? DEFAULT_SIMILARITY_CEILING;
  const threshold = options.threshold ?? 0.8;

  if (!(ceiling > floor)) {
    throw new Error(
      `Scorer "${name}": ceiling (${ceiling}) must be greater than floor (${floor})`,
    );
  }

  return {
    name,
    claims: [{ key: 'similar', required: true }],
    async score({ case: evalCase, output }: { case: EvalCase; output: SubjectOutput }): Promise<Score> {
      const expectations = readSimilarExpectation(name, evalCase);
      const actual = subjectText(output);

      if (actual === undefined || actual.trim() === '') {
        /* A response with no text cannot be embedded — the vector would be
           degenerate and the similarity meaningless. Scored, not thrown: an
           empty response is a model failure and belongs in the baseline. */
        return {
          scorer: name,
          value: 0,
          passed: false,
          reason: 'the subject produced no text to compare',
          meta: { model: embedder.descriptor },
        };
      }

      const vectors = await embedder.embed([actual, ...expectations]);
      const actualVector = vectors[0];
      if (actualVector === undefined) {
        throw new Error(`Scorer "${name}": the embedder returned no vectors`);
      }

      const similarities = expectations.map((expectation, index) => {
        const vector = vectors[index + 1];
        return {
          expectation,
          raw: vector === undefined ? 0 : cosineSimilarity(actualVector, vector),
        };
      });

      /* `reduce` rather than `Math.max(...)`: an expectation list is
         author-controlled and spreading a large one would risk a stack
         overflow for no benefit. */
      const best = similarities.reduce((a, b) => (b.raw > a.raw ? b : a));
      const value = rescale(best.raw, floor, ceiling);

      return {
        scorer: name,
        value,
        passed: value >= threshold,
        reason:
          `closest expectation scored ${best.raw.toFixed(3)} raw cosine ` +
          `(rescaled ${value.toFixed(3)} from floor ${floor}/ceiling ${ceiling}): ` +
          `"${truncate(best.expectation)}"`,
        meta: {
          model: embedder.descriptor,
          floor,
          ceiling,
          rawMax: best.raw,
          similarities: similarities.map((s) => ({ expectation: s.expectation, raw: s.raw })),
        },
      };
    },
  };
}

/**
 * Cosine similarity, with the zero-vector case handled here rather than left
 * to the caller.
 *
 * A vector of all zeros has norm 0, so the similarity is 0/0 — NaN. It happens
 * for real: an encoder handed an empty or whitespace-only string, a truncation
 * that leaves nothing, a tokeniser that drops every token as a special. The
 * text guard above catches the common path, but a scorer that relies on its
 * caller to catch its own division by zero is not finished — and `invokeScorer`
 * rejecting the NaN downstream would report "this scorer is broken" rather
 * than "this response was empty", which is a materially worse error to debug.
 *
 * Returning 0 is correct rather than merely safe: a zero vector shares no
 * direction with anything, so "no similarity" is the honest answer.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector lengths differ (${a.length} vs ${b.length})`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Linear map from [floor, ceiling] onto [0, 1], clamped at both ends. */
export function rescale(raw: number, floor: number, ceiling: number): number {
  const scaled = (raw - floor) / (ceiling - floor);
  return Math.min(1, Math.max(0, scaled));
}

/** Where the text to compare comes from: the response text if there is one,
 *  otherwise the extracted payload rendered back to JSON — so a subject that
 *  answers through a tool call is still comparable. */
function subjectText(output: SubjectOutput): string | undefined {
  if (output.text !== undefined && output.text.trim() !== '') return output.text;

  const extraction = extractStructured(output);
  if ('error' in extraction) return undefined;
  return typeof extraction.data === 'string' ? extraction.data : JSON.stringify(extraction.data);
}

function readSimilarExpectation(scorerName: string, evalCase: EvalCase): string[] {
  if (!('similar' in evalCase.expect)) {
    throw new Error(
      `Scorer "${scorerName}" ran against case "${evalCase.id}", which declares no ` +
        `\`expect.similar\`. A scorer must only be invoked for cases that declare its ` +
        `required claimed keys.`,
    );
  }

  const raw = evalCase.expect['similar'];
  const list = typeof raw === 'string' ? [raw] : raw;

  if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === 'string')) {
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" has an invalid \`expect.similar\`; ` +
        `expected a non-empty string or list of strings`,
    );
  }
  if (list.some((s) => s.trim() === '')) {
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" has an empty string in ` +
        `\`expect.similar\`; an empty expectation embeds to a degenerate vector and ` +
        `would score everything the same`,
    );
  }
  return list;
}

function truncate(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}
