/**
 * Deterministic scorers: no model in the loop, no network, no variance.
 *
 * These are the cheap, fast, reproducible half of a suite. Anything they can
 * answer should not be handed to a judge — a judge costs money, takes seconds,
 * and disagrees with itself.
 *
 * All three factories follow the same split, which is the important idea in
 * this file:
 *
 *   - A malformed or missing *expectation* is a wiring bug in the suite, and
 *     throws. It is the author's mistake and no score would be meaningful.
 *   - A malformed or missing *model response* is a result, and scores 0.0 with
 *     a reason. It is exactly the behaviour the suite exists to measure.
 */

/* Named import, not default: ajv is CommonJS, and under NodeNext its default
   export resolves to the module namespace rather than the class. */
import { Ajv } from 'ajv';
import type { ErrorObject, Schema } from 'ajv';
import type { EvalCase, Score, ScoreArgs, Scorer } from '../types.js';

/* ------------------------------------------------------------------ *
 * exactFields
 * ------------------------------------------------------------------ */

/** Applied to both the expected and the actual value before comparing, so a
 *  normaliser can never make one side match by accident. */
export type FieldNormalizer = (value: unknown) => unknown;

/** Trims every string, including strings nested in arrays and objects. */
export const trimStrings: FieldNormalizer = (value) => mapStrings(value, (s) => s.trim());

/** Lowercases every string, including nested ones. */
export const lowercaseStrings: FieldNormalizer = (value) =>
  mapStrings(value, (s) => s.toLowerCase());

/** Every factory takes this. A suite legitimately registers the same scorer
 *  twice with different settings — strict on `intent`, whitespace-tolerant on
 *  `customer_name` — and two scorers cannot share a name, since the name is a
 *  baseline column. */
export type NamedScorerOptions = {
  readonly name?: string;
};

export type ExactFieldsOptions = NamedScorerOptions & {
  /**
   * Applied left to right, to both sides. Empty by default: exact means exact
   * unless the author asks otherwise. Case and whitespace tolerance is a
   * decision about what the suite is measuring, and it should be visible at
   * the registration site rather than baked into the comparison.
   */
  readonly normalizers?: readonly FieldNormalizer[];
  /** `passed` cutoff. Defaults to 1 — every expected field must match. The
   *  continuous value is recorded regardless, so the cutoff can be revisited
   *  against historical runs. */
  readonly threshold?: number;
};

/**
 * Scores `expect.fields` — a flat record of field name to expected value —
 * against the structured data the subject produced.
 *
 * PARTIAL CREDIT IS THE POINT. Four of five fields correct is 0.8, not 0. A
 * binary result here would make the single most common kind of progress
 * invisible: a prompt change that fixes `urgency` on nine cases while
 * `customer_name` stays broken moves nothing at all in a pass/fail world, and
 * moves the suite mean by a lot in this one.
 */
