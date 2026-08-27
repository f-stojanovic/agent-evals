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
 * Every fixture carries a required `provenance`, and the report prints the
 * tally on every run. THIS COMMENT DELIBERATELY DOES NOT REPEAT THAT TALLY —
 * read the run output, or `evals/fixtures/*.yaml`, both of which are the data
 * rather than a description of it.
 *
 * THAT OMISSION IS THE POINT, AND IT IS THE THIRD VERSION OF THIS PARAGRAPH.
 * Version one said "the recorded outputs are real responses from a real model,
 * frozen" while they had been written by hand in the same session — false when
 * it was written, false for two commits, and the reason ADR 015 made
 * provenance a required typed field. Version two corrected it to "as of this
 * writing all of them are `hand-authored`", which was true on the day and
 * became false the moment the fixtures were re-captured from a live run; it
 * then sat contradicting its own data — and the tally printed by every run —
 * inside the file that exists to explain why that must not happen.
 *
 * Twice is a pattern with a stable cause: a sentence describing data that
 * lives elsewhere has no reason to be revisited when the data changes, and
 * nothing notices. So the sentence is gone rather than corrected a third time,
 * and `docs.test.ts` fails the build if this header states a provenance kind
 * at all outside a quotation. The rule is a ban rather than a comparison, and
 * the reasoning for that — four rounds of trying to recognise a claim in
 * English, and what each round quietly stopped seeing — is recorded in the
 * check itself.
 *
 * What is durably true and worth saying: a fixture holds the subject still, so
 * the per-push gate is deterministic, free, and works on a fork. What it
 * cannot do is tell you the model still behaves this way — that is the live
 * run's job (ADR 013).
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
