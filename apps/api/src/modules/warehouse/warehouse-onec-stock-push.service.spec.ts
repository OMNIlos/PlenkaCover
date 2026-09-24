import { createHash } from 'node:crypto';
import { WarehouseOneCStockPushService } from './warehouse-onec-stock-push.service';

const OPERATION_KEY = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';
const SECOND_OPERATION_KEY = 'd45d81d9-e466-4c0a-9de1-7f416273e446';
const THIRD_OPERATION_KEY = '1f7e5618-59ef-4d69-b1a1-bf9501d73655';
const actor = { userId: 'warehouse-user', role: 'warehouse' as const };
const FIRST_REVISION = 1;

type StoredOperation = {
  id: string;
  operationKey: string;
  actorId: string;
  snapshotHash: string;
  status: string;
  safeResult: unknown;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

function setup(
  initialMaterials = [
    { materialId: 'rm-z', actualQty: 0.1, unit: 'кг', revision: FIRST_REVISION },
    { materialId: 'rm-a', actualQty: 0.2, unit: 'кг', revision: FIRST_REVISION },
  ],
) {
  let materials = initialMaterials;
  const definitions: Array<{ id: string; name: string }> = [];
  const operations: StoredOperation[] = [];
  const operationModel = {
    findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => {
      if (where.operationKey) {
        return operations.find((row) => row.operationKey === where.operationKey) ?? null;
      }
      return operations.find((row) => row.snapshotHash === where.snapshotHash) ?? null;
    }),
    createMany: jest.fn(
      async ({
        data,
      }: {
        data: Omit<
          StoredOperation,
          'id' | 'safeResult' | 'createdAt' | 'updatedAt' | 'completedAt'
        >;
      }) => {
        if (
          operations.some(
            (row) =>
              row.operationKey === data.operationKey || row.snapshotHash === data.snapshotHash,
          )
        ) {
          return { count: 0 };
        }
        operations.push({
          id: `push-${operations.length + 1}`,
          ...data,
          safeResult: null,
          createdAt: new Date('2026-07-17T12:00:00.000Z'),
          updatedAt: new Date('2026-07-17T12:00:00.000Z'),
          completedAt: null,
        });
        return { count: 1 };
      },
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<StoredOperation>;
      }) => {
        const row = operations.find(
          (candidate) => candidate.id === where.id && candidate.status === where.status,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date('2026-07-17T12:01:00.000Z') });
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    rawMaterialDefinition: {
      create: jest.fn(async ({ data }: { data: { id: string; name: string } }) => {
        definitions.push(data);
        return data;
      }),
    },
    rawMaterialStock: {
      findMany: jest.fn(async () => materials),
    },
    oneCStockPushOperation: operationModel,
  };
  const onecImport = {
    stockPushReadiness: jest.fn().mockResolvedValue({
      writeReady: true,
      readinessCode: 'ready',
      readinessMessage: 'Демо-1С готова к тестовой записи.',
    }),
    pushStock: jest.fn().mockImplementation(async (_actor, items) => ({
      accepted: true,
      mode: 'http',
      documentCreated: true,
      count: items.length,
      ref: 'КП00-000003',
    })),
  };
  const service = new WarehouseOneCStockPushService(prisma as never, onecImport as never);
  return {
    service,
    prisma,
    onecImport,
    operations,
    definitions,
    setMaterials(next: typeof materials) {
      materials = next;
    },
  };
}