export function exactFields(options: ExactFieldsOptions = {}): Scorer {
  const name = options.name ?? 'exact-fields';
  const normalizers = options.normalizers ?? [];
  const threshold = options.threshold ?? 1;
  const normalize = (value: unknown): unknown =>
    normalizers.reduce<unknown>((acc, fn) => fn(acc), value);

  return {
    name,
    claims: [{ key: 'fields', required: true }],
    consumesExtraction: true,
    /* `async` with nothing awaited: the Scorer contract is async so that a
       deterministic scorer can be swapped for a judge without changing any
       call site. */
    async score({ case: evalCase, extraction }: ScoreArgs): Promise<Score> {
      const expected = readRecordExpectation(name, 'fields', evalCase);

      const fieldNames = Object.keys(expected);
      if (fieldNames.length === 0) {
        /* `fields: {}` is an error, while `toolCalls: []` a few hundred lines
           down is legal. The difference is what the empty container can mean:
           an empty tool call list is a real assertion ("the model should
           answer directly, calling nothing"), whereas an empty field map
           asserts nothing about anything. It is a leftover from deleting the
           last field, and the author who wanted no field check should have
           omitted the key — at which point this scorer is skipped, which is
           the declared way to say "does not apply".

           That rule cannot live in the harness, because the harness cannot
           know which of a scorer's empty containers are meaningful. It belongs
           to each scorer, next to the semantics it depends on. */
        throw new Error(
          `Scorer "${name}": case "${evalCase.id}" has an empty \`expect.fields\`, ` +
            `which asserts nothing. Omit the key entirely to skip this scorer for ` +
            `the case`,
        );
      }

      if (extraction.via === 'unreadable') {
        /* Scored, not errored: the model was asked for JSON and produced none,
           which is a measurable failure and belongs in the baseline. The
           `ambiguous` arm never reaches a scorer — the runner errors the case
           before calling one. */
        return fail(name, `could not read structured output: ${extraction.error}`, {
          extraction: 'unreadable',
        });
      }
      if (extraction.via === 'ambiguous') {
        throw new Error(`unreachable: the runner errors ambiguous extractions before scoring`);
      }
      if (!isRecord(extraction.data)) {
        return fail(name, `expected an object of fields, got ${describeType(extraction.data)}`, {
          extraction: 'wrong-shape',
        });
      }
      const actual = extraction.data;

      /* Three distinguishable outcomes per field, because they call for
         different fixes: `missing` means the model dropped a field (usually a
         prompt problem), `mismatch` means it answered wrongly (usually a
         capability or an ambiguous-case problem). Conflating them in the
         report costs a human the round trip of going to look. */
      const fields: Record<string, FieldOutcome> = {};
      const mismatched: string[] = [];
      const missing: string[] = [];
      let matched = 0;

      for (const field of fieldNames) {
        const want = expected[field];
        if (!(field in actual)) {
          fields[field] = { status: 'missing', expected: want };
          missing.push(field);
          continue;
        }
        const got = actual[field];
        if (deepEqual(normalize(want), normalize(got))) {
          matched += 1;
          fields[field] = { status: 'match', expected: want };
        } else {
          fields[field] = { status: 'mismatch', expected: want, actual: got };
          mismatched.push(field);
        }
      }

      /* ALWAYS RECORDED, NEVER SCORED.
         Keys the model produced that no expectation mentions are real
         information — hallucinated fields, a schema that drifted, a prompt
         leaking its scratch work — and the report is responsible for surfacing
         them. They do not move the score, because this scorer measures recall
         of the expected fields and nothing else. Folding precision into the
         same number would make both unreadable: 0.8 would no longer answer
         "how much of what I asked for did it get right?", and no other number
         would answer it either. A suite that wants precision enforced says so
         with `matchesSchema` and `additionalProperties: false`. */
      const extraFields = Object.keys(actual)
        .filter((key) => !(key in expected))
        .sort();

      const value = matched / fieldNames.length;
      const notes = [
        mismatched.length > 0 ? `wrong: ${mismatched.join(', ')}` : undefined,
        missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
      ].filter((note): note is string => note !== undefined);

      return {
        scorer: name,
        value,
        passed: value >= threshold,
        reason:
          `${matched}/${fieldNames.length} fields matched` +
          (notes.length > 0 ? ` (${notes.join('; ')})` : ''),
        /* No `via` here: extraction happens once per case and is recorded on
           CaseResult, so repeating it in every scorer's meta would store the
           same fact three times and invite them to disagree. */
        meta: { expected: fieldNames.length, matched, fields, extraFields },
      };
    },
  };
}

type FieldOutcome =
  | { status: 'match'; expected: unknown }
  | { status: 'missing'; expected: unknown }
  | { status: 'mismatch'; expected: unknown; actual: unknown };

/* ------------------------------------------------------------------ *
 * matchesSchema
 * ------------------------------------------------------------------ */

/**
 * Validates the subject's structured output against the JSON Schema fragment
 * in `expect.schema`.
 *
 * THE EXCEPTION THAT PROVES THE RULE ABOUT CONTINUOUS SCORES. Everywhere else
 * in this harness a binary score is a design smell, because it throws away the
 * direction of a change. Not here: a document either satisfies a schema or it
 * does not. There is no defensible reading under which a response is 0.6
 * schema-valid — you could count satisfied subschemas, but that number would
 * be an artefact of how the schema happened to be factored, not a property of
 * the response, and it would move when someone refactored the schema without
 * changing its meaning. A number that moves for reasons unrelated to quality
 * is worse than no number.
 *
 * Ajv runs in non-strict mode: `expect.schema` is hand-written by a case
 * author, and strict mode rejects harmless things like an unknown annotation
 * keyword. The suite should fail on the model being wrong, not on the author
 * using a keyword Ajv did not expect.
 */
