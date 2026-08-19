import { describe, expect, it } from 'vitest';
import { callsTool, exactFields, lowercaseStrings, matchesSchema, trimStrings } from './exact.js';
import { evalCase, subjectOutput } from '../testing.js';

/** The four fields the example suite extracts, used as a realistic baseline. */
const EXPECTED_FIELDS = {
  intent: 'refund_request',
  urgency: 'medium',
  customer_name: 'Maja Petrović',
  requested_action: 'issue_refund',
};

const caseWithFields = (fields: Record<string, unknown> = EXPECTED_FIELDS) =>
  evalCase({ id: 'refund-01', expect: { fields } });

const json = (value: unknown) => subjectOutput({ text: JSON.stringify(value) });

describe('exactFields', () => {
  it('scores 1 when every expected field matches', async () => {
    const score = await exactFields().score({
      case: caseWithFields(),
      output: json(EXPECTED_FIELDS),
    });

    expect(score.value).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.scorer).toBe('exact-fields');
  });

  it('awards partial credit as an exact fraction', async () => {
    const score = await exactFields().score({
      case: caseWithFields(),
      output: json({ ...EXPECTED_FIELDS, urgency: 'high' }),
    });

    /* 3 of 4, not "failed". This is the entire argument for continuous
       scores — a binary result would report the same thing as a total miss. */
    expect(score.value).toBe(0.75);
    expect(score.passed).toBe(false);
    expect(score.reason).toContain('3/4');
    expect(score.reason).toContain('urgency');
  });

  it('scores 0 when nothing matches', async () => {
    const score = await exactFields().score({
      case: caseWithFields(),
      output: json({
        intent: 'complaint',
        urgency: 'low',
        customer_name: 'Someone Else',
        requested_action: 'apologise',
      }),
    });

    expect(score.value).toBe(0);
  });

  it('distinguishes missing, mismatched, and extra fields in meta', async () => {
    const score = await exactFields().score({
      case: caseWithFields({ intent: 'refund_request', urgency: 'medium' }),
      output: json({ intent: 'complaint', confidence: 0.4 }),
    });

    expect(score.meta?.['fields']).toEqual({
      intent: { status: 'mismatch', expected: 'refund_request', actual: 'complaint' },
      urgency: { status: 'missing', expected: 'medium' },
    });
    /* Extras are reported but do not reduce the score: shape enforcement is
       matchesSchema's job. */
    expect(score.meta?.['extra']).toEqual(['confidence']);
    expect(score.value).toBe(0);
  });

  it('scores 0 with a reason when the model returned prose instead of JSON', async () => {
    const score = await exactFields().score({
      case: caseWithFields(),
      output: subjectOutput({ text: 'The customer wants a refund, I think.' }),
    });

    expect(score.value).toBe(0);
    expect(score.reason).toContain('could not read structured output');
    expect(score.meta?.['extraction']).toBe('failed');
  });

  it('reads a fenced code block', async () => {
    const score = await exactFields().score({
      case: caseWithFields({ intent: 'refund_request' }),
      output: subjectOutput({ text: '```json\n{"intent":"refund_request"}\n```' }),
    });

    expect(score.value).toBe(1);
  });

  it('scores 0 when the structured output is not an object', async () => {
    const score = await exactFields().score({
      case: caseWithFields(),
      output: json(['refund_request']),
    });

    expect(score.value).toBe(0);
    expect(score.meta?.['extraction']).toBe('wrong-shape');
  });

  it('treats empty expectations as vacuously satisfied, never as 0/0', async () => {
    const score = await exactFields().score({
      case: caseWithFields({}),
      output: json({ intent: 'anything' }),
    });

    /* Guarding the division matters: NaN here would propagate into every
       aggregate that touches this case. */
    expect(score.value).toBe(1);
    expect(Number.isFinite(score.value)).toBe(true);
    expect(score.reason).toContain('nothing to check');
  });

  it('is exact by default and tolerant only when asked', async () => {
    const output = json({ intent: '  Refund_Request  ' });
    const strict = await exactFields().score({
      case: caseWithFields({ intent: 'refund_request' }),
      output,
    });
    const lenient = await exactFields({ normalizers: [trimStrings, lowercaseStrings] }).score({
      case: caseWithFields({ intent: 'refund_request' }),
      output,
    });

    expect(strict.value).toBe(0);
    expect(lenient.value).toBe(1);
  });

  it('honours a threshold below 1', async () => {
    const score = await exactFields({ threshold: 0.75 }).score({
      case: caseWithFields(),
      output: json({ ...EXPECTED_FIELDS, urgency: 'high' }),
    });

    expect(score.value).toBe(0.75);
    expect(score.passed).toBe(true);
  });

  it('throws when run against a case that declares no `fields`', async () => {
    /* A wiring bug, not a model failure: scoring it would put a number in the
       baseline that describes the harness. */
    await expect(
      exactFields().score({ case: evalCase({ expect: {} }), output: json({}) }),
    ).rejects.toThrow(/declares no `expect.fields`/);
  });
});

