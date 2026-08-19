import { describe, expect, it } from 'vitest';
import { callsTool, exactFields, lowercaseStrings, matchesSchema, trimStrings } from './exact.js';
import { evalCase, scoreArgs, subjectOutput } from '../testing.js';

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
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields(),
      output: json(EXPECTED_FIELDS),
    }));

    expect(score.value).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.scorer).toBe('exact-fields');
  });

  it('awards partial credit as an exact fraction', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields(),
      output: json({ ...EXPECTED_FIELDS, urgency: 'high' }),
    }));

    /* 3 of 4, not "failed". This is the entire argument for continuous
       scores — a binary result would report the same thing as a total miss. */
    expect(score.value).toBe(0.75);
    expect(score.passed).toBe(false);
    expect(score.reason).toContain('3/4');
    expect(score.reason).toContain('urgency');
  });

  it('scores 0 when nothing matches', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields(),
      output: json({
        intent: 'complaint',
        urgency: 'low',
        customer_name: 'Someone Else',
        requested_action: 'apologise',
      }),
    }));

    expect(score.value).toBe(0);
  });

  it('distinguishes missing, mismatched, and extra fields in meta', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request', urgency: 'medium' }),
      output: json({ intent: 'complaint', confidence: 0.4 }),
    }));

    expect(score.meta?.['fields']).toEqual({
      intent: { status: 'mismatch', expected: 'refund_request', actual: 'complaint' },
      urgency: { status: 'missing', expected: 'medium' },
    });
    /* Always recorded, never scored: this scorer measures recall of the
       expected fields, and folding precision in would make both unreadable.
       Surfacing them is the report's job. */
    expect(score.meta?.['extraFields']).toEqual(['confidence']);
    expect(score.value).toBe(0);
  });

  it('records extraFields even when every expected field matched', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output: json({ intent: 'refund_request', confidence: 0.9, notes: 'hi' }),
    }));

    expect(score.value).toBe(1);
    expect(score.meta?.['extraFields']).toEqual(['confidence', 'notes']);
  });

  it('scores the same however the payload arrived, and does not restate the route', async () => {
    const clean = await exactFields().score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output: json({ intent: 'refund_request' }),
    }));
    const messy = await exactFields().score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output: subjectOutput({ text: 'Sure:\n```json\n{"intent":"refund_request"}\n```' }),
    }));

    /* Identical field scores — the route is formatCompliance's business, and
       `via` lives once on CaseResult rather than in every scorer's meta. */
    expect(clean.value).toBe(1);
    expect(messy.value).toBe(1);
    expect(clean.meta?.['via']).toBeUndefined();
    expect(messy.meta?.['via']).toBeUndefined();
  });

  it('scores 0 with a reason when the model returned prose instead of JSON', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields(),
      output: subjectOutput({ text: 'The customer wants a refund, I think.' }),
    }));

    expect(score.value).toBe(0);
    expect(score.reason).toContain('could not read structured output');
    expect(score.meta?.['extraction']).toBe('failed');
  });

  it('reads a fenced code block', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output: subjectOutput({ text: '```json\n{"intent":"refund_request"}\n```' }),
    }));

    expect(score.value).toBe(1);
  });

  it('scores 0 when the structured output is not an object', async () => {
    const score = await exactFields().score(scoreArgs({
      case: caseWithFields(),
      output: json(['refund_request']),
    }));

    expect(score.value).toBe(0);
    expect(score.meta?.['extraction']).toBe('wrong-shape');
  });

  it('rejects an empty `fields`, which asserts nothing', async () => {
    /* Unlike `toolCalls: []`, an empty field map is a leftover rather than a
       decision. Omitting the key is the declared way to say "skip me". */
    await expect(
      exactFields().score(scoreArgs({ case: caseWithFields({}), output: json({ intent: 'anything' }) })),
    ).rejects.toThrow(/empty `expect.fields`/);
  });

  it('is exact by default and tolerant only when asked', async () => {
    const output = json({ intent: '  Refund_Request  ' });
    const strict = await exactFields().score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output,
    }));
    const lenient = await exactFields({ normalizers: [trimStrings, lowercaseStrings] }).score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output,
    }));

    expect(strict.value).toBe(0);
    expect(lenient.value).toBe(1);
  });

  it('honours a threshold below 1', async () => {
    const score = await exactFields({ threshold: 0.75 }).score(scoreArgs({
      case: caseWithFields(),
      output: json({ ...EXPECTED_FIELDS, urgency: 'high' }),
    }));

    expect(score.value).toBe(0.75);
    expect(score.passed).toBe(true);
  });

  it('takes a name override, so one suite can register two configurations', async () => {
    const strict = exactFields();
    const lenient = exactFields({ name: 'exact-fields-lenient', normalizers: [lowercaseStrings] });

    expect(strict.name).toBe('exact-fields');
    expect(lenient.name).toBe('exact-fields-lenient');

    const score = await lenient.score(scoreArgs({
      case: caseWithFields({ intent: 'refund_request' }),
      output: json({ intent: 'REFUND_REQUEST' }),
    }));
    expect(score.scorer).toBe('exact-fields-lenient');
    expect(score.value).toBe(1);
  });

  it('throws when run against a case that declares no `fields`', async () => {
    /* A wiring bug, not a model failure: scoring it would put a number in the
       baseline that describes the harness. */
    await expect(
      exactFields().score(scoreArgs({ case: evalCase({ expect: {} }), output: json({}) })),
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
    const score = await matchesSchema().score(scoreArgs({
      case: schemaCase,
      output: json({ intent: 'refund_request', urgency: 'medium' }),
    }));

    expect(score.value).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('scores 0 and reports the violations', async () => {
    const score = await matchesSchema().score(scoreArgs({
      case: schemaCase,
      output: json({ intent: 'refund_request', urgency: 'quite bad' }),
    }));

    /* Binary is correct here and nowhere else: a document either satisfies a
       schema or it does not. */
    expect(score.value).toBe(0);
    expect(score.reason).toContain('urgency');
    expect(Array.isArray(score.meta?.['errors'])).toBe(true);
  });

  it('scores 0 when the model returned prose', async () => {
    const score = await matchesSchema().score(scoreArgs({
      case: schemaCase,
      output: subjectOutput({ text: 'I could not determine the urgency.' }),
    }));

    expect(score.value).toBe(0);
    expect(score.meta?.['extraction']).toBe('failed');
  });

  it('accepts an empty schema, which permits anything', async () => {
    const score = await matchesSchema().score(scoreArgs({
      case: evalCase({ expect: { schema: {} } }),
      output: json({ whatever: true }),
    }));

    expect(score.value).toBe(1);
  });

  it('throws on an uncompilable schema, since that is an authoring bug', async () => {
    await expect(
      matchesSchema().score(scoreArgs({
        case: evalCase({ id: 'bad-schema', expect: { schema: { type: 'nonsense' } } }),
        output: json({}),
      })),
    ).rejects.toThrow(/invalid `expect.schema`/);
  });
});

describe('callsTool', () => {
  const toolCase = (expected: unknown) => evalCase({ id: 'tool-01', expect: { toolCalls: expected } });

  it('scores 1 when every expected call is present, in any order', async () => {
    const score = await callsTool().score(scoreArgs({
      case: toolCase([{ name: 'lookup_order' }, { name: 'issue_refund' }]),
      output: subjectOutput({
        toolCalls: [
          { name: 'issue_refund', input: {} },
          { name: 'lookup_order', input: {} },
        ],
      }),
    }));

    expect(score.value).toBe(1);
  });

  it('awards partial credit for a subset of the expected calls', async () => {
    const score = await callsTool().score(scoreArgs({
      case: toolCase([{ name: 'lookup_order' }, { name: 'issue_refund' }]),
      output: subjectOutput({ toolCalls: [{ name: 'lookup_order', input: {} }] }),
    }));

    expect(score.value).toBe(0.5);
    expect(score.reason).toContain('issue_refund');
    expect(score.meta?.['missing']).toEqual(['issue_refund']);
  });

  it('matches input as a subset, allowing extra keys in the actual call', async () => {
    const score = await callsTool().score(scoreArgs({
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
    }));

    expect(score.value).toBe(1);
  });

  it('does not match when an expected input key is wrong', async () => {
    const score = await callsTool().score(scoreArgs({
      case: toolCase([{ name: 'issue_refund', input: { order_id: '48812' } }]),
      output: subjectOutput({ toolCalls: [{ name: 'issue_refund', input: { order_id: '99999' } }] }),
    }));

    expect(score.value).toBe(0);
  });

  it('requires two actual calls when the same call is expected twice', async () => {
    const score = await callsTool().score(scoreArgs({
      case: toolCase([{ name: 'lookup_order' }, { name: 'lookup_order' }]),
      output: subjectOutput({ toolCalls: [{ name: 'lookup_order', input: {} }] }),
    }));

    expect(score.value).toBe(0.5);
  });

  it('scores 0 when the model made no tool calls at all', async () => {
    const score = await callsTool().score(scoreArgs({
      case: toolCase([{ name: 'issue_refund' }]),
      output: subjectOutput({ text: 'I would recommend a refund here.' }),
    }));

    expect(score.value).toBe(0);
    expect(score.meta?.['missing']).toEqual(['issue_refund']);
  });

  it('reports calls the model made that nothing expected, without penalising them', async () => {
    const score = await callsTool().score(scoreArgs({
      case: toolCase([{ name: 'lookup_order' }]),
      output: subjectOutput({
        toolCalls: [
          { name: 'lookup_order', input: {} },
          { name: 'send_email', input: {} },
        ],
      }),
    }));

    expect(score.value).toBe(1);
    expect(score.meta?.['unmatchedActual']).toEqual(['send_email']);
  });

  it('reads an empty expected list as "make no tool calls at all"', async () => {
    /* A real assertion, not a leftover: over-eager tool use is a standard
       agent failure mode, and this is how a case says "answer directly". */
    const compliant = await callsTool().score(scoreArgs({
      case: toolCase([]),
      output: subjectOutput({ text: 'The notice period is 30 days.' }),
    }));
    const overEager = await callsTool().score(scoreArgs({
      case: toolCase([]),
      output: subjectOutput({ toolCalls: [{ name: 'search_docs', input: {} }] }),
    }));

    expect(compliant.value).toBe(1);
    expect(overEager.value).toBe(0);
    expect(overEager.reason).toContain('search_docs');
    expect(overEager.meta?.['unmatchedActual']).toEqual(['search_docs']);
  });

  it('throws when `expect.toolCalls` is malformed', async () => {
    await expect(
      callsTool().score(scoreArgs({ case: toolCase([{ tool: 'issue_refund' }]), output: subjectOutput({}) })),
    ).rejects.toThrow(/must have a string `name`/);
  });
});
