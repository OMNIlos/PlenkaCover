import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { WarehouseBigBagPrintService } from './warehouse-bigbag-print.service';

const actor = { userId: 'warehouse-1', role: 'warehouse' as const };
const requestId = '11111111-1111-4111-8111-111111111111';
const reprintRequestId = '22222222-2222-4222-8222-222222222222';
const qrCode = `bbt_${'a'.repeat(64)}`;
const now = new Date('2026-08-03T12:00:00.000Z');

function setup(
  options: {
    transport?: 'gateway' | 'mock';
    resultStatus?: 'printed' | 'submitted' | 'failed' | 'delivery_unknown';
    readiness?: 'ready' | 'missing_capability';
  } = {},
) {
  const jobs: any[] = [];
  const bag = {
    id: 'bag-1',
    code: 'BB-PVD-01',
    material: 'ПВД Первичное',
    scanToken: { token: qrCode },
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: bag.id }]),
    bigBagLabelPrintJob: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(jobs.find((job) => job.requestId === where.requestId) ?? null),
      ),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...jobs]
            .reverse()
            .find(
              (job) =>
                job.bigBagId === where.bigBagId &&
                (typeof where.status === 'string'
                  ? job.status === where.status
                  : where.status.in.includes(job.status)),
            ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: any) => {
        const job = {
          id: `job-${jobs.length + 1}`,
          gatewayCommandId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        jobs.push(job);
        return Promise.resolve(job);
      }),
      update: jest.fn(({ where, data }: any) => {
        const job = jobs.find((candidate) => candidate.id === where.id);
        Object.assign(job, data, { updatedAt: now });
        return Promise.resolve({ ...job });
      }),
    },
  };
  const prisma: any = {
    bigBagLabelPrintJob: tx.bigBagLabelPrintJob,
    bigBagUnit: {
      findUnique: jest.fn().mockResolvedValue(bag),
    },
    $transaction: jest.fn((work: (client: any) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const printer = {
    transport: options.transport ?? 'gateway',
    print: jest.fn().mockResolvedValue({
      jobId: 'physical-job-1',
      printerId: 'printer-1',
      status: options.resultStatus ?? 'submitted',
      gatewayCommandId: 'gateway-command-1',
      ...(options.resultStatus === 'failed' || options.resultStatus === 'delivery_unknown'
        ? { failureReason: 'transport outcome' }
        : {}),
    }),
  };
  const printerDiscovery = {
    listPrinters: jest.fn().mockResolvedValue([
      {
        id: 'printer-1',
        code: 'PRINTER-1',
        label: 'MERTECH TLP4',
        post: { id: 'post-1', code: 'POST-1', name: 'Склад' },
        status: 'ready',
        ready: true,
        unavailableReason: null,
      },
    ]),
  };
  const deviceReadiness = {
    check: jest.fn(async (postId: string, workflow: string) =>
      options.readiness === 'missing_capability'
        ? {
            ready: false,
            code: 'POST_CAPABILITY_MISSING',
            message: 'Агент поста не поддерживает требуемую физическую операцию.',
            workflow,
            post: { id: postId, code: 'POST-1' },
            devices: [],
          }
        : {
            ready: workflow === 'warehouse.big-bag.print',
            code: workflow === 'warehouse.big-bag.print' ? 'READY' : 'POST_CAPABILITY_MISSING',
            message:
              workflow === 'warehouse.big-bag.print'
                ? 'Физический пост готов.'
                : 'Неверная физическая операция.',
            workflow,
            post: { id: postId, code: 'POST-1' },
            devices:
              workflow === 'warehouse.big-bag.print'
                ? [{ id: 'printer-1', kind: 'printer', status: 'ready' }]
                : [],
          },
    ),
  };
  const service = new WarehouseBigBagPrintService(
    prisma,
    audit as never,
    printer as never,
    printerDiscovery as never,
    deviceReadiness as never,
  );
  return { audit, jobs, printer, printerDiscovery, prisma, service, tx };
}

describe('WarehouseBigBagPrintService', () => {
  it('marks a generic printer unavailable when exact Big-Bag readiness rejects its post', async () => {
    const { service } = setup({ readiness: 'missing_capability' });

    await expect(service.listPrinters(now)).resolves.toEqual([
      expect.objectContaining({
        id: 'printer-1',
        ready: false,
        unavailableReason: 'Агент поста не поддерживает требуемую физическую операцию.',
      }),
    ]);
  });

  it('refuses physical print when exact Big-Bag readiness rejects a generically ready printer', async () => {
    const { jobs, printer, service } = setup({ readiness: 'missing_capability' });

    await expect(
      service.print(actor, 'bag-1', { requestId, printerId: 'printer-1' }, now),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PRINTER_UNAVAILABLE',
        message: 'Агент поста не поддерживает требуемую физическую операцию.',
      },
    });
    expect(printer.print).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('submits the opaque QR label through the ready Gateway printer', async () => {
    const { audit, printer, service } = setup();

    const result = await service.print(actor, 'bag-1', { requestId, printerId: 'printer-1' }, now);

    expect(printer.print).toHaveBeenCalledWith(
      {
        deviceId: 'printer-1',
        expectedPostId: 'post-1',
        expectedKind: 'printer',
      },
      {
        kind: 'big_bag_label',
        destination: 'warehouse',
        bigBagCode: 'BB-PVD-01',
        material: 'ПВД Первичное',
        qrCode,
      },
    );
    expect(result).toEqual(
      expect.objectContaining({
        requestId,
        bigBagId: 'bag-1',
        printerId: 'printer-1',
        status: 'submitted',
        gatewayCommandId: 'gateway-command-1',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:bigbag_label_print_requested' }),
      expect.anything(),
    );
  });

  it('replays one request id without submitting a second physical print', async () => {
    const { printer, service } = setup();
    const command = { requestId, printerId: 'printer-1' };

    const first = await service.print(actor, 'bag-1', command, now);
    const replay = await service.print(actor, 'bag-1', command, now);

    expect(replay).toEqual(first);
    expect(printer.print).toHaveBeenCalledTimes(1);
  });

  it('requires a reason after a submitted label and links the reprint', async () => {
    const { audit, jobs, service } = setup();
    await service.print(actor, 'bag-1', { requestId, printerId: 'printer-1' }, now);

    await expect(
      service.print(actor, 'bag-1', { requestId: reprintRequestId, printerId: 'printer-1' }, now),
    ).rejects.toBeInstanceOf(ConflictException);

    await service.print(
      actor,
      'bag-1',
      {
        requestId: reprintRequestId,
        printerId: 'printer-1',
        reason: 'Этикетка повреждена',
      },
      now,
    );

    expect(jobs[1]).toEqual(
      expect.objectContaining({
        reason: 'Этикетка повреждена',
        replacesPrintJobId: jobs[0].id,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_label_reprint_requested',
        reason: 'Этикетка повреждена',
      }),
      expect.anything(),
    );
  });

  it('treats a prior browser print intent as a reprint boundary for Gateway printing', async () => {
    const { jobs, printer, service } = setup();
    jobs.push({
      id: 'browser-intent-1',
      requestId,
      bigBagId: 'bag-1',
      printerId: null,
      channel: 'browser_system_print',
      status: 'intent_recorded',
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      service.print(actor, 'bag-1', {
        requestId: reprintRequestId,
        printerId: 'printer-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(printer.print).not.toHaveBeenCalled();
  });

  it('does not claim physical success from the mock adapter', async () => {
    const { printer, service } = setup({ transport: 'mock' });

    await expect(
      service.print(actor, 'bag-1', { requestId, printerId: 'printer-1' }, now),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(printer.print).not.toHaveBeenCalled();
  });

  it.each([
    ['delivery_unknown', 'uncertain'],
    ['failed', 'failed'],
  ] as const)(
    'persists an honest %s printer result as %s',
    async (resultStatus, expectedStatus) => {
      const { jobs, service } = setup({ resultStatus });

      await expect(
        service.print(actor, 'bag-1', { requestId, printerId: 'printer-1' }, now),
      ).resolves.toEqual(expect.objectContaining({ status: expectedStatus }));
      expect(jobs[0].status).toBe(expectedStatus);
    },
  );
});