describe('matchesSchema', () => {
  const schemaCase = evalCase({
    id: 'schema-01',
    expect: {
      schema: {
        type: 'object',
        required: ['intent', 'urgency'],
        properties: {
          intent: { type: 'string' },
          urgency: { enum: ['low', 'medium', 'high', 'critical'] },
        },
      },
    },
  });

  it('scores 1 for a valid document', async () => {
    const score = await matchesSchema().score({
      case: schemaCase,
      output: json({ intent: 'refund_request', urgency: 'medium' }),
    });

    expect(score.value).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('scores 0 and reports the violations', async () => {
    const score = await matchesSchema().score({
      case: schemaCase,
      output: json({ intent: 'refund_request', urgency: 'quite bad' }),
    });

    /* Binary is correct here and nowhere else: a document either satisfies a
       schema or it does not. */
    expect(score.value).toBe(0);
    expect(score.reason).toContain('urgency');
    expect(Array.isArray(score.meta?.['errors'])).toBe(true);
  });

  it('scores 0 when the model returned prose', async () => {
    const score = await matchesSchema().score({
      case: schemaCase,
      output: subjectOutput({ text: 'I could not determine the urgency.' }),
    });

    expect(score.value).toBe(0);
    expect(score.meta?.['extraction']).toBe('failed');
  });

  it('accepts an empty schema, which permits anything', async () => {
    const score = await matchesSchema().score({
      case: evalCase({ expect: { schema: {} } }),
      output: json({ whatever: true }),
    });

    expect(score.value).toBe(1);
  });

  it('throws on an uncompilable schema, since that is an authoring bug', async () => {
    await expect(
      matchesSchema().score({
        case: evalCase({ id: 'bad-schema', expect: { schema: { type: 'nonsense' } } }),
        output: json({}),
      }),
    ).rejects.toThrow(/invalid `expect.schema`/);
  });
});

describe('callsTool', () => {
  const toolCase = (expected: unknown) => evalCase({ id: 'tool-01', expect: { toolCalls: expected } });

  it('scores 1 when every expected call is present, in any order', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'lookup_order' }, { name: 'issue_refund' }]),
      output: subjectOutput({
        toolCalls: [
          { name: 'issue_refund', input: {} },
          { name: 'lookup_order', input: {} },
        ],
      }),
    });

    expect(score.value).toBe(1);
  });

  it('awards partial credit for a subset of the expected calls', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'lookup_order' }, { name: 'issue_refund' }]),
      output: subjectOutput({ toolCalls: [{ name: 'lookup_order', input: {} }] }),
    });

    expect(score.value).toBe(0.5);
    expect(score.reason).toContain('issue_refund');
    expect(score.meta?.['missing']).toEqual(['issue_refund']);
  });

  it('matches input as a subset, allowing extra keys in the actual call', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'issue_refund', input: { order_id: '48812' } }]),
      output: subjectOutput({
        toolCalls: [
          /* `reason` and `idempotency_key` are incidental — asserting them
             would make the case brittle against a tool schema change. */
          {
            name: 'issue_refund',
            input: { order_id: '48812', reason: 'damaged', idempotency_key: 'abc' },
          },
        ],
      }),
    });

    expect(score.value).toBe(1);
  });

  it('does not match when an expected input key is wrong', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'issue_refund', input: { order_id: '48812' } }]),
      output: subjectOutput({ toolCalls: [{ name: 'issue_refund', input: { order_id: '99999' } }] }),
    });

    expect(score.value).toBe(0);
  });

  it('requires two actual calls when the same call is expected twice', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'lookup_order' }, { name: 'lookup_order' }]),
      output: subjectOutput({ toolCalls: [{ name: 'lookup_order', input: {} }] }),
    });

    expect(score.value).toBe(0.5);
  });

  it('scores 0 when the model made no tool calls at all', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'issue_refund' }]),
      output: subjectOutput({ text: 'I would recommend a refund here.' }),
    });

    expect(score.value).toBe(0);
    expect(score.meta?.['missing']).toEqual(['issue_refund']);
  });

  it('reports calls the model made that nothing expected, without penalising them', async () => {
    const score = await callsTool().score({
      case: toolCase([{ name: 'lookup_order' }]),
      output: subjectOutput({
        toolCalls: [
          { name: 'lookup_order', input: {} },
          { name: 'send_email', input: {} },
        ],
      }),
    });

    expect(score.value).toBe(1);
    expect(score.meta?.['unmatchedActual']).toEqual(['send_email']);
  });

  it('treats an empty expected list as vacuously satisfied', async () => {
    const score = await callsTool().score({
      case: toolCase([]),
      output: subjectOutput({ toolCalls: [{ name: 'anything', input: {} }] }),
    });

    expect(score.value).toBe(1);
    expect(score.reason).toContain('nothing to check');
  });

  it('throws when `expect.toolCalls` is malformed', async () => {
    await expect(
      callsTool().score({ case: toolCase([{ tool: 'issue_refund' }]), output: subjectOutput({}) }),
    ).rejects.toThrow(/must have a string `name`/);
  });
});
