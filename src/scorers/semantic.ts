/**
 * Semantic similarity, scored against locally-run sentence embeddings.
 *
 * WHY THE MODEL RUNS LOCALLY
 * --------------------------
 * A suite that needs a third-party API key to pass CI fails for reasons that
 * have nothing to do with the thing under test: an expired key, a rate limit,
 * a provider incident, a fork without secrets. Every one of those is a red
 * build that is not a regression, and a gate that cries wolf gets disabled —
 * which costs you the gate entirely.
 *
 * Embeddings are also where a local model is genuinely good enough: a
 * 22M-parameter sentence encoder runs in milliseconds on CPU. The judge needs
 * an API; this does not, and paying for it anyway would spend both money and
 * reliability for nothing.
 */

import { ensureModelLock } from '../models-lock.js';
import type { LockedModel } from '../models-lock.js';
import type {
  EvalCase,
  Score,
  ScoreArgs,
  Scorer,
  UncalibratedConstant,
} from '../types.js';

/** Raw cosine at or above which a response counts as matching. Not measured —
 *  see the `uncalibrated` entry this is reported under. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

/* ------------------------------------------------------------------ *
 * The embedder
 * ------------------------------------------------------------------ */

export type EmbeddingModelConfig = {
  /** Hugging Face repo id. */
  readonly modelId: string;
  /** Quantisation. Changes the numbers, so it is part of the model's identity
   *  and is recorded in the lockfile alongside the revision. */
  readonly dtype: 'fp32' | 'fp16' | 'q8' | 'q4';
};

/**
 * Small, English, widely used, cheap on CPU.
 *
 * No revision is hardcoded here on purpose. Inventing a commit hash would
 * claim a pin the code never verified; instead the first run resolves the
 * real one and writes `models.lock.json`, and every later run is checked
 * against it. See src/models-lock.ts.
 */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelConfig = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  dtype: 'fp32',
};

/**
 * The seam that keeps a model download out of the unit tests.
 *
 * Everything interesting about this scorer — the zero-vector guard,
 * max-over-alternatives, projection — is arithmetic, and none of it needs a
 * real encoder to test. Injecting the embedder makes those tests
 * deterministic, fast, and immune to a slow mirror.
 */
export interface Embedder {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  /** The lockfile entry this embedder is running under, recorded on every
   *  score so a number is never separated from the model that produced it. */
  locked(): Promise<LockedModel>;
}

export type LocalEmbedderOptions = {
  readonly config?: EmbeddingModelConfig;
  readonly lockPath?: string;
};

/**
 * Lazily loads a transformers.js feature-extraction pipeline and caches it.
 *
 * Loaded once per embedder instance, not once per case: model initialisation
 * dominates the cost of embedding by orders of magnitude.
 */
export function localEmbedder(options: LocalEmbedderOptions = {}): Embedder {
  const config = options.config ?? DEFAULT_EMBEDDING_MODEL;

  /* Held as promises rather than resolved values so concurrent cases racing to
     be first all await the same load instead of starting several. */
  let lockPromise: Promise<LockedModel> | undefined;
  let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  const locked = (): Promise<LockedModel> => {
    lockPromise ??= ensureModelLock({
      slot: 'embedding',
      modelId: config.modelId,
      dtype: config.dtype,
      ...(options.lockPath !== undefined && { lockPath: options.lockPath }),
    });
    return lockPromise;
  };

  const load = async (): Promise<FeatureExtractionPipeline> => {
    /* The lock is checked before the model is fetched, so a mismatch fails
       fast instead of after a download. */
    const entry = await locked();
    if (pipelinePromise === undefined) {
      const { pipeline } = await loadTransformers();
      pipelinePromise = pipeline('feature-extraction', config.modelId, {
        dtype: config.dtype,
        ...(entry.revision !== null && { revision: entry.revision }),
      }) as unknown as Promise<FeatureExtractionPipeline>;
    }
    return pipelinePromise;
  };

  return {
    locked,
    async embed(texts) {
      const extractor = await load();
      /* Mean pooling and L2 normalisation are what all-MiniLM was trained
         with; `normalize` also makes cosine similarity a plain dot product. */
      const result = await extractor(texts as string[], { pooling: 'mean', normalize: true });
      return result.tolist();
    },
  };
}

/** The shape `loadTransformers` needs back. Declared locally so the import can
 *  stay dynamic and no type-level dependency on the peer is created either. */
export type TransformersModule = {
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options: { dtype: string; revision?: string },
  ) => unknown;
};

/** Injected only by the tests. Real callers get the dynamic import. */
export type TransformersImporter = () => Promise<TransformersModule>;

