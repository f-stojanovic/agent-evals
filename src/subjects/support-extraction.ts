/**
 * The thing under test: a support-email extraction agent.
 *
 * This is a SAMPLE SUBJECT, not part of the harness. It exists so the suite has
 * something real to evaluate — the repository ships an eval harness, and a
 * harness that has never evaluated anything is a claim rather than a tool.
 *
 * Deliberately plain: one Anthropic call, a system prompt, JSON out. Anything
 * cleverer would mean the numbers describe prompt engineering rather than the
 * harness, and the point of the first live run is to find out whether the
 * harness works on real output.
 */

import { config as loadDotenv } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import type { Subject, SubjectOutput } from '../types.js';

export const SUBJECT_MODEL = 'claude-sonnet-5';

/** Bumped whenever the prompt or schema changes, because the cache keys on it
 *  and reusing cached responses would record the old subject's scores. */
export const SUBJECT_ID = 'support-extraction@3';

/**
 * THE CATEGORICAL FIELDS ARE ENUMS IN A SCHEMA, NOT REQUESTS IN PROSE.
 *
 * Version 1 asked for `requested_action` as "a short snake_case verb phrase",
 * and the first live run lost that field on all three cases while answering
 * every one of them correctly: `refund_full_amount` for `issue_refund`,
 * `fix_checkout_api_503_errors` for `escalate_to_engineering`,
 * `clarify_cancellation_terms` for `explain_cancellation_terms`. The scorer was
 * working; the task definition was wrong. See ADR 016.
 *
 * `intent` and `urgency` were already closed sets, but only in prose — the
 * prompt listed the values and nothing enforced them. They move here too, so
 * the set the model may answer from is the set the case is written against.
 *
 * `customer_name` stays free text, because it genuinely is. So does `summary`,
 * and for the opposite reason to `requested_action`: a one-sentence description
 * of a ticket has no single correct wording, so constraining it to a set would
 * be the same mistake inverted — forcing free text into a taxonomy rather than
 * grading a taxonomy as free text. It is scored by meaning, not by string
 * equality. See ADR 019.
 */
export const INTENTS = [
  'refund_request',
  'technical_issue',
  'cancellation_request',
  'complaint',
  'billing_question',
] as const;

export const URGENCIES = ['low', 'medium', 'high', 'critical'] as const;

export const REQUESTED_ACTIONS = [
  'issue_refund',
  'replace_item',
  'escalate_to_engineering',
  'explain_cancellation_terms',
  'request_more_information',
  'apologise',
] as const;

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_extraction',
  description: 'Record the structured data extracted from the support email.',
  /* The API validates the input against this schema, so an out-of-set value is
     rejected at the boundary rather than arriving as a plausible synonym the
     harness then has to decide about. */
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'urgency', 'customer_name', 'requested_action', 'summary'],
    properties: {
      intent: { type: 'string', enum: [...INTENTS] },
      urgency: {
        type: 'string',
        enum: [...URGENCIES],
        description: 'How fast this needs a human, judged from consequences rather than tone.',
      },
      customer_name: {
        type: 'string',
        description:
          'Exactly as it appears in the email. If only an initial and surname are given, ' +
          'return exactly that. Never invent a first name.',
      },
      requested_action: { type: 'string', enum: [...REQUESTED_ACTIONS] },
      summary: {
        type: 'string',
        description:
          'One sentence describing what this email is about, for a human triaging ' +
          'a queue. Say what happened and what the customer wants.',
      },
    },
  },
};

const SYSTEM_PROMPT = `You extract structured data from customer support emails.

Call record_extraction exactly once with what the email asks for. Choose the
closest value from each enum; do not explain your choice. Write the summary in
one plain sentence.`;

export type SupportExtractionOptions = {
  readonly model?: string;
  readonly client?: Anthropic;
  readonly envPath?: string;
  readonly maxTokens?: number;
};

export function supportExtractionSubject(options: SupportExtractionOptions = {}): Subject {
  const model = options.model ?? SUBJECT_MODEL;
  const maxTokens = options.maxTokens ?? 1024;

  let client = options.client;
  const getClient = (): Anthropic => {
    if (client !== undefined) return client;
    /* Same rule as the judge: the key comes from the project .env by path, not
       from whatever happens to be exported in the shell. */
    loadDotenv({ path: options.envPath ?? '.env', quiet: true });
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      throw new Error('ANTHROPIC_API_KEY is not set (see .env.example)');
    }
    client = new Anthropic({ apiKey });
    return client;
  };

  return async (input, ctx): Promise<SubjectOutput> => {
    const started = Date.now();
    const response = await getClient().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
        messages: [{ role: 'user', content: renderEmail(input) }],
      },
      { signal: ctx.signal },
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ name: block.name, input: block.input, id: block.id }));

    return {
      /* Kept whole: a scorer written next year may want a field nobody
         normalised today. */
      raw: response,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      latencyMs: Date.now() - started,
      ...(text !== '' && { text }),
      ...(toolCalls.length > 0 && { toolCalls }),
    };
  };
}

/** Cases carry `input` as an object; this renders it back into an email the
 *  way a real pipeline would receive one. */
function renderEmail(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return JSON.stringify(input);

  const email = input as { from?: unknown; subject?: unknown; body?: unknown };
  return [
    `From: ${String(email.from ?? 'unknown')}`,
    `Subject: ${String(email.subject ?? '(none)')}`,
    '',
    String(email.body ?? ''),
  ].join('\n');
}
