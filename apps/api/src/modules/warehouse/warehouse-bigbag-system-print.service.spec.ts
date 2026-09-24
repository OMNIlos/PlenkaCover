import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WarehouseBigBagSystemPrintService } from './warehouse-bigbag-system-print.service';

const ACTOR = { userId: 'warehouse-user', role: 'warehouse' as const };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RETRY_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = `bbt_${'a'.repeat(64)}`;
const NOW = new Date('2026-08-11T12:00:00.000Z');

function setup() {
  const jobs: any[] = [];
  const bag = {
    id: 'bag-1',
    code: 'BB-ПВД-01',
    material: 'ПВД Первичное',
    scanToken: { token: TOKEN },
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: bag.id }]),
    bigBagUnit: { findUnique: jest.fn().mockResolvedValue(bag) },
    bigBagLabelPrintJob: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(jobs.find((job) => job.requestId === where.requestId) ?? null),
      ),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...jobs].reverse().find((job) => {
            const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
            return job.bigBagId === where.bigBagId && statuses.includes(job.status);
          }) ?? null,
        ),
      ),
      create: jest.fn(({ data }: any) => {
        const job = {
          id: `job-${jobs.length + 1}`,
          failureReason: null,
          gatewayCommandId: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        jobs.push(job);
        return Promise.resolve(job);
      }),
    },
  };
  const prisma: any = {
    bigBagUnit: tx.bigBagUnit,
    bigBagLabelPrintJob: tx.bigBagLabelPrintJob,
    $transaction: jest.fn((work: (client: any) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const renderer = {
    render: jest.fn().mockReturnValue({
      buffer: Buffer.from('png'),
      contentType: 'image/png' as const,
      widthPx: 464,
      heightPx: 400,
    }),
  };
  const service = new WarehouseBigBagSystemPrintService(prisma, audit as never, renderer as never);
  return { audit, bag, jobs, prisma, renderer, service, tx };
}

describe('WarehouseBigBagSystemPrintService', () => {
  it('returns an immutable browser preview without exposing the opaque token as JSON', async () => {
    const { renderer, service } = setup();

    await expect(service.preview('bag-1')).resolves.toEqual({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
      widthPx: 464,
      heightPx: 400,
    });
    expect(renderer.render).toHaveBeenCalledWith({
      bigBagCode: 'BB-ПВД-01',
      material: 'ПВД Первичное',
      qrCode: TOKEN,
    });
  });

  it('records a browser-owned initial print intent without a device or Gateway command', async () => {
    const { audit, jobs, service } = setup();

    await expect(service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID })).resolves.toMatchObject({
      bigBagId: 'bag-1',
      printerId: null,
      channel: 'browser_system_print',
      status: 'intent_recorded',
      gatewayCommandId: null,
      reason: null,
    });
    expect(jobs[0]).toMatchObject({
      printerId: null,
      channel: 'browser_system_print',
      status: 'intent_recorded',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_label_print_requested',
        detail: expect.objectContaining({ channel: 'browser_system_print' }),
      }),
      expect.anything(),
    );
  });

  it('replays the same request id and requires a factual reason for the next intent', async () => {
    const { audit, jobs, service } = setup();

    const first = await service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID });
    await expect(service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID })).resolves.toEqual(first);
    await expect(service.record(ACTOR, 'bag-1', { requestId: RETRY_ID })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.record(ACTOR, 'bag-1', {
        requestId: RETRY_ID,
        reason: 'Этикетка повреждена',
      }),
    ).resolves.toMatchObject({
      reason: 'Этикетка повреждена',
      replacesPrintJobId: jobs[0].id,
    });
    expect(jobs).toHaveLength(2);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_label_reprint_requested',
        reason: 'Этикетка повреждена',
      }),
      expect.anything(),
    );
  });

  it.each([
    ['queued', 'BIGBAG_PRINT_IN_PROGRESS'],
    ['uncertain', 'BIGBAG_PRINT_OUTCOME_UNCERTAIN'],
  ] as const)('fails closed when a Gateway print is already %s', async (status, expectedCode) => {
    const { audit, jobs, service } = setup();
    jobs.push({
      id: `gateway-${status}`,
      requestId: RETRY_ID,
      bigBagId: 'bag-1',
      printerId: 'machine-printer',
      channel: 'gateway',
      status,
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    let rejection: unknown;
    try {
      await service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(ConflictException);
    expect((rejection as ConflictException).getResponse()).toMatchObject({ code: expectedCode });
    expect(jobs).toHaveLength(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('locks the Big-Bag before classifying an intent as initial or repeated', async () => {
    const { service, tx } = setup();

    await service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID });

    const rawCalls = tx.$queryRaw.mock.calls as Array<[{ strings?: string[] }]>;
    const lockCall = rawCalls.find(([query]) => query.strings?.join('').includes('FOR UPDATE'));
    if (!lockCall?.[0]?.strings) throw new Error('Expected a Big-Bag row lock query.');
    expect(lockCall[0].strings.join('')).toContain('FROM "big_bag_units"');
    expect(tx.$queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      tx.bigBagLabelPrintJob.findFirst.mock.invocationCallOrder[0],
    );
  });

  // pg_advisory_xact_lock() returns void, which $queryRaw cannot deserialize (Prisma P2010).
  // Every other advisory lock in this codebase casts the result; without it the whole intent
  // transaction dies and the warehouse only ever sees "Internal server error".
  it('selects a deserialisable column from the advisory lock', async () => {
    const { service, tx } = setup();

    await service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID });

    const rawCalls = tx.$queryRaw.mock.calls as Array<[{ strings?: string[] }]>;
    const advisory = rawCalls.find(([query]) =>
      query.strings?.join('').includes('pg_advisory_xact_lock'),
    );
    if (!advisory?.[0]?.strings) throw new Error('Expected an advisory lock query.');
    expect(advisory[0].strings.join('')).toContain('::text AS "lock"');
  });

  it('rejects a request-id replay for a different bag or channel', async () => {
    const { jobs, service } = setup();
    jobs.push({
      id: 'physical-job',
      requestId: REQUEST_ID,
      bigBagId: 'bag-1',
      printerId: 'machine-printer',
      channel: 'gateway',
      status: 'submitted',
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: 'command-1',
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(service.record(ACTOR, 'bag-1', { requestId: REQUEST_ID })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('fails closed when the Big-Bag or its QR identity is missing', async () => {
    const missing = setup();
    missing.prisma.bigBagUnit.findUnique.mockResolvedValue(null);
    await expect(missing.service.preview('missing')).rejects.toBeInstanceOf(NotFoundException);

    const noQr = setup();
    noQr.prisma.bigBagUnit.findUnique.mockResolvedValue({ ...noQr.bag, scanToken: null });
    await expect(noQr.service.preview('bag-1')).rejects.toBeInstanceOf(ConflictException);
  });
});
