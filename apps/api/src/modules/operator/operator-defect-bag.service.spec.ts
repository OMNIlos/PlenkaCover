import { Prisma } from '@prisma/client';
import { OperatorDefectBagService } from './operator-defect-bag.service';

const actor = { userId: 'operator-a', role: 'operator' as const };
const session = {
  id: 'session-a',
  operatorId: 'operator-a',
  postId: 'post-a',
  shiftId: 'shift-a',
  status: 'active',
  startedAt: new Date('2026-09-06T08:00:00.000Z'),
};
const token = `bbt_${'a'.repeat(64)}`;

function setup() {
  const bags: any[] = [];
  const jobs: any[] = [];
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ sequence: BigInt(bags.length + 1) }])),
    post: {
      findUnique: jest.fn().mockResolvedValue({ code: 'POST-A' }),
    },
    defectBag: {
      findUnique: jest.fn(({ where }: any) => {
        const found = bags.find(
          (bag) =>
            (where.weighOperationKey && bag?.weighOperationKey === where.weighOperationKey) ||
            (where.postSessionId && bag?.postSessionId === where.postSessionId) ||
            (where.id && bag?.id === where.id),
        );
        return Promise.resolve(
          found ? { ...found, scanToken: { defectBagId: found.id, token } } : null,
        );
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          bags
            .filter(
              (bag) =>
                bag.postSessionId === where.postSessionId && (!where.id || bag.id === where.id),
            )
            .map((bag) => ({ ...bag, scanToken: { defectBagId: bag.id, token } })),
        ),
      ),
      create: jest.fn(({ data }: any) => {
        const bag = {
          id: bags.length === 0 ? 'defect-bag-a' : `defect-bag-${bags.length + 1}`,
          ...data,
          weighedAt: new Date('2026-09-06T17:00:00.000Z'),
          createdAt: new Date('2026-09-06T17:00:00.000Z'),
          updatedAt: new Date('2026-09-06T17:00:00.000Z'),
        };
        bags.push(bag);
        return Promise.resolve({ ...bag, scanToken: { defectBagId: bag.id, token } });
      }),
      update: jest.fn(({ where, data }: any) => {
        const index = bags.findIndex((bag) => bag.id === where.id);
        bags[index] = { ...bags[index], ...data };
        return Promise.resolve(bags[index]);
      }),
    },
    defectRecord: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ weightCapture: { netKg: 2.5 } }, { weightCapture: { netKg: null } }]),
    },
    defectBagLabelPrintJob: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(jobs.find((job) => job.operationKey === where.operationKey) ?? null),
      ),
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          [...jobs]
            .reverse()
            .find((job) => !where?.defectBagId || job.defectBagId === where.defectBagId) ?? null,
        ),
      ),
      create: jest.fn(({ data }: any) => {
        const job = {
          id: `defect-print-${jobs.length + 1}`,
          ...data,
          createdAt: new Date(),
          completedAt: null,
          gatewayCommandId: null,
          failureReason: null,
        };
        jobs.push(job);
        return Promise.resolve(job);
      }),
      update: jest.fn(({ where, data }: any) => {
        const index = jobs.findIndex((job) => job.id === where.id);
        jobs[index] = { ...jobs[index], ...data };
        return Promise.resolve(jobs[index]);
      }),
      updateMany: jest.fn(({ where, data }: any) => {
        const index = jobs.findIndex(
          (job) =>
            job.id === where.id &&
            (!where.status || job.status === where.status) &&
            (!where.leaseToken || job.leaseToken === where.leaseToken),
        );
        if (index < 0) return Promise.resolve({ count: 0 });
        jobs[index] = { ...jobs[index], ...data };
        return Promise.resolve({ count: 1 });
      }),
    },
  } as any;
  const prisma = {
    ...tx,
    $transaction: jest.fn((callback: (client: any) => unknown) => callback(tx)),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-a' }) } as any;
  const sessions = {
    requireActive: jest.fn().mockResolvedValue(session),
    lockActiveInTransaction: jest.fn().mockResolvedValue(session),
  } as any;
  const bindings = {
    resolve: jest.fn((_postId: string, kind: string) =>
      Promise.resolve({
        id: `${kind}-a`,
        postId: 'post-a',
        kind,
        status: 'ready',
        isEnabled: true,
      }),
    ),
  } as any;
  const scale = {
    read: jest.fn().mockResolvedValue({
      deviceId: 'scale-a',
      status: 'ready',
      stable: true,
      grossKg: 0,
    }),
  } as any;
  const printer = {
    print: jest.fn().mockResolvedValue({
      jobId: 'gateway-job-a',
      printerId: 'printer-a',
      status: 'printed',
    }),
  } as any;
  const service = new OperatorDefectBagService(prisma, audit, sessions, bindings, printer);

  return {
    service,
    prisma,
    tx,
    audit,
    sessions,
    bindings,
    scale,
    printer,
    jobs,
    getBag: () => bags[0],
    bags,
  };
}

