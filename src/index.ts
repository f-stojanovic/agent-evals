/**
 * The package's public surface.
 *
 * Everything re-exported here is API: it is what a consumer imports, what
 * semver applies to, and what cannot be changed without a reason. Anything not
 * listed is internal and may move — `src/errors.ts` exposes
 * {@link ProblemListError} only because the two error classes below extend it
 * and a caller may want to catch either.
 */

export type {
  Usage,
  ToolCall,
  SubjectOutput,
  SubjectContext,
  Subject,
  EvalCase,
  Score,
  Scorer,
  ExpectationClaim,
  CostBreakdown,
  LatencyAggregate,
  SuiteTotals,
  CaseResult,
  SuiteResult,
} from './types.js';
export { DEFAULT_CASE_WEIGHT } from './types.js';

export { ProblemListError } from './errors.js';

export { loadCases, CaseLoadError, evalCaseSchema } from './cases.js';

export { validateExpectations, applicableScorers, ExpectationError } from './scorers/registry.js';
export type { Applicability } from './scorers/registry.js';

export { invokeScorer, InvalidScoreError } from './scorers/invoke.js';

export { extractStructured } from './scorers/extract.js';
export type { Extraction, ExtractionRoute } from './scorers/extract.js';

export { exactFields, matchesSchema, callsTool, trimStrings, lowercaseStrings } from './scorers/exact.js';
export type {
  ExactFieldsOptions,
  CallsToolOptions,
  NamedScorerOptions,
  FieldNormalizer,
} from './scorers/exact.js';

export { formatCompliance } from './scorers/format.js';
export type { FormatComplianceOptions } from './scorers/format.js';

export {
  semanticSimilarity,
  localEmbedder,
  cosineSimilarity,
  rescale,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_SIMILARITY_FLOOR,
  DEFAULT_SIMILARITY_CEILING,
} from './scorers/semantic.js';
export type {
  Embedder,
  EmbeddingModelDescriptor,
  SemanticSimilarityOptions,
} from './scorers/semantic.js';

/* Fixture builders are API, not test scaffolding. See src/testing.ts. */
export { subjectOutput, evalCase, subjectContext } from './testing.js';