/**
 * The peer is missing, and this says so in a sentence somebody can act on.
 *
 * WHY THIS CLASS EXISTS RATHER THAN LETTING THE IMPORT THROW
 * ----------------------------------------------------------
 * `@huggingface/transformers` is an OPTIONAL peer dependency (ADR 025): it is
 * 340MB of ONNX runtime that only `semanticSimilarity` needs, npm does not
 * install optional peers, and a consumer using the five deterministic scorers
 * should never pay for it.
 *
 * The cost of that is a new way to fail, and it is the same SHAPE of failure
 * this package spent ADR 023 fixing: an install that reports success, and a
 * first symptom that appears somewhere else entirely. There the symptom was
 * `ERR_MODULE_NOT_FOUND` on `dist/index.js`, which reads as a broken build;
 * here it would be `ERR_MODULE_NOT_FOUND` on a package the consumer never
 * asked for and never listed, which reads as a broken dependency tree.
 *
 * So the message is the mitigation, and it has to carry three things a stack
 * trace does not: that the package is deliberately optional, which scorer
 * wanted it, and the exact command that fixes it.
 */
export class SemanticScorerUnavailableError extends Error {
  override readonly name = 'SemanticScorerUnavailableError';
  constructor(cause: unknown) {
    super(
      `The semantic scorer needs "@huggingface/transformers", which is not installed.\n\n` +
        `It is an OPTIONAL peer dependency of agent-evals, so npm does not install it ` +
        `for you. That is deliberate: it pulls in several hundred megabytes of ONNX ` +
        `runtime — the measured figures are in ADR 025 — and the other five scorers ` +
        `— exactFields, matchesSchema, callsTool, formatCompliance and llmJudge — do ` +
        `not need any of it.\n\n` +
        `If you want semanticSimilarity, install it in YOUR project:\n\n` +
        `    npm i -D @huggingface/transformers\n\n` +
        `If you do not, drop semanticSimilarity from the scorer list you pass to ` +
        `runSuite. Nothing else in agent-evals imports this package.\n\n` +
        `"Do not" is a reasonable answer: this scorer's threshold was never ` +
        `adopted here, because calibration against the labelled pairs did not ` +
        `separate matching from non-matching ones. The figures are in ADR 010 ` +
        `and the pairs are in evals/calibration-semantic/; re-run it with ` +
        `npm run calibrate:semantic.\n\n` +
        `The underlying import failed with: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Loads the peer, or throws something worth reading.
 *
 * Not exported from `src/index.ts`: it is internal, and the importer parameter
 * exists so the missing-peer path can be tested without uninstalling a package
 * the rest of the suite needs.
 */
export async function loadTransformers(
  importer?: TransformersImporter,
): Promise<TransformersModule> {
  try {
    /* Lazy so that merely importing this module — which `src/index.ts` does on
       every consumer's first import — does not pull in the ONNX runtime. */
    return importer === undefined
      ? ((await import('@huggingface/transformers')) as unknown as TransformersModule)
      : await importer();
  } catch (cause) {
    throw new SemanticScorerUnavailableError(cause);
  }
}

/** The slice of transformers.js this module uses, declared locally so the
 *  import can stay dynamic. */
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/* ------------------------------------------------------------------ *
 * The scorer
 * ------------------------------------------------------------------ */

export type SemanticSimilarityOptions = {
  readonly name?: string;
  /** Defaults to {@link localEmbedder}. */
  readonly embedder?: Embedder;
  /**
   * What to embed from the subject's output.
   *
   * `'text'` (the default) embeds the response text. Anything else is a dotted
   * path into the extracted payload — `'fields.summary'` embeds that one
   * field. Projection exists because embedding a whole JSON document and
   * calling the result a similarity is measuring the wrong thing: the encoder
   * spends its capacity on braces, quotes, and key names that are identical in
   * every response, which compresses the range and makes two genuinely
   * different answers look alike.
   */
  readonly compare?: string;
  /** `passed` cutoff on the raw cosine similarity. */
  readonly threshold?: number;
};

/**
 * Scores the subject's text against `expect.similar` — a string, or a list of
 * strings, any one of which would be an acceptable answer.
 *
 * The score is the MAXIMUM similarity across the expectations, not the mean:
 * the list is a set of alternatives ("refund" or "money back" or "return the
 * payment"), and matching any one of them perfectly is a perfect answer.
 * Averaging would punish a correct response for being unlike the alternatives
 * it correctly did not give.
 *
 * THE VALUE IS RAW COSINE SIMILARITY, NOT A RESCALED SCORE
 * --------------------------------------------------------
 * An earlier version mapped [0.3, 0.95] onto [0, 1] to make the number "read
 * better", on the argument that unrelated English sentences cluster around 0.3
 * and paraphrases around 0.95. That argument is true and the fix was still
 * wrong: the floor and the ceiling were both invented, they were stacked on
 * top of an invented threshold, and the product was a number that looked
 * calibrated while encoding three guesses. Worse, it was not comparable to any
 * published similarity figure, so nobody could sanity-check it against
 * anything.
 *
 * Raw cosine is harder to read and honest about what it is. If the range is
 * inconvenient — and it is — the answer is to calibrate a threshold against
 * labelled data, the way `src/calibrate.ts` does for the judge, not to squash
 * the axis until the numbers look friendly.
 */
export function semanticSimilarity(options: SemanticSimilarityOptions = {}): Scorer {
  const name = options.name ?? 'semantic-similarity';
  const embedder = options.embedder ?? localEmbedder();
  const compare = options.compare ?? 'text';
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  /* Declared only when it was not supplied: a threshold the caller chose is
     the caller's business, and reporting it as this scorer's guess would be
     wrong. */
  const uncalibrated: UncalibratedConstant[] =
    options.threshold === undefined
      ? [
          {
            id: `${name}.threshold`,
            value: DEFAULT_SIMILARITY_THRESHOLD,
            note:
              'raw cosine above which a response counts as matching. A guess: the ' +
              'right cutoff depends on the encoder and the domain. Calibrate it ' +
              'against labelled pairs the way src/calibrate.ts calibrates the judge.',
          },
        ]
      : [];

  return {
    name,
    claims: [{ key: 'similar', required: true }],
    /* Only when projecting: with the default `compare: 'text'` this reads
       output.text and a failed extraction is irrelevant to it. */
    consumesExtraction: compare !== 'text',
    uncalibrated,
    async score({ case: evalCase, output, extraction }: ScoreArgs): Promise<Score> {
      const expectations = readSimilarExpectation(name, evalCase);
      const actual = selectText({ scorerName: name, compare, output, extraction, evalCase });

      if (actual.trim() === '') {
        /* An empty string cannot be embedded meaningfully — the vector is
           degenerate and every similarity against it is noise. Scored rather
           than thrown: an empty response is a model failure and belongs in the
           baseline. */
        return {
          scorer: name,
          value: 0,
          passed: false,
          reason: `nothing to compare: \`${compare}\` was empty`,
          meta: { compare, model: await embedder.locked() },
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
          similarity: vector === undefined ? 0 : cosineSimilarity(actualVector, vector),
        };
      });

      /* `reduce` rather than `Math.max(...)`: the expectation list is
         author-controlled and spreading a large one risks a stack overflow. */
      const best = similarities.reduce((a, b) => (b.similarity > a.similarity ? b : a));

      return {
        scorer: name,
        value: best.similarity,
        passed: best.similarity >= threshold,
        reason:
          `cosine similarity ${best.similarity.toFixed(3)} against the closest of ` +
          `${expectations.length} expectation${expectations.length === 1 ? '' : 's'}: ` +
          `"${truncate(best.expectation)}"`,
        meta: { compare, model: await embedder.locked(), threshold, similarities },
      };
    },
  };
}