describe('OperatorDefectBagService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-06T17:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records zero defects without a QR token or a printer job', async () => {
    const scene = setup();
    const request = {
      operationKey: '00000000-0000-4000-8000-000000000001',
      weightKg: 0,
    };
    const first = await scene.service.weigh(actor, request);

    expect(first).toMatchObject({ weightKg: 0, defectType: null, status: 'weighed' });
    expect(await scene.service.weigh(actor, request)).toEqual(first);
    expect(scene.tx.defectBag.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scanToken: undefined }) }),
    );
    await expect(
      scene.service.print(actor, { operationKey: '00000000-0000-4000-8000-000000000002' }),
    ).rejects.toMatchObject({ response: { code: 'DEFECT_BAG_ZERO_WEIGHT_NO_PRINT' } });
    expect(scene.jobs).toHaveLength(0);
    expect(scene.printer.print).not.toHaveBeenCalled();
  });

  it('still requires a defect type for a positive weight', async () => {
    const scene = setup();
    await expect(
      scene.service.weigh(actor, {
        operationKey: '00000000-0000-4000-8000-000000000003',
        weightKg: 12.4,
      }),
    ).rejects.toMatchObject({ response: { code: 'DEFECT_BAG_TYPE_INVALID' } });
    expect(scene.tx.defectBag.create).not.toHaveBeenCalled();
  });

  it('keeps two identical bags separate and replays each operation without duplicates', async () => {
    const scene = setup();
    const firstRequest = {
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      weightKg: 12.4,
      defectType: 'secondary' as const,
    };
    const secondRequest = { ...firstRequest, operationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const first = await scene.service.weigh(actor, firstRequest);
    const second = await scene.service.weigh(actor, secondRequest);
    expect(second.id).not.toBe(first.id);
    expect(second.code).not.toBe(first.code);
    expect(await scene.service.weigh(actor, firstRequest)).toEqual(first);
    expect(await scene.service.weigh(actor, secondRequest)).toEqual(second);
    expect(scene.bags).toHaveLength(2);
    expect(scene.audit.record).toHaveBeenCalledTimes(2);
  });

  it('prints the selected session bag and rejects ambiguous or foreign targets', async () => {
    const scene = setup();
    const first = await scene.service.weigh(actor, {
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      weightKg: 3,
      defectType: 'secondary',
    });
    const second = await scene.service.weigh(actor, {
      operationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      weightKg: 5,
      defectType: 'primary',
    });
    const operationKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await expect(scene.service.print(actor, { operationKey })).rejects.toMatchObject({
      response: { code: 'DEFECT_BAG_SELECTION_REQUIRED' },
    });
    await expect(
      scene.service.print(actor, { operationKey, defectBagId: 'foreign-bag' } as any),
    ).rejects.toMatchObject({ response: { code: 'DEFECT_BAG_REQUIRED' } });
    const printed = await scene.service.print(actor, {
      operationKey,
      defectBagId: second.id,
    } as any);
    expect(printed).toMatchObject({ id: second.id, status: 'ready_for_warehouse' });
    expect(scene.bags.find((bag) => bag.id === first.id).status).toBe('weighed');
    expect(scene.jobs[0].defectBagId).toBe(second.id);
  });

  it('creates one safe session bag from manual input and replays the same fact', async () => {
    const scene = setup();

    const first = await scene.service.weigh(actor, {
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      weightKg: 12.4,
      defectType: 'secondary',
    });
    const replay = await scene.service.weigh(actor, {
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      weightKg: 12.4,
      defectType: 'secondary',
    });

    expect(first).toEqual({
      id: 'defect-bag-a',
      code: 'DEF-20260906-POST-A-000001',
      status: 'weighed',
      defectType: 'secondary',
      weightKg: 12.4,
      recordedDefectKg: 2.5,
      differenceKg: 9.9,
      labelState: 'not_printed',
      weighedAt: '2026-09-06T17:00:00.000Z',
    });
    expect(replay).toEqual(first);
    expect(scene.scale.read).not.toHaveBeenCalled();
    expect(scene.bindings.resolve).not.toHaveBeenCalled();
    expect(scene.tx.defectBag.create).toHaveBeenCalledTimes(1);
    expect(scene.tx.defectBag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        weightKg: 12.4,
        defectType: 'secondary',
        captureChannel: 'operator_manual',
        scaleDeviceId: null,
        scaleStatus: null,
        scaleStable: null,
      }),
    });
    expect(scene.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          captureChannel: 'operator_manual',
          defectType: 'secondary',
        }),
      }),
      scene.tx,
    );
    expect(JSON.stringify(first)).not.toContain('bbt_');
    expect(JSON.stringify(scene.audit.record.mock.calls)).not.toContain('bbt_');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 10_001])(
    'rejects an invalid manual weight without creating a bag: %s',
    async (weightKg) => {
      const scene = setup();

      await expect(
        scene.service.weigh(actor, {
          operationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          weightKg,
          defectType: 'secondary',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DEFECT_BAG_WEIGHT_INVALID' }),
      });
      expect(scene.tx.defectBag.create).not.toHaveBeenCalled();
    },
  );

  it('rejects replaying an operation key with a different manual weight', async () => {
    const scene = setup();
    const operationKey = 'b0000000-0000-4000-8000-000000000002';
    await scene.service.weigh(actor, { operationKey, weightKg: 12.4, defectType: 'secondary' });

    await expect(
      scene.service.weigh(actor, { operationKey, weightKg: 12.5, defectType: 'secondary' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_OPERATION_KEY_REUSED' }),
    });
  });

  it('rejects replaying an operation key with a different defect type', async () => {
    const scene = setup();
    const operationKey = 'b0000000-0000-4000-8000-000000000003';
    await scene.service.weigh(actor, { operationKey, weightKg: 12.4, defectType: 'secondary' });

    await expect(
      scene.service.weigh(actor, { operationKey, weightKg: 12.4, defectType: 'aika' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_OPERATION_KEY_REUSED' }),
    });
  });

  it('rejects an invalid recorded-defect aggregate before persistence', async () => {
    const scene = setup();
    scene.tx.defectRecord.findMany.mockResolvedValue([
      { weightCapture: { netKg: 5_001 } },
      { weightCapture: { netKg: 5_000 } },
    ]);

    await expect(
      scene.service.weigh(actor, {
        operationKey: 'b0000000-0000-4000-8000-000000000001',
        weightKg: 12.4,
        defectType: 'secondary',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_RECORDED_WEIGHT_INVALID' }),
    });
    expect(scene.tx.defectBag.create).not.toHaveBeenCalled();
  });

  it('submits the private token once and exposes only a safe ready projection', async () => {
    const scene = setup();
    await scene.service.weigh(actor, {
      operationKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      weightKg: 12.4,
      defectType: 'aika',
    });

    const first = await scene.service.print(actor, {
      operationKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const replay = await scene.service.print(actor, {
      operationKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });

    expect(first.status).toBe('ready_for_warehouse');
    expect(first.labelState).toBe('submitted');
    expect(replay).toEqual(first);
    expect(scene.printer.print).toHaveBeenCalledTimes(1);
    expect(scene.printer.print).toHaveBeenCalledWith(
      { deviceId: 'printer-a', expectedPostId: 'post-a', expectedKind: 'printer' },
      {
        kind: 'big_bag_label',
        destination: 'operator',
        bigBagCode: 'DEF-20260906-POST-A-000001',
        material: 'БРАК · Айка · 12.400 кг',
        qrCode: token,
      },
    );
    expect(scene.jobs[0]).toMatchObject({
      status: 'submitted',
      leaseToken: expect.any(String),
      leaseExpiresAt: expect.any(Date),
    });
    expect(JSON.stringify(first)).not.toContain(token);
    expect(JSON.stringify(scene.audit.record.mock.calls)).not.toContain(token);
  });

  it('maps a concurrent print UUID collision to the stable reuse conflict', async () => {
    const scene = setup();
    scene.prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique conflict', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      scene.service.print(actor, {
        operationKey: 'd0000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_OPERATION_KEY_REUSED' }),
    });
  });

  it('keeps a failed print unready and requires a reason for the next physical attempt', async () => {
    const scene = setup();
    await scene.service.weigh(actor, {
      operationKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      weightKg: 12.4,
      defectType: 'primary',
    });
    scene.printer.print.mockResolvedValueOnce({
      jobId: 'failed-job',
      gatewayCommandId: 'gateway-command-failed',
      printerId: 'printer-a',
      status: 'failed',
    });

    await expect(
      scene.service.print(actor, {
        operationKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_PRINT_FAILED' }),
    });
    expect(scene.getBag().status).toBe('weighed');
    expect(scene.jobs[0].gatewayCommandId).toBe('gateway-command-failed');

    await expect(
      scene.service.print(actor, {
        operationKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_REPRINT_REASON_REQUIRED' }),
    });

    await expect(
      scene.service.print(actor, {
        operationKey: '22222222-2222-4222-8222-222222222222',
        reason: 'Замятие этикетки',
      }),
    ).resolves.toMatchObject({ status: 'ready_for_warehouse' });
    expect(scene.printer.print).toHaveBeenCalledTimes(2);
  });

  it.each(['delivery_unknown', 'unexpected'])('%s never makes the bag ready', async (status) => {
    const scene = setup();
    await scene.service.weigh(actor, {
      operationKey: '33333333-3333-4333-8333-333333333333',
      weightKg: 12.4,
      defectType: 'secondary',
    });
    scene.printer.print.mockResolvedValue({
      jobId: 'unknown-job',
      gatewayCommandId: 'gateway-command-unknown',
      printerId: 'printer-a',
      status,
    });

    await expect(
      scene.service.print(actor, {
        operationKey: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(scene.getBag().status).toBe('weighed');
    expect(scene.jobs[0].status).toBe('delivery_unknown');
    expect(scene.jobs[0].gatewayCommandId).toBe('gateway-command-unknown');

    await expect(
      scene.service.print(actor, {
        operationKey: '55555555-5555-4555-8555-555555555555',
        reason: 'Повтор после обрыва связи',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(scene.printer.print).toHaveBeenCalledTimes(1);
  });
});