export function matchesSchema(options: NamedScorerOptions = {}): Scorer {
  const name = options.name ?? 'matches-schema';
  const ajv = new Ajv({ allErrors: true, strict: false });

  return {
    name,
    claims: [{ key: 'schema', required: true }],
    consumesExtraction: true,
    async score({ case: evalCase, extraction }: ScoreArgs): Promise<Score> {
      const schema = readExpectation(name, 'schema', evalCase);
      if (!isRecord(schema) && typeof schema !== 'boolean') {
        throw new Error(
          `Scorer "${name}": case "${evalCase.id}" has \`expect.schema\` of type ` +
            `${describeType(schema)}; a JSON Schema must be an object or a boolean`,
        );
      }

      let validate;
      try {
        /* Ajv caches by schema object identity, so re-compiling per call is
           cheap after the first case. */
        validate = ajv.compile(schema as Schema);
      } catch (error) {
        /* An uncompilable schema is an authoring bug, not a model failure. */
        throw new Error(
          `Scorer "${name}": case "${evalCase.id}" has an invalid \`expect.schema\`: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (extraction.via === 'unreadable') {
        return fail(name, `could not read structured output: ${extraction.error}`, {
          extraction: 'unreadable',
        });
      }
      if (extraction.via === 'ambiguous') {
        throw new Error(`unreachable: the runner errors ambiguous extractions before scoring`);
      }

      const valid = validate(extraction.data);
      if (valid) {
        return {
          scorer: name,
          value: 1,
          passed: true,
          reason: 'output satisfies the schema',
        };
      }

      const errors = validate.errors ?? [];
      return {
        scorer: name,
        value: 0,
        passed: false,
        reason: `output violates the schema: ${summariseAjvErrors(errors)}`,
        meta: { errors },
      };
    },
  };
}

function summariseAjvErrors(errors: readonly ErrorObject[]): string {
  if (errors.length === 0) return 'no detail reported';
  const rendered = errors
    .slice(0, 3)
    .map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`);
  const remaining = errors.length - rendered.length;
  return rendered.join('; ') + (remaining > 0 ? `; and ${remaining} more` : '');
}

/* ------------------------------------------------------------------ *
 * callsTool
 * ------------------------------------------------------------------ */

export type CallsToolOptions = NamedScorerOptions & {
  /** `passed` cutoff. Defaults to 1 — every expected call must be present. */
  readonly threshold?: number;
};

/**
 * Scores `expect.toolCalls` — a list of `{ name, input? }` — against the tool
 * calls the subject actually made.
 *
 * ORDER IS IGNORED. Agents legitimately reorder independent calls between
 * runs, and asserting a sequence would flag nondeterminism that has no bearing
 * on whether the agent did the right thing. A scorer that cares about ordering
 * is a different scorer, and should be written as one.
 *
 * INPUT IS MATCHED AS A SUBSET: every key in the expected input must be
 * present and equal, but extra keys in the actual input are fine. Real tool
 * arguments carry incidental material — request ids, SDK-injected defaults,
 * optional parameters that appeared in a later schema version. Demanding an
 * exact object would make every case fail the day a tool gains an optional
 * field, which trains people to stop trusting the suite. The expected keys are
 * the contract; the rest is noise. An author who genuinely wants exactness can
 * assert it with `matchesSchema` and `additionalProperties: false`.
 */
export function callsTool(options: CallsToolOptions = {}): Scorer {
  const name = options.name ?? 'calls-tool';
  const threshold = options.threshold ?? 1;

  return {
    name,
    claims: [{ key: 'toolCalls', required: true }],
    /* Reads output.toolCalls directly, so a failed extraction does not
       prevent it from producing a score. */
    consumesExtraction: false,
    async score({ case: evalCase, output }: ScoreArgs): Promise<Score> {
      const expected = readExpectedToolCalls(name, evalCase);
      const actual = output.toolCalls ?? [];

      if (expected.length === 0) {
        /* `toolCalls: []` IS AN ASSERTION, unlike the empty `fields: {}` that
           this file rejects further up. "The model should answer directly
           without reaching for a tool" is a real and frequently violated
           expectation — over-eager tool use is one of the standard agent
           failure modes. So an empty list means zero calls, and any call at
           all fails it.

           The two empty containers differ because their semantics differ, and
           that is exactly why the rule lives in each scorer rather than in the
           harness: nothing generic can know which of a scorer's empty
           containers carries meaning. */
        const value = actual.length === 0 ? 1 : 0;
        return {
          scorer: name,
          value,
          passed: value >= threshold,
          reason:
            value === 1
              ? 'no tool calls expected and none were made'
              : `no tool calls expected but ${actual.length} were made ` +
                `(${actual.map((c) => c.name).join(', ')})`,
          meta: {
            expected: 0,
            matched: 0,
            missing: [],
            unmatchedActual: actual.map((c) => c.name),
          },
        };
      }

      /* Each actual call may satisfy at most one expectation, so expecting the
         same call twice genuinely requires it to have happened twice. */
      const consumed = new Set<number>();
      const missing: string[] = [];
      let matched = 0;

      for (const want of expected) {
        const index = actual.findIndex(
          (call, i) =>
            !consumed.has(i) &&
            call.name === want.name &&
            (want.input === undefined || isSubset(want.input, call.input)),
        );
        if (index === -1) {
          missing.push(want.name);
          continue;
        }
        consumed.add(index);
        matched += 1;
      }

      const unmatchedActual = actual
        .map((call, i) => (consumed.has(i) ? undefined : call.name))
        .filter((n): n is string => n !== undefined);

      const value = matched / expected.length;
      return {
        scorer: name,
        value,
        passed: value >= threshold,
        reason:
          `${matched}/${expected.length} expected tool calls made` +
          (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''),
        meta: { expected: expected.length, matched, missing, unmatchedActual },
      };
    },
  };
}

type ExpectedToolCall = { name: string; input?: Record<string, unknown> };

function readExpectedToolCalls(scorerName: string, evalCase: EvalCase): ExpectedToolCall[] {
  const raw = readExpectation(scorerName, 'toolCalls', evalCase);
  if (!Array.isArray(raw)) {
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" has \`expect.toolCalls\` of type ` +
        `${describeType(raw)}; expected a list of { name, input? }`,
    );
  }

  return raw.map((entry, index) => {
    const where = `\`expect.toolCalls[${index}]\` in case "${evalCase.id}"`;
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      throw new Error(`Scorer "${scorerName}": ${where} must have a string \`name\``);
    }
    const input = entry['input'];
    if (input !== undefined && !isRecord(input)) {
      throw new Error(`Scorer "${scorerName}": ${where} has a non-object \`input\``);
    }
    return { name: entry['name'], ...(input !== undefined && { input }) };
  });
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/**
 * Reads a claimed key, treating its absence as a wiring bug.
 *
 * The runner is responsible for invoking a scorer only against cases that
 * declare at least one of its {@link Scorer.claims}. If that contract is
 * broken, silently scoring 0 (or 1) would put a number in the baseline that
 * describes the harness rather than the model, so this throws instead.
 */
function readExpectation(scorerName: string, key: string, evalCase: EvalCase): unknown {
  if (!(key in evalCase.expect)) {
    throw new Error(
      `Scorer "${scorerName}" ran against case "${evalCase.id}", which declares no ` +
        `\`expect.${key}\`. A scorer must only be invoked for cases that declare one ` +
        `of its claimed keys.`,
    );
  }
  return evalCase.expect[key];
}

function readRecordExpectation(
  scorerName: string,
  key: string,
  evalCase: EvalCase,
): Record<string, unknown> {
  const value = readExpectation(scorerName, key, evalCase);
  if (!isRecord(value)) {
    throw new Error(
      `Scorer "${scorerName}": case "${evalCase.id}" has \`expect.${key}\` of type ` +
        `${describeType(value)}; expected a mapping of field name to expected value`,
    );
  }
  return value;
}

/** A zero score attributable to the model, not to the suite. */
function fail(scorerName: string, reason: string, meta: Record<string, unknown>): Score {
  return { scorer: scorerName, value: 0, passed: false, reason, meta };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality for JSON-shaped values. `Object.is` first, so `NaN`
 *  equals itself and `0`/`-0` stay distinct — neither appears in real YAML,
 *  but the alternative is a comparison that quietly depends on which. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Every key of `expected` present and equal in `actual`; extras allowed.
 *  Recurses into nested objects so the tolerance applies at every level, but
 *  compares arrays exactly — a partial list match would be ambiguous about
 *  position and is better expressed as a schema. */
function isSubset(expected: Record<string, unknown>, actual: unknown): boolean {
  if (!isRecord(actual)) return false;
  return Object.entries(expected).every(([key, want]) => {
    if (!(key in actual)) return false;
    const got = actual[key];
    if (isRecord(want)) return isSubset(want, got);
    return deepEqual(want, got);
  });
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
