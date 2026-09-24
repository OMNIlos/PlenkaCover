import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { PalletSystemPrintIntentDto } from './dto/pallet-system-print-intent.dto';
import { PalletSystemPrintIntentService } from './pallet-system-print-intent.service';

const ACTOR = {
  userId: 'warehouse-user',
  role: 'warehouse' as const,
  capabilities: ['pallet_list:create' as const],
};
const INITIAL_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REPRINT_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const MIXED_CASE_REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPRINT_REASON = 'Этикетка повреждена при наклеивании';
const REQUESTED_AT = new Date('2026-08-09T07:00:00.000Z');

type IntentEvent = {
  id: string;
  type: string;
  objectId: string;
  reason: string | null;
  createdAt: Date;
  detail: {
    channel: string;
    requestId: string;
    intentKind: string;
    palletId: string;
  };
};

function setup(options: { missing?: boolean; voided?: boolean } = {}) {
  const events: IntentEvent[] = [];
  const document = options.missing
    ? null
    : {
        id: 'document-1',
        palletId: 'PAL-A-2-01',
        voidedAt: options.voided ? new Date('2026-08-09T06:00:00.000Z') : null,
      };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn((...query: unknown[]) => {
      const requestId = query.at(-1);
      return Promise.resolve(
        events.filter(
          (event) =>
            event.detail.channel === 'browser_system_print' &&
            typeof requestId === 'string' &&
            event.detail.requestId.toLowerCase() === requestId,
        ),
      );
    }),
    domainEvent: {
      findFirst: jest.fn(({ where }: { where: { AND: Array<{ detail: { equals: string } }> } }) => {
        const requestId = where.AND[1]?.detail.equals;
        return Promise.resolve(
          events.find((event) => event.detail.requestId === requestId) ?? null,
        );
      }),
    },
    palletListDocument: {
      findUnique: jest.fn().mockResolvedValue(document),
    },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = {
    record: jest.fn(
      (input: Omit<IntentEvent, 'id' | 'createdAt' | 'reason'> & { reason?: string }) => {
        const event: IntentEvent = {
          id: `event-${events.length + 1}`,
          createdAt: REQUESTED_AT,
          ...input,
          reason: input.reason ?? null,
        };
        events.push(event);
        return Promise.resolve(event);
      },
    ),
  };
  const service = new PalletSystemPrintIntentService(prisma as never, audit as never);
  return { audit, events, prisma, service, tx };
}

