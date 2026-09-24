import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';

const SAFE_ROLL_FIELDS = ['facts', 'id', 'rollCode', 'warehouseStatus'] as const;
const SAFE_ROLL_FACT_FIELDS = [
  'actualThickness',
  'birka',
  'filmType',
  'plannedWeightKg',
  'spoolType',
] as const;
const FORBIDDEN_ROLL_FIELDS = new Set([
  'externalId',
  'ownerCounterpartyId',
  'positionSnapshot',
  'raw',
  'rawPayload',
  'reservedAt',
  'reservedByProposalId',
  'reservedForOrderId',
  'reservedForPositionId',
  'source',
  'sourceVersion',
]);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedTransactions(
  prisma: PrismaService,
  blockerPid: number,
  expected: number,
  completedBeforeRelease: () => number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (completedBeforeRelease() > 0) {
      throw new Error('Raw stock adjustment completed before reaching the row-lock barrier');
    }
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE "wait_event_type" = 'Lock'
        AND pid <> ${blockerPid}
        AND query ILIKE '%raw_material_stocks%'
    `;
    if ((row?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for concurrent raw stock row locks');
}

function expectSafeRollProjection(value: unknown, sentinel: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => expectSafeRollProjection(item, sentinel));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      expect(FORBIDDEN_ROLL_FIELDS.has(key)).toBe(false);
      expectSafeRollProjection(item, sentinel);
    }
    return;
  }
  if (typeof value === 'string') expect(value).not.toContain(sentinel);
}

describe('Warehouse inventory integrity (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let previousAuthDevXRole: string | undefined;
  const suffix = `${Date.now()}-${process.pid}`;
  const rawSentinel = `RAW-WAREHOUSE-CANARY-${suffix}`;
  const freeCode = `SAFE-FREE-${suffix}`;
  const notReadyCode = `SAFE-NOT-READY-${suffix}`;
  const reservedCode = `SAFE-RESERVED-${suffix}`;
  const materialId = `safe-material-${suffix}`;
  const rollbackMaterialId = `rollback-material-${suffix}`;
  const concurrentMaterialId = `concurrent-material-${suffix}`;
  const receiptMaterialId = `receipt-material-${suffix}`;
  const concurrentReceiptMaterialId = `concurrent-receipt-material-${suffix}`;
  const legacyUppercaseAdjustmentMaterialId = `legacy-uppercase-adjustment-${suffix}`;
  const legacyUppercaseReceiptMaterialId = `legacy-uppercase-receipt-${suffix}`;
  const legacyUppercaseAdjustmentKey = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const legacyUppercaseReceiptKey = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
  const globalSequentialMaterialIds = [
    `global-sequential-a-${suffix}`,
    `global-sequential-b-${suffix}`,
  ] as const;
  const globalConcurrentAdjustmentMaterialIds = [
    `global-concurrent-adjustment-a-${suffix}`,
    `global-concurrent-adjustment-b-${suffix}`,
  ] as const;
  const globalConcurrentReceiptMaterialIds = [
    `global-concurrent-receipt-a-${suffix}`,
    `global-concurrent-receipt-b-${suffix}`,
  ] as const;

  beforeAll(async () => {
    previousAuthDevXRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'on';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    await prisma.warehouseRoll.createMany({
      data: [
        {
          rollCode: freeCode,
          warehouseStatus: 'received',
          ownerCounterpartyId: rawSentinel,
          externalId: `ext-free-${suffix}`,
          sourceVersion: rawSentinel,
          positionSnapshot: {
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            birka: 'ГОСТ',
            spoolType: '76 мм',
            plannedWeightKg: 41.2,
            rawPayload: { token: rawSentinel },
            source: rawSentinel,
          },
        },
        {
          rollCode: notReadyCode,
          warehouseStatus: 'not_ready',
          positionSnapshot: { filmType: 'Полотно' },
        },
        {
          rollCode: reservedCode,
          warehouseStatus: 'received',
          reservedForOrderId: `order-${suffix}`,
          reservedAt: new Date(),
          positionSnapshot: { filmType: 'Полурукав' },
        },
      ],
    });
    await prisma.rawMaterialStock.createMany({
      data: [
        { materialId, label: 'Safe adjustment material', actualQty: 12 },
        { materialId: rollbackMaterialId, label: 'Rollback material', actualQty: 42 },
        { materialId: concurrentMaterialId, label: 'Concurrent material', actualQty: 42 },
        { materialId: receiptMaterialId, label: 'Receipt material', actualQty: 10 },
        {
          materialId: concurrentReceiptMaterialId,
          label: 'Concurrent receipt material',
          actualQty: 42,
        },
        {
          materialId: legacyUppercaseAdjustmentMaterialId,
          label: 'Legacy uppercase adjustment material',
          actualQty: 77,
          factStatus: 'manual',
        },
        {
          materialId: legacyUppercaseReceiptMaterialId,
          label: 'Legacy uppercase receipt material',
          actualQty: 88,
        },
        {
          materialId: globalSequentialMaterialIds[0],
          label: 'Global sequential material A',
          actualQty: 20,
        },
        {
          materialId: globalSequentialMaterialIds[1],
          label: 'Global sequential material B',
          actualQty: 30,
        },
        {
          materialId: globalConcurrentAdjustmentMaterialIds[0],
          label: 'Global concurrent adjustment material A',
          actualQty: 40,
        },
        {
          materialId: globalConcurrentAdjustmentMaterialIds[1],
          label: 'Global concurrent adjustment material B',
          actualQty: 50,
        },
        {
          materialId: globalConcurrentReceiptMaterialIds[0],
          label: 'Global concurrent receipt material A',
          actualQty: 60,
        },
        {
          materialId: globalConcurrentReceiptMaterialIds[1],
          label: 'Global concurrent receipt material B',
          actualQty: 70,
        },
      ],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await runE2eWithCleanup(async () => {
      // Immutable inventory events remain until guarded isolated-schema teardown.
      await prisma.rawMaterialStock.deleteMany({
        where: {
          materialId: {
            in: [
              materialId,
              rollbackMaterialId,
              concurrentMaterialId,
              receiptMaterialId,
              concurrentReceiptMaterialId,
              legacyUppercaseAdjustmentMaterialId,
              legacyUppercaseReceiptMaterialId,
              ...globalSequentialMaterialIds,
              ...globalConcurrentAdjustmentMaterialIds,
              ...globalConcurrentReceiptMaterialIds,
            ],
          },
        },
      });
      await prisma.warehouseRoll.deleteMany({
        where: { rollCode: { in: [freeCode, notReadyCode, reservedCode] } },
      });
    }, [
      { label: 'warehouse inventory application', run: () => app.close() },
      {
        label: 'warehouse inventory auth environment',
        run: () => {
          if (previousAuthDevXRole === undefined) delete process.env.AUTH_DEV_XROLE;
          else process.env.AUTH_DEV_XROLE = previousAuthDevXRole;
        },
      },
    ]);
  });

  it('returns only free received rolls and recursively strips raw/source/reservation facts', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/warehouse/rolls?ownership=free')
      .set({ 'x-role': 'warehouse' })
      .expect(200);

    const fixtureRows = response.body.filter((row: { rollCode: string }) =>
      [freeCode, notReadyCode, reservedCode].includes(row.rollCode),
    );
    expect(fixtureRows).toEqual([
      {
        id: expect.any(String),
        rollCode: freeCode,
        warehouseStatus: 'received',
        facts: {
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          birka: 'ГОСТ',
          spoolType: '76 мм',
          plannedWeightKg: 41.2,
        },
      },
    ]);
    expect(Object.keys(fixtureRows[0]).sort()).toEqual([...SAFE_ROLL_FIELDS]);
    expect(Object.keys(fixtureRows[0].facts).sort()).toEqual([...SAFE_ROLL_FACT_FIELDS]);
    expectSafeRollProjection(response.body, rawSentinel);
  });

  it('preserves reserved and all ownership semantics through the same safe projection', async () => {
    const reserved = await request(app.getHttpServer())
      .get('/api/warehouse/rolls?ownership=reserved')
      .set({ 'x-role': 'warehouse' })
      .expect(200);
    const all = await request(app.getHttpServer())
      .get('/api/warehouse/rolls')
      .set({ 'x-role': 'warehouse' })
      .expect(200);

    expect(reserved.body.map((row: { rollCode: string }) => row.rollCode)).toContain(reservedCode);
    expect(all.body.map((row: { rollCode: string }) => row.rollCode)).toEqual(
      expect.arrayContaining([freeCode, notReadyCode, reservedCode]),
    );
    for (const row of [...reserved.body, ...all.body]) {
      expect(Object.keys(row).sort()).toEqual([...SAFE_ROLL_FIELDS]);
      expect(Object.keys(row.facts).sort()).toEqual([...SAFE_ROLL_FACT_FIELDS]);
    }
  });

  it('rejects an unsupported ownership filter', async () => {
    await request(app.getHttpServer())
      .get('/api/warehouse/rolls?ownership=raw-source')
      .set({ 'x-role': 'warehouse' })
      .expect(400);
  });

  it('rejects an excessively long correction reason', async () => {
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${materialId}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: randomUUID(), actualQty: 11, reason: 'x'.repeat(501) })
      .expect(400);
    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId },
        select: { actualQty: true },
      }),
    ).resolves.toEqual({ actualQty: 12 });
  });

  it('rejects a whitespace-only reason while accepting and auditing an actualQty of zero', async () => {
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${materialId}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: randomUUID(), actualQty: 0, reason: '   ' })
      .expect(400);
    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId },
        select: { actualQty: true },
      }),
    ).resolves.toEqual({ actualQty: 12 });

    const adjustmentKey = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${materialId}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: adjustmentKey, actualQty: 0, reason: '  physical count  ' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${materialId}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: adjustmentKey, actualQty: 0, reason: 'physical count' })
      .expect(201)
      .expect(({ body }) => expect(body.actualQty).toBe(0));
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${materialId}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: adjustmentKey, actualQty: 1, reason: 'physical count' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('RAW_MATERIAL_OPERATION_KEY_REUSED'));

    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId },
        select: { actualQty: true, factStatus: true },
      }),
    ).resolves.toEqual({ actualQty: 0, factStatus: 'manual' });
    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: { objectId: materialId, type: 'audit:inventory_manual_correction' },
        select: { reason: true, newValue: true },
      }),
    ).resolves.toEqual({ reason: 'physical count', newValue: { actualQty: 0 } });
    await expect(
      prisma.domainEvent.count({
        where: { objectId: materialId, type: 'audit:inventory_manual_correction' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: materialId, type: 'problem:raw_material_shortage' },
      }),
    ).resolves.toBe(1);
  });

  it('replays a preinserted legacy uppercase adjustment key without another fact or problem', async () => {
    const reason = `legacy uppercase adjustment ${suffix}`;
    await prisma.domainEvent.create({
      data: {
        family: 'audit',
        type: 'audit:inventory_manual_correction',
        objectId: legacyUppercaseAdjustmentMaterialId,
        actorRole: 'warehouse',
        actorId: null,
        reason,
        oldValue: { actualQty: 91 },
        newValue: { actualQty: 77 },
        detail: {
          operationKey: legacyUppercaseAdjustmentKey.toUpperCase(),
          actualQty: 77,
        },
      },
    });

    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${legacyUppercaseAdjustmentMaterialId}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: legacyUppercaseAdjustmentKey, actualQty: 77, reason })
      .expect(201)
      .expect(({ body }) => expect(body.actualQty).toBe(77));

    const [stock, corrections, shortages] = await Promise.all([
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: legacyUppercaseAdjustmentMaterialId },
        select: { actualQty: true, factStatus: true },
      }),
      prisma.domainEvent.count({
        where: {
          objectId: legacyUppercaseAdjustmentMaterialId,
          type: 'audit:inventory_manual_correction',
        },
      }),
      prisma.domainEvent.count({
        where: {
          objectId: legacyUppercaseAdjustmentMaterialId,
          type: 'problem:raw_material_shortage',
        },
      }),
    ]);
    expect(stock).toEqual({ actualQty: 77, factStatus: 'manual' });
    expect(corrections).toBe(1);
    expect(shortages).toBe(0);
  });

  it('rolls the stock mutation and audit fact back together when audit persistence fails', async () => {
    const rollbackReason = `rollback proof ${suffix}`;
    const originalRecord = audit.record.bind(audit);
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      const stored = await originalRecord(input, client);
      if (input.objectId === rollbackMaterialId) throw new Error('forced stock audit failure');
      return stored;
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/warehouse/raw-materials/${rollbackMaterialId}/adjustments`)
        .set({ 'x-role': 'warehouse' })
        .send({ operationKey: randomUUID(), actualQty: 1, reason: rollbackReason })
        .expect(500);
    } finally {
      auditSpy.mockRestore();
    }

    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: rollbackMaterialId },
        select: { actualQty: true, factStatus: true },
      }),
    ).resolves.toEqual({ actualQty: 42, factStatus: 'warehouse_fact' });
    await expect(
      prisma.domainEvent.count({ where: { objectId: rollbackMaterialId } }),
    ).resolves.toBe(0);
  });

  it('serializes concurrent stock corrections through the locked reread', async () => {
    const blockerReady = deferred<number>();
    const releaseBlocker = deferred<void>();
    const blocker = prisma.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        await tx.$queryRaw`
          SELECT "id"
          FROM "raw_material_stocks"
          WHERE "materialId" = ${concurrentMaterialId}
          FOR UPDATE
        `;
        blockerReady.resolve(backend!.pid);
        await releaseBlocker.promise;
      },
      { timeout: 15_000 },
    );
    const blockerPid = await blockerReady.promise;
    let released = false;
    let completedBeforeRelease = 0;
    const adjust = (actualQty: number, reason: string) =>
      request(app.getHttpServer())
        .post(`/api/warehouse/raw-materials/${concurrentMaterialId}/adjustments`)
        .set({ 'x-role': 'warehouse' })
        .send({ operationKey: randomUUID(), actualQty, reason })
        .expect(201)
        .then(
          (response) => {
            if (!released) completedBeforeRelease += 1;
            return response;
          },
          (error: unknown) => {
            if (!released) completedBeforeRelease += 1;
            throw error;
          },
        );
    const first = adjust(31, `concurrent first ${suffix}`);
    const second = adjust(17, `concurrent second ${suffix}`);
    let barrierError: unknown;
    try {
      await waitForBlockedTransactions(prisma, blockerPid, 2, () => completedBeforeRelease);
    } catch (error) {
      barrierError = error;
    } finally {
      released = true;
      releaseBlocker.resolve();
    }
    await blocker;
    await Promise.all([first, second]);
    if (barrierError) throw barrierError;

    const [stock, events] = await Promise.all([
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: concurrentMaterialId },
        select: { actualQty: true },
      }),
      prisma.domainEvent.findMany({
        where: {
          objectId: concurrentMaterialId,
          type: 'audit:inventory_manual_correction',
        },
        select: { oldValue: true, newValue: true },
      }),
    ]);
    expect(events).toHaveLength(2);
    const chain = events.map((event) => ({
      oldQty: (event.oldValue as { actualQty: number }).actualQty,
      newQty: (event.newValue as { actualQty: number }).actualQty,
    }));
    const firstFact = chain.find((event) => event.oldQty === 42);
    expect(firstFact).toBeDefined();
    const secondFact = chain.find((event) => event !== firstFact);
    expect(secondFact?.oldQty).toBe(firstFact?.newQty);
    expect(stock.actualQty).toBe(secondFact?.newQty);
    expect(chain.map((event) => event.newQty).sort((left, right) => left - right)).toEqual([
      17, 31,
    ]);
  });

  it('adds a receipt once and replays an identical operation key without duplicating stock', async () => {
    const body = {
      operationKey: '11111111-1111-4111-8111-111111111111',
      receivedQty: 5.25,
      reason: '  Накладная № 42  ',
    };

    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${receiptMaterialId}/receipts`)
      .set({ 'x-role': 'warehouse' })
      .send(body)
      .expect(200)
      .expect(({ body: responseBody }) => {
        expect(responseBody.actualQty).toBe(15.25);
        expect(responseBody.factStatus).toBe('warehouse_fact');
      });
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${receiptMaterialId}/receipts`)
      .set({ 'x-role': 'warehouse' })
      .send(body)
      .expect(200);

    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: receiptMaterialId },
        select: { actualQty: true },
      }),
    ).resolves.toEqual({ actualQty: 15.25 });
    await expect(
      prisma.domainEvent.findMany({
        where: { objectId: receiptMaterialId, type: 'audit:raw_material_received' },
        select: { reason: true, oldValue: true, newValue: true, detail: true },
      }),
    ).resolves.toEqual([
      {
        reason: 'Накладная № 42',
        oldValue: { actualQty: 10 },
        newValue: { actualQty: 15.25 },
        detail: {
          operationKey: '11111111-1111-4111-8111-111111111111',
          receivedQty: 5.25,
        },
      },
    ]);
  });

  it('replays a preinserted legacy uppercase receipt key without another increment or fact', async () => {
    const reason = `legacy uppercase receipt ${suffix}`;
    await prisma.domainEvent.create({
      data: {
        family: 'audit',
        type: 'audit:raw_material_received',
        objectId: legacyUppercaseReceiptMaterialId,
        actorRole: 'warehouse',
        actorId: null,
        reason,
        oldValue: { actualQty: 83 },
        newValue: { actualQty: 88 },
        detail: {
          operationKey: legacyUppercaseReceiptKey.toUpperCase(),
          receivedQty: 5,
        },
      },
    });

    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${legacyUppercaseReceiptMaterialId}/receipts`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: legacyUppercaseReceiptKey, receivedQty: 5, reason })
      .expect(200)
      .expect(({ body }) => expect(body.actualQty).toBe(88));

    const [stock, receipts] = await Promise.all([
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: legacyUppercaseReceiptMaterialId },
        select: { actualQty: true, factStatus: true },
      }),
      prisma.domainEvent.count({
        where: {
          objectId: legacyUppercaseReceiptMaterialId,
          type: 'audit:raw_material_received',
        },
      }),
    ]);
    expect(stock).toEqual({ actualQty: 88, factStatus: 'warehouse_fact' });
    expect(receipts).toBe(1);
  });

  it('rejects a changed receipt payload under the same operation key', async () => {
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${receiptMaterialId}/receipts`)
      .set({ 'x-role': 'warehouse' })
      .send({
        operationKey: '11111111-1111-4111-8111-111111111111',
        receivedQty: 7,
        reason: 'Другая накладная',
      })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('RAW_MATERIAL_OPERATION_KEY_REUSED'));

    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: receiptMaterialId },
        select: { actualQty: true },
      }),
    ).resolves.toEqual({ actualQty: 15.25 });
  });

  it('rejects sequential cross-material and cross-kind reuse from the global namespace', async () => {
    const operationKey = randomUUID();
    const reason = `global sequential command ${suffix}`;

    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${globalSequentialMaterialIds[0]}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey, actualQty: 15, reason })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${globalSequentialMaterialIds[0]}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey, actualQty: 15, reason })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${globalSequentialMaterialIds[1]}/adjustments`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey, actualQty: 15, reason })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('RAW_MATERIAL_OPERATION_KEY_REUSED'));
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${globalSequentialMaterialIds[1]}/receipts`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey, receivedQty: 15, reason })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('RAW_MATERIAL_OPERATION_KEY_REUSED'));

    const [untouchedStock, commandFacts, rejectedMaterialFacts] = await Promise.all([
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: globalSequentialMaterialIds[1] },
        select: { actualQty: true },
      }),
      prisma.domainEvent.count({
        where: {
          type: {
            in: ['audit:inventory_manual_correction', 'audit:raw_material_received'],
          },
          detail: { path: ['operationKey'], equals: operationKey },
        },
      }),
      prisma.domainEvent.count({
        where: { objectId: globalSequentialMaterialIds[1] },
      }),
    ]);
    expect(untouchedStock.actualQty).toBe(30);
    expect(commandFacts).toBe(1);
    expect(rejectedMaterialFacts).toBe(0);
  });

  it('serializes one adjustment key across two materials under Promise.all', async () => {
    const operationKey = randomUUID();
    const responses = await Promise.all(
      globalConcurrentAdjustmentMaterialIds.map((targetMaterialId) =>
        request(app.getHttpServer())
          .post(`/api/warehouse/raw-materials/${targetMaterialId}/adjustments`)
          .set({ 'x-role': 'warehouse' })
          .send({
            operationKey,
            actualQty: 9,
            reason: `global concurrent adjustment ${suffix}`,
          }),
      ),
    );

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(responses.find(({ status }) => status === 409)?.body.code).toBe(
      'RAW_MATERIAL_OPERATION_KEY_REUSED',
    );
    const [stocks, commandFacts] = await Promise.all([
      Promise.all(
        globalConcurrentAdjustmentMaterialIds.map((targetMaterialId) =>
          prisma.rawMaterialStock.findUniqueOrThrow({
            where: { materialId: targetMaterialId },
            select: { actualQty: true },
          }),
        ),
      ),
      prisma.domainEvent.count({
        where: {
          type: {
            in: ['audit:inventory_manual_correction', 'audit:raw_material_received'],
          },
          detail: { path: ['operationKey'], equals: operationKey },
        },
      }),
    ]);
    expect(stocks.filter(({ actualQty }) => actualQty === 9)).toHaveLength(1);
    expect(stocks.filter(({ actualQty }, index) => actualQty === [40, 50][index])).toHaveLength(1);
    expect(commandFacts).toBe(1);
  });

  it('serializes one receipt key across two materials under Promise.all', async () => {
    const operationKey = randomUUID();
    const responses = await Promise.all(
      globalConcurrentReceiptMaterialIds.map((targetMaterialId) =>
        request(app.getHttpServer())
          .post(`/api/warehouse/raw-materials/${targetMaterialId}/receipts`)
          .set({ 'x-role': 'warehouse' })
          .send({
            operationKey,
            receivedQty: 5,
            reason: `global concurrent receipt ${suffix}`,
          }),
      ),
    );

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)?.body.code).toBe(
      'RAW_MATERIAL_OPERATION_KEY_REUSED',
    );
    const [stocks, commandFacts] = await Promise.all([
      Promise.all(
        globalConcurrentReceiptMaterialIds.map((targetMaterialId) =>
          prisma.rawMaterialStock.findUniqueOrThrow({
            where: { materialId: targetMaterialId },
            select: { actualQty: true },
          }),
        ),
      ),
      prisma.domainEvent.count({
        where: {
          type: {
            in: ['audit:inventory_manual_correction', 'audit:raw_material_received'],
          },
          detail: { path: ['operationKey'], equals: operationKey },
        },
      }),
    ]);
    expect(stocks.map(({ actualQty }, index) => actualQty - [60, 70][index]).sort()).toEqual([
      0, 5,
    ]);
    expect(commandFacts).toBe(1);
  });

  it('serializes concurrent raw-material receipts without losing either quantity', async () => {
    const receive = (operationKey: string, receivedQty: number) =>
      request(app.getHttpServer())
        .post(`/api/warehouse/raw-materials/${concurrentReceiptMaterialId}/receipts`)
        .set({ 'x-role': 'warehouse' })
        .send({ operationKey, receivedQty, reason: `Накладная ${operationKey}` })
        .expect(200);

    await Promise.all([
      receive('22222222-2222-4222-8222-222222222222', 3),
      receive('33333333-3333-4333-8333-333333333333', 7),
    ]);

    const [stock, events] = await Promise.all([
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: concurrentReceiptMaterialId },
        select: { actualQty: true },
      }),
      prisma.domainEvent.findMany({
        where: {
          objectId: concurrentReceiptMaterialId,
          type: 'audit:raw_material_received',
        },
        orderBy: { createdAt: 'asc' },
        select: { oldValue: true, newValue: true },
      }),
    ]);
    expect(stock.actualQty).toBe(52);
    expect(events).toHaveLength(2);
    expect((events[0]?.oldValue as { actualQty: number }).actualQty).toBe(42);
    expect((events[1]?.oldValue as { actualQty: number }).actualQty).toBe(
      (events[0]?.newValue as { actualQty: number }).actualQty,
    );
  });

  it('validates receipt input and preserves warehouse capability gates', async () => {
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${receiptMaterialId}/receipts`)
      .set({ 'x-role': 'warehouse' })
      .send({ operationKey: 'not-a-uuid', receivedQty: 0, reason: '   ' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${receiptMaterialId}/receipts`)
      .set({ 'x-role': 'commercial' })
      .send({
        operationKey: '44444444-4444-4444-8444-444444444444',
        receivedQty: 1,
        reason: 'forbidden',
      })
      .expect(403);
  });

  it('keeps warehouse capability gates intact', async () => {
    await request(app.getHttpServer())
      .get('/api/warehouse/rolls')
      .set({ 'x-role': 'commercial' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/warehouse/raw-materials/${materialId}/adjustments`)
      .set({ 'x-role': 'commercial' })
      .send({ operationKey: randomUUID(), actualQty: 1, reason: 'forbidden' })
      .expect(403);
  });
});