/**
 * Chooses the text to embed.
 *
 * THROWS rather than falling back when `compare` is `'text'` and there is no
 * text. The tempting fallback is to `JSON.stringify` the extracted payload and
 * embed that — and it is exactly the failure this repo exists to prevent. The
 * resulting number is a similarity between a JSON document and an English
 * sentence, dominated by punctuation and key names, and it is reported in the
 * same column, on the same scale, as a real one. It would look correct and
 * mean nothing.
 *
 * A tool-calling subject is a legitimate thing to score semantically — with
 * `compare: 'fields.summary'`, which names the field to embed. That is a
 * decision for the author, not a default for the harness.
 */
function selectText(args: {
  scorerName: string;
  compare: string;
  output: ScoreArgs['output'];
  extraction: ScoreArgs['extraction'];
  evalCase: EvalCase;
}): string {
  const { scorerName, compare, output, extraction, evalCase } = args;

  if (compare === 'text') {
    if (output.text !== undefined) return output.text;
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" produced no text, and \`compare\` ` +
        `is "text". Set \`compare\` to a path into the extracted payload (for example ` +
        `"fields.summary") to name the field to embed. Embedding the serialised JSON ` +
        `instead would report a similarity between a document and a sentence on the ` +
        `same scale as a real one.`,
    );
  }

  if (extraction.via === 'unreadable' || extraction.via === 'ambiguous') {
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" declares \`compare: "${compare}"\`, ` +
        `but no structured payload could be read (${extraction.error})`,
    );
  }

  const value = readPath(extraction.data, compare);
  if (typeof value === 'string') return value;
  throw new Error(
    `Scorer "${scorerName}": case "${evalCase.id}" has \`compare: "${compare}"\`, which ` +
      `resolved to ${value === undefined ? 'nothing' : typeof value}; expected a string`,
  );
}

function readPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (typeof value !== 'object' || value === null) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, data);
}

/**
 * Cosine similarity, with the zero-vector case handled here rather than left
 * to the caller.
 *
 * A vector of all zeros has norm 0, so the similarity is 0/0 — NaN. It happens
 * for real: an encoder handed a whitespace-only string, a truncation that
 * leaves nothing, a tokeniser that drops every token as a special. A scorer
 * that relies on its caller to catch its own division by zero is not finished,
 * and `invokeScorer` rejecting the NaN downstream would report "this scorer is
 * broken" rather than "this response was empty".
 *
 * Returning 0 is correct rather than merely safe: a zero vector shares no
 * direction with anything.
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

  /* CLAMPED. Cosine is defined on [-1, 1], and floating-point summation of an
     already-normalised 384-dimension dot product routinely lands an ulp or two
     outside it — identical inputs give 1.0000000000000002. `invokeScorer`
     rejects any score outside 0..1, so without this an identical pair errors
     the whole case with "value must be within 0..1", which reads as a broken
     scorer rather than a rounding artefact. It was found exactly that way. */
  return Math.min(1, Math.max(-1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
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