describe('WarehouseOneCStockPushService', () => {
  it('returns canonical stock items and their deterministic SHA-256 preview', async () => {
    const { service } = setup();

    const preview = await service.preview();

    const items = [
      { materialId: 'rm-a', qty: 0.2, unit: 'кг' },
      { materialId: 'rm-z', qty: 0.1, unit: 'кг' },
    ];
    const versionedItems = items.map((item) => ({
      ...item,
      revision: FIRST_REVISION,
    }));
    expect(preview).toEqual({
      items,
      snapshotHash: createHash('sha256').update(JSON.stringify(versionedItems)).digest('hex'),
      count: 2,
      totalQty: 0.3,
      writeReady: true,
      readinessCode: 'ready',
      readinessMessage: 'Демо-1С готова к тестовой записи.',
    });
  });

  it('does not include a catalog-only definition in preview, hash, items, or push', async () => {
    const { service, prisma, onecImport, definitions } = setup();
    const beforeCreate = await service.preview();

    await prisma.rawMaterialDefinition.create({
      data: { id: 'definition-catalog-only', name: 'Новый компонент' },
    });
    const afterCreate = await service.preview();
    await service.push(actor, {
      operationKey: OPERATION_KEY,
      snapshotHash: beforeCreate.snapshotHash,
    });

    expect(definitions).toEqual([{ id: 'definition-catalog-only', name: 'Новый компонент' }]);
    expect(afterCreate).toEqual(beforeCreate);
    expect(prisma.rawMaterialStock.findMany).toHaveBeenCalledTimes(3);
    expect(onecImport.pushStock).toHaveBeenCalledWith(actor, beforeCreate.items);
  });

  it('reports deterministic not-ready state and never creates a durable claim', async () => {
    const { service, prisma, onecImport } = setup();
    onecImport.stockPushReadiness.mockResolvedValue({
      writeReady: false,
      readinessCode: 'write_disabled',
      readinessMessage: 'Запись в демо-1С выключена на VPS.',
    });
    const preview = await service.preview();

    expect(preview).toMatchObject({
      writeReady: false,
      readinessCode: 'write_disabled',
    });
    await expect(
      service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: preview.snapshotHash }),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'ONEC_STOCK_PUSH_NOT_READY' }),
    });
    expect(prisma.oneCStockPushOperation.createMany).not.toHaveBeenCalled();
    expect(onecImport.pushStock).not.toHaveBeenCalled();
  });

  it('rejects an empty stock snapshot before claiming or calling 1С', async () => {
    const { service, prisma, onecImport } = setup([]);
    const snapshotHash = createHash('sha256').update('[]').digest('hex');

    await expect(
      service.push(actor, { operationKey: OPERATION_KEY, snapshotHash }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.oneCStockPushOperation.createMany).not.toHaveBeenCalled();
    expect(onecImport.pushStock).not.toHaveBeenCalled();
  });

  it('rejects a stale preview hash before claiming or calling 1С', async () => {
    const { service, prisma, onecImport } = setup();

    await expect(
      service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.oneCStockPushOperation.createMany).not.toHaveBeenCalled();
    expect(onecImport.pushStock).not.toHaveBeenCalled();
  });

  it('claims the canonical snapshot, posts once, and stores only a safe successful result', async () => {
    const { service, onecImport, operations } = setup();
    const preview = await service.preview();

    const result = await service.push(actor, {
      operationKey: OPERATION_KEY,
      snapshotHash: preview.snapshotHash,
    });

    expect(onecImport.pushStock).toHaveBeenCalledTimes(1);
    expect(onecImport.pushStock).toHaveBeenCalledWith(actor, preview.items);
    expect(result).toMatchObject({
      operationKey: OPERATION_KEY,
      snapshotHash: preview.snapshotHash,
      pushed: 2,
      totalQty: 0.3,
      replayed: false,
      ack: { mode: 'http', documentCreated: true, ref: 'КП00-000003' },
    });
    expect(operations[0]).toMatchObject({
      actorId: actor.userId,
      status: 'succeeded',
      safeResult: expect.objectContaining({ replayed: false }),
    });
    expect(JSON.stringify(operations[0].safeResult)).not.toMatch(/password|authorization|raw/i);
  });

  it('replays a succeeded snapshot for the same actor even with a second operation key', async () => {
    const { service, onecImport } = setup();
    const preview = await service.preview();
    const first = await service.push(actor, {
      operationKey: OPERATION_KEY,
      snapshotHash: preview.snapshotHash,
    });

    const replay = await service.push(actor, {
      operationKey: SECOND_OPERATION_KEY,
      snapshotHash: preview.snapshotHash,
    });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(onecImport.pushStock).toHaveBeenCalledTimes(1);
  });

  it('treats A → B → A as three revisions while deduplicating each unchanged revision', async () => {
    const { service, setMaterials, onecImport } = setup([
      { materialId: 'rm-a', actualQty: 1, unit: 'кг', revision: FIRST_REVISION },
    ]);
    const first = await service.preview();
    await service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: first.snapshotHash });

    setMaterials([
      {
        materialId: 'rm-a',
        actualQty: 2,
        unit: 'кг',
        revision: 2,
      },
    ]);
    const second = await service.preview();
    await service.push(actor, {
      operationKey: SECOND_OPERATION_KEY,
      snapshotHash: second.snapshotHash,
    });

    setMaterials([
      {
        materialId: 'rm-a',
        actualQty: 1,
        unit: 'кг',
        revision: 3,
      },
    ]);
    const third = await service.preview();

    expect(new Set([first.snapshotHash, second.snapshotHash, third.snapshotHash])).toHaveProperty(
      'size',
      3,
    );
    await service.push(actor, {
      operationKey: THIRD_OPERATION_KEY,
      snapshotHash: third.snapshotHash,
    });
    expect(onecImport.pushStock).toHaveBeenCalledTimes(3);
  });

  it('rejects the same succeeded snapshot for a different actor', async () => {
    const { service, onecImport } = setup();
    const preview = await service.preview();
    await service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: preview.snapshotHash });

    await expect(
      service.push(
        { userId: 'other-warehouse-user', role: 'warehouse' },
        { operationKey: SECOND_OPERATION_KEY, snapshotHash: preview.snapshotHash },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(onecImport.pushStock).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an operation key after the warehouse snapshot changes', async () => {
    const { service, setMaterials, onecImport } = setup();
    const first = await service.preview();
    await service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: first.snapshotHash });
    setMaterials([
      {
        materialId: 'rm-a',
        actualQty: 7,
        unit: 'кг',
        revision: 4,
      },
    ]);
    const second = await service.preview();

    await expect(
      service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: second.snapshotHash }),
    ).rejects.toMatchObject({ status: 409 });
    expect(onecImport.pushStock).toHaveBeenCalledTimes(1);
  });

  it.each(['in_progress', 'outcome_unknown'])(
    'never retries a %s snapshot and returns reconciliation guidance',
    async (status) => {
      const { service, operations, onecImport } = setup();
      const preview = await service.preview();
      operations.push({
        id: 'existing',
        operationKey: OPERATION_KEY,
        actorId: actor.userId,
        snapshotHash: preview.snapshotHash,
        status,
        safeResult: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      });

      await expect(
        service.push(actor, {
          operationKey: SECOND_OPERATION_KEY,
          snapshotHash: preview.snapshotHash,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ message: expect.stringMatching(/1С.*свер/i) }),
      });
      expect(onecImport.pushStock).not.toHaveBeenCalled();
    },
  );

  it('marks a failed delivery outcome unknown and blocks every automatic retry', async () => {
    const { service, operations, onecImport } = setup();
    const preview = await service.preview();
    onecImport.pushStock.mockRejectedValueOnce(new Error('transport closed'));

    await expect(
      service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: preview.snapshotHash }),
    ).rejects.toThrow(/1С.*свер/i);
    expect(operations[0].status).toBe('outcome_unknown');

    await expect(
      service.push(actor, {
        operationKey: SECOND_OPERATION_KEY,
        snapshotHash: preview.snapshotHash,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(onecImport.pushStock).toHaveBeenCalledTimes(1);
  });

  it('fails closed with reconciliation guidance when a succeeded replay result is malformed', async () => {
    const { service, operations, onecImport } = setup();
    const preview = await service.preview();
    operations.push({
      id: 'malformed',
      operationKey: OPERATION_KEY,
      actorId: actor.userId,
      snapshotHash: preview.snapshotHash,
      status: 'succeeded',
      safeResult: { operationKey: OPERATION_KEY, snapshotHash: preview.snapshotHash },
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    });

    await expect(
      service.push(actor, { operationKey: OPERATION_KEY, snapshotHash: preview.snapshotHash }),
    ).rejects.toMatchObject({ status: 409 });
    expect(onecImport.pushStock).not.toHaveBeenCalled();
  });
});
