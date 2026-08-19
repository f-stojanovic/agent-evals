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

/** Bumped whenever the prompt changes, because the cache keys on it and a
 *  prompt edit that reuses cached responses records the old prompt's scores. */
export const SUBJECT_ID = 'support-extraction@1';

const SYSTEM_PROMPT = `You extract structured data from customer support emails.

Return a JSON object with exactly these keys:
  intent            one of: refund_request, technical_issue, cancellation_request,
                    complaint, billing_question
  urgency           one of: low, medium, high, critical
  customer_name     exactly as it appears in the email. If only an initial and
                    surname are given, return exactly that. Never invent a name.
  requested_action  a short snake_case verb phrase for what the customer wants

Reply with the JSON object and nothing else.`;

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
