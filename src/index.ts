/**
 * The package's public surface.
 *
 * Everything re-exported here is API: it is what a consumer imports, what
 * semver applies to, and what cannot be changed without a reason. Anything not
 * listed is internal and may move.
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
  ScoreArgs,
  ExpectationClaim,
  Extraction,
  ExtractionRoute,
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

export {
  exactFields,
  matchesSchema,
  callsTool,
  trimStrings,
  lowercaseStrings,
} from './scorers/exact.js';
export type {
  ExactFieldsOptions,
  CallsToolOptions,
  NamedScorerOptions,
  FieldNormalizer,
} from './scorers/exact.js';

export { formatCompliance, FORMAT_EXPECTATIONS } from './scorers/format.js';
export type { FormatComplianceOptions, FormatExpectation } from './scorers/format.js';

export {
  semanticSimilarity,
  localEmbedder,
  cosineSimilarity,
  DEFAULT_EMBEDDING_MODEL,
} from './scorers/semantic.js';
export type {
  Embedder,
  EmbeddingModelConfig,
  LocalEmbedderOptions,
  SemanticSimilarityOptions,
} from './scorers/semantic.js';

export {
  llmJudge,
  anthropicJudge,
  median,
  parseVerdict,
  JudgeProtocolError,
  DEFAULT_JUDGE_MODEL,
} from './scorers/judge.js';
export type {
  JudgeClient,
  JudgeVerdict,
  JudgeResponse,
  LlmJudgeOptions,
  AnthropicJudgeOptions,
} from './scorers/judge.js';

export {
  calibrate,
  loadCalibrationCases,
  formatCalibrationReport,
} from './calibrate.js';
export type { CalibrationCase, CalibrationResult, CalibrationReport } from './calibrate.js';

export {
  ensureModelLock,
  huggingFaceRevision,
  ModelLockError,
  MODELS_LOCK_PATH,
} from './models-lock.js';
export type { ModelsLock, LockedModel, RevisionResolver } from './models-lock.js';

export {
  uncalibrated,
  uncalibratedConstants,
  formatUncalibratedReport,
  resetUncalibratedRegistry,
} from './uncalibrated.js';
export type { UncalibratedConstant } from './uncalibrated.js';

/* Fixture builders are API, not test scaffolding. See src/testing.ts. */
export { subjectOutput, evalCase, subjectContext, scoreArgs } from './testing.js';
