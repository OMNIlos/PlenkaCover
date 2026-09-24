import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WarehouseDefectBagService } from './warehouse-defect-bag.service';

const actor = {
  userId: 'warehouse-a',
  role: 'warehouse' as const,
  capabilities: [] as const,
  sessionId: 'browser-session-a',
  sessionPurpose: 'full' as const,
};
const readyToken = `bbt_${'a'.repeat(64)}`;
const receivedToken = `bbt_${'b'.repeat(64)}`;

function bag(id: string, status: string) {
  return {
    id,
    code: `DEF-${id}`,
    status,
    defectType: id === 'ready' ? 'secondary' : 'aika',
    weightKg: id === 'ready' ? 4.2 : 3.1,
    recordedDefectKg: 4,
    differenceKg: 0.2,
    weighedAt: new Date('2026-09-06T17:00:00.000Z'),
    postSession: {
      operator: { displayName: 'Оператор А' },
      post: { code: 'POST-1', name: 'Станок 1' },
      shift: { label: 'Смена 1' },
    },
    scanToken: { token: 'FORBIDDEN_QR' },
  };
}

function setup() {
  const bags = [bag('ready', 'ready_for_warehouse'), bag('received', 'received')];
  const movements: any[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    defectBag: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(bags.filter((item) => item.status === where.status)),
      ),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(bags.find((item) => item.id === where.id) ?? null),
      ),
      update: jest.fn(({ where, data }: any) => {
        const item = bags.find((candidate) => candidate.id === where.id)!;
        Object.assign(item, data);
        return Promise.resolve(item);
      }),
    },
    defectBagScanToken: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.token === readyToken) return Promise.resolve({ defectBagId: 'ready' });
        if (where.token === receivedToken) return Promise.resolve({ defectBagId: 'received' });
        return Promise.resolve(null);
      }),
    },
    defectBagMovement: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          movements.find((movement) => movement.operationKey === where.operationKey) ?? null,
        ),
      ),
      create: jest.fn(({ data }: any) => {
        const movement = { id: `movement-${movements.length + 1}`, ...data, createdAt: new Date() };
        movements.push(movement);
        return Promise.resolve(movement);
      }),
    },
  } as any;
  const prisma = {
    ...tx,
    $transaction: jest.fn((callback: (client: any) => unknown) => callback(tx)),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-a' }) } as any;
  const browserSession = {
    resolve: jest.fn().mockResolvedValue({
      session: { id: 'browser-session-a' },
    }),
  } as any;
  const service = new WarehouseDefectBagService(prisma, audit, browserSession);
  return { service, prisma, tx, audit, browserSession, bags, movements };
}

describe('WarehouseDefectBagService', () => {
  it('returns separate safe receiving and shipping queues', async () => {
    const { service } = setup();

    const receiving = await service.list('receiving');
    const shipping = await service.list('shipping');

    expect(receiving).toEqual([
      {
        id: 'ready',
        code: 'DEF-ready',
        status: 'ready_for_warehouse',
        defectType: 'secondary',
        weightKg: 4.2,
        operatorName: 'Оператор А',
        postCode: 'POST-1',
        postName: 'Станок 1',
        shiftLabel: 'Смена 1',
        weighedAt: '2026-09-06T17:00:00.000Z',
      },
    ]);
    expect(shipping).toEqual([expect.objectContaining({ id: 'received', status: 'received' })]);
    expect(JSON.stringify({ receiving, shipping })).not.toContain('FORBIDDEN');
  });

  it('receives then ships one exact scanned bag without inventory side effects', async () => {
    const { service, audit, browserSession, movements, bags } = setup();

    const received = await service.receive(actor, {
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      payload: readyToken,
    });
    const shipped = await service.ship(actor, {
      operationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      payload: readyToken,
    });

    expect(received).toMatchObject({ id: 'ready', status: 'received' });
    expect(shipped).toMatchObject({ id: 'ready', status: 'shipped' });
    expect(movements).toHaveLength(2);
    expect(movements.map(({ kind }) => kind)).toEqual(['receive', 'ship']);
    expect(bags[0].status).toBe('shipped');
    expect(browserSession.resolve).toHaveBeenCalledTimes(2);
    expect(movements).toEqual([
      expect.objectContaining({
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_browser_hid',
      }),
      expect.objectContaining({
        postId: null,
        deviceId: null,
        captureChannel: 'warehouse_browser_hid',
      }),
    ]);
    expect(audit.record.mock.calls.map((call: any[]) => call[0].type)).toEqual([
      'audit:defect_bag_received',
      'audit:defect_bag_shipped',
    ]);
    expect(audit.record.mock.calls.map((call: any[]) => call[0].detail.defectType)).toEqual([
      'secondary',
      'secondary',
    ]);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(readyToken);
    expect((service as any).inventory).toBeUndefined();
  });

  it('replays the same operation UUID without a duplicate movement', async () => {
    const { service, movements } = setup();
    const dto = {
      operationKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      payload: readyToken,
    };

    const first = await service.receive(actor, dto);
    const replay = await service.receive(actor, dto);

    expect(replay).toEqual(first);
    expect(movements).toHaveLength(1);
  });

  it.each([
    ['receive', receivedToken, 'DEFECT_BAG_NOT_READY_FOR_RECEIPT'],
    ['ship', readyToken, 'DEFECT_BAG_NOT_RECEIVED'],
  ] as const)('rejects an invalid %s transition', async (action, payload, code) => {
    const { service, movements } = setup();

    await expect(
      service[action](actor, {
        operationKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        payload,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
    expect(movements).toHaveLength(0);
  });

  it('rejects reuse of an operation UUID for a different movement', async () => {
    const { service } = setup();
    const operationKey = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await service.receive(actor, { operationKey, payload: readyToken });

    await expect(service.ship(actor, { operationKey, payload: readyToken })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_OPERATION_KEY_REUSED' }),
    });
  });

  it('maps a concurrent unique-key race to the stable operation reuse conflict', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique conflict', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.receive(actor, {
        operationKey: 'e0000000-0000-4000-8000-000000000001',
        payload: readyToken,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFECT_BAG_OPERATION_KEY_REUSED' }),
    });
  });

  it('requires an active full browser session before a HID scan mutation', async () => {
    const { service, browserSession, movements } = setup();
    browserSession.resolve.mockRejectedValue(new ConflictException('session unavailable'));

    await expect(
      service.receive(actor, {
        operationKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        payload: readyToken,
      }),
    ).rejects.toThrow('session unavailable');
    expect(movements).toHaveLength(0);
  });
});
