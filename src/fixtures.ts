/**
 * Replaying recorded outputs instead of calling a model.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gate that runs on every push has to prove the harness works —
 * concurrency, sampling, extraction, scoring, the baseline comparison, the exit
 * code. It cannot prove the model works, because doing that on every push would
 * cost money on every push, require a secret that forks do not have, and
 * produce a different answer each time it ran.
 *
 * So the per-push run replays outputs recorded once and committed. It is
 * deterministic, free, needs no secrets, and works on a fork. What it verifies
 * is real and bounded: that a change to this repository did not break the
 * machinery. The live run against real models is a separate workflow on a
 * schedule (ADR 013).
 *
 * WHERE THE DATA CAME FROM IS A FIELD, NOT A SENTENCE
 * ---------------------------------------------------
 * Every fixture carries a required `provenance`. As of this writing all of them
 * are `hand-authored`, and the report says so on every run.
 *
 * This comment used to claim the opposite — "the recorded outputs are real
 * responses from a real model, frozen" — which was false when it was written
 * and stayed false for two commits. See ADR 015. The lesson is not that the
 * comment was careless; it is that a comment is the wrong place to assert a
 * fact nobody can check from the file.
 *
 * Hand-authored fixtures are still worth having: they make the per-push gate
 * deterministic and free. They just do not exercise the format distribution a
 * real model produces — the live run of 2026-08-19 emitted a markdown fence on
 * two thirds of samples, while every fixture here is bare JSON.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { provenanceSchema, toProvenance } from './provenance.js';
import type { Provenance } from './provenance.js';
import type { JudgeClient, JudgeResponse } from './scorers/judge.js';
import type { LockedModel } from './models-lock.js';
import type { Subject, SubjectOutput } from './types.js';

const toolCallSchema = z.strictObject({
  name: z.string(),
  input: z.unknown(),
  id: z.string().optional(),
});

const fixtureSchema = z.strictObject({
  caseId: z.string().min(1),
  /* Required. A fixture that does not say where it came from does not load. */
  provenance: provenanceSchema,
  output: z.strictObject({
    text: z.string().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
    model: z.string().min(1),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    latencyMs: z.number().nonnegative().optional(),
  }),
  /** Verdicts the judge returned for this case when it was recorded. */
  judge: z
    .array(z.strictObject({ score: z.number().min(0).max(1), reason: z.string(), confidence: z.number().min(0).max(1) }))
    .optional(),
});

export type Fixture = {
  caseId: string;
  provenance: Provenance;
  output: SubjectOutput;
  judge?: { score: number; reason: string; confidence: number }[];
};

export async function loadFixtures(dir: string): Promise<Map<string, Fixture>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();

  const fixtures = new Map<string, Fixture>();
  for (const file of files) {
    const document: unknown = parseYaml(await readFile(file, 'utf8'));
    if (document === null || document === undefined) continue;

    for (const [index, entry] of (Array.isArray(document) ? document : [document]).entries()) {
      const parsed = fixtureSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(
          `${file} [fixture ${index}]: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
        );
      }
      const { caseId, output, judge } = parsed.data;
      fixtures.set(caseId, {
        caseId,
        provenance: toProvenance(parsed.data.provenance),
        output: {
          raw: null,
          model: output.model,
          usage: {
            inputTokens: output.inputTokens ?? 0,
            outputTokens: output.outputTokens ?? 0,
          },
          latencyMs: output.latencyMs ?? 0,
          ...(output.text !== undefined && { text: output.text }),
          ...(output.toolCalls !== undefined && {
            toolCalls: output.toolCalls.map((call) => ({
              name: call.name,
              input: call.input,
              ...(call.id !== undefined && { id: call.id }),
            })),
          }),
        },
        ...(judge !== undefined && { judge: [...judge] }),
      });
    }
  }
  return fixtures;
}

/**
 * A subject that returns the recorded output for a case.
 *
 * Throws on a case with no fixture rather than returning something empty: a
 * missing recording is a gap in what CI covers, and the whole point of this
 * repository is that a gap in coverage should be loud.
 */
export function fixtureSubject(fixtures: Map<string, Fixture>): Subject {
  return (_input, ctx) => {
    const fixture = fixtures.get(ctx.caseId);
    if (fixture === undefined) {
      return Promise.reject(
        new Error(
          `no recorded fixture for case "${ctx.caseId}". Record one under ` +
            `evals/fixtures/, or the fixture run silently stops covering this case.`,
        ),
      );
    }
    return Promise.resolve(fixture.output);
  };
}

/**
 * A judge that replays recorded verdicts.
 *
 * Keeping the judge in the fixture run matters: without it the judged cases
 * would have to be dropped, and the per-push gate would stop exercising
 * self-consistency, median selection, and the disagreement path — the parts of
 * the judge most likely to break under a refactor.
 */
export function fixtureJudge(fixtures: Map<string, Fixture>, model = 'fixture-judge'): JudgeClient {
  const locked: LockedModel = { modelId: model, revision: 'fixture', dtype: 'replay' };
  /* Looked up by case id. An earlier version searched the user turn for the
     recorded output text, which worked for three fixtures and would have
     silently cross-matched the moment two cases shared an output. */
  return {
    model,
    locked: () => Promise.resolve(locked),
    evaluate: ({ caseId }): Promise<JudgeResponse> => {
      const fixture = fixtures.get(caseId);
      const verdicts = fixture?.judge;
      if (fixture === undefined || verdicts === undefined || verdicts.length === 0) {
        return Promise.reject(
          new Error(`no recorded judge verdicts for case "${caseId}"`),
        );
      }
      const index = counters.get(fixture.caseId) ?? 0;
      counters.set(fixture.caseId, index + 1);
      return Promise.resolve({
        verdict: verdicts[index % verdicts.length] as (typeof verdicts)[number],
        model,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  };
}

/** Per-case call counter, so k samples walk the recorded verdict list and the
 *  disagreement path is exercised rather than always seeing one value. */
const counters = new Map<string, number>();