describe('PalletSystemPrintIntentService', () => {
  it('records an initial browser/system print intent as an append-only audit fact', async () => {
    const { audit, events, service, tx } = setup();

    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: INITIAL_REQUEST_ID,
        kind: 'initial',
      }),
    ).resolves.toEqual({
      eventId: 'event-1',
      requestId: INITIAL_REQUEST_ID,
      palletListDocumentId: 'document-1',
      kind: 'initial',
      status: 'intent_recorded',
      replayed: false,
      requestedAt: REQUESTED_AT.toISOString(),
    });

    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:pallet_list_print_requested',
        actorRole: 'warehouse',
        actorId: 'warehouse-user',
        objectId: 'document-1',
        detail: {
          channel: 'browser_system_print',
          requestId: INITIAL_REQUEST_ID,
          intentKind: 'initial',
          palletId: 'PAL-A-2-01',
        },
      },
      tx,
    );
    expect(events).toHaveLength(1);
    expect(tx).not.toHaveProperty('palletPrintJob');
  });

  it('replays the same request id without a duplicate audit fact', async () => {
    const { audit, events, service, tx } = setup();
    const command = { requestId: INITIAL_REQUEST_ID, kind: 'initial' as const };

    const first = await service.record(ACTOR, 'document-1', command);
    const replay = await service.record(ACTOR, 'document-1', command);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0],
    );
  });

  it('canonicalizes UUID case so an uppercase retry replays the same intent', async () => {
    const { audit, events, service } = setup();

    const first = await service.record(ACTOR, 'document-1', {
      requestId: INITIAL_REQUEST_ID.toUpperCase(),
      kind: 'initial',
    });
    const replay = await service.record(ACTOR, 'document-1', {
      requestId: INITIAL_REQUEST_ID,
      kind: 'initial',
    });

    expect(first.requestId).toBe(INITIAL_REQUEST_ID);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail.requestId).toBe(INITIAL_REQUEST_ID);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('replays a historical mixed-case UUID event after canonicalization is deployed', async () => {
    const { audit, events, service } = setup();
    events.push({
      id: 'legacy-uppercase-event',
      type: 'audit:pallet_list_print_requested',
      objectId: 'document-1',
      reason: null,
      createdAt: REQUESTED_AT,
      detail: {
        channel: 'browser_system_print',
        requestId: MIXED_CASE_REQUEST_ID.toUpperCase(),
        intentKind: 'initial',
        palletId: 'PAL-A-2-01',
      },
    });

    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: MIXED_CASE_REQUEST_ID,
        kind: 'initial',
      }),
    ).resolves.toMatchObject({
      eventId: 'legacy-uppercase-event',
      requestId: MIXED_CASE_REQUEST_ID,
      replayed: true,
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('records a reprint intent with the existing reprint audit event', async () => {
    const { audit, service } = setup();

    const result = await service.record(ACTOR, 'document-1', {
      requestId: REPRINT_REQUEST_ID,
      kind: 'reprint',
      reason: `  ${REPRINT_REASON.replace(' ', '   ')}  `,
    });

    expect(result.kind).toBe('reprint');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:pallet_list_reprint_requested',
        objectId: 'document-1',
        reason: REPRINT_REASON,
      }),
      expect.anything(),
    );
  });

  it('rejects reuse of a request id for another kind or document', async () => {
    const { audit, service } = setup();
    await service.record(ACTOR, 'document-1', {
      requestId: INITIAL_REQUEST_ID,
      kind: 'initial',
    });

    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: INITIAL_REQUEST_ID,
        kind: 'reprint',
        reason: REPRINT_REASON,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.record(ACTOR, 'document-2', {
        requestId: INITIAL_REQUEST_ID,
        kind: 'initial',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('replays only the same normalized reprint reason', async () => {
    const { audit, events, service } = setup();
    const command = {
      requestId: REPRINT_REQUEST_ID,
      kind: 'reprint' as const,
      reason: ` ${REPRINT_REASON} `,
    };

    const first = await service.record(ACTOR, 'document-1', command);
    const replay = await service.record(ACTOR, 'document-1', command);

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      service.record(ACTOR, 'document-1', { ...command, reason: 'Другая причина' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(REPRINT_REASON);
  });

  it('replays a pre-reason reprint event for an unchanged cached request', async () => {
    const { audit, events, service } = setup();
    events.push({
      id: 'legacy-reprint-event',
      type: 'audit:pallet_list_reprint_requested',
      objectId: 'document-1',
      reason: null,
      createdAt: REQUESTED_AT,
      detail: {
        channel: 'browser_system_print',
        requestId: REPRINT_REQUEST_ID,
        intentKind: 'reprint',
        palletId: 'PAL-A-2-01',
      },
    });

    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: REPRINT_REQUEST_ID,
        kind: 'reprint',
      }),
    ).resolves.toMatchObject({
      eventId: 'legacy-reprint-event',
      requestId: REPRINT_REQUEST_ID,
      kind: 'reprint',
      replayed: true,
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('rejects new absent/blank reprint reasons and an initial-only reason before persistence', async () => {
    const { audit, prisma, service, tx } = setup();

    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: REPRINT_REQUEST_ID,
        kind: 'reprint',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: REPRINT_REQUEST_ID,
        kind: 'reprint',
        reason: ' a ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.record(ACTOR, 'document-1', {
        requestId: INITIAL_REQUEST_ID,
        kind: 'initial',
        reason: REPRINT_REASON,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.palletListDocument.findUnique).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects missing and annulled immutable documents without an audit fact', async () => {
    const missing = setup({ missing: true });
    const voided = setup({ voided: true });

    await expect(
      missing.service.record(ACTOR, 'document-1', {
        requestId: INITIAL_REQUEST_ID,
        kind: 'initial',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      voided.service.record(ACTOR, 'document-1', {
        requestId: INITIAL_REQUEST_ID,
        kind: 'initial',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(missing.audit.record).not.toHaveBeenCalled();
    expect(voided.audit.record).not.toHaveBeenCalled();
  });

  it('validates requestId and intent kind at the transport boundary', async () => {
    const valid = Object.assign(new PalletSystemPrintIntentDto(), {
      requestId: INITIAL_REQUEST_ID,
      kind: 'initial',
    });
    const validReprint = Object.assign(new PalletSystemPrintIntentDto(), {
      requestId: REPRINT_REQUEST_ID,
      kind: 'reprint',
      reason: REPRINT_REASON,
    });
    const invalid = Object.assign(new PalletSystemPrintIntentDto(), {
      requestId: 'not-a-uuid',
      kind: 'printed',
    });
    const missingReprintReason = Object.assign(new PalletSystemPrintIntentDto(), {
      requestId: REPRINT_REQUEST_ID,
      kind: 'reprint',
    });

    await expect(validate(valid)).resolves.toHaveLength(0);
    await expect(validate(validReprint)).resolves.toHaveLength(0);
    await expect(validate(invalid)).resolves.toHaveLength(2);
    await expect(validate(missingReprintReason)).resolves.toHaveLength(0);
  });
});
