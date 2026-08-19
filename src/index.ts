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
  UncalibratedConstant,
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

export { collectUncalibrated, formatUncalibratedReport } from './uncalibrated.js';

export { runSuite, mapWithConcurrency, isRetryable, backoffMs, CACHE_OFF } from './runner.js';
export type { RunOptions, RunSummary, CacheMode } from './runner.js';

export {
  readBaseline,
  writeBaseline,
  baselineFrom,
  compareToBaseline,
  describeBaselineChange,
  standardError,
  BASELINE_PATH,
  DEFAULT_Z,
  DEFAULT_FLOOR,
} from './baseline.js';
export type { Baseline, BaselineCase, BaselineComparison, CaseComparison } from './baseline.js';

export { formatReport, writeArtifact, exitCode } from './report.js';

export { PRICES, priceFor, costOf } from './pricing.js';
export type { ModelPrice } from './pricing.js';

export { loadFixtures, fixtureSubject, fixtureJudge } from './fixtures.js';
export type { Fixture } from './fixtures.js';

/* Fixture builders are API, not test scaffolding. See src/testing.ts. */
export { subjectOutput, evalCase, subjectContext, scoreArgs } from './testing.js';
