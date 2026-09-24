import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CommercialCoverService } from '../src/modules/commercial/commercial-cover.service';
import { CommercialService } from '../src/modules/commercial/commercial.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';
import { runE2eWithCleanup } from './e2e-database';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForTableLock(
  prisma: PrismaService,
  tableName: string,
  minimumWaiters = 1,
  timeoutMs = 5_000,
) {
  const pattern = `%${tableName}%`;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const waiting = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE ${pattern}
    `;
    if ((waiting[0]?.count ?? 0) >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a PostgreSQL lock on ${tableName}`);
}

describe('Warehouse cover transactions (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let commercial: CommercialService;
  let commercialCover: CommercialCoverService;
  let warehouse: WarehouseService;
  let sequence = 0;
  const orderIds = new Set<string>();
  const counterpartyIds = new Set<string>();
  const commercialActor = { userId: null, role: 'commercial' as const };
  const warehouseActor = { userId: null, role: 'warehouse' as const };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    commercial = moduleRef.get(CommercialService);
    commercialCover = moduleRef.get(CommercialCoverService);
    warehouse = moduleRef.get(WarehouseService);
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'warehouse cover order fixtures',
          run: async () => {
            const ids = [...orderIds];
            if (ids.length > 0) {
              // Immutable coverage events remain until guarded isolated-schema teardown.
              await prisma.warehouseCoverProposal.deleteMany({ where: { orderId: { in: ids } } });
              await prisma.orderResolutionCase.deleteMany({ where: { orderId: { in: ids } } });
              await prisma.commercialOrderPosition.deleteMany({ where: { orderId: { in: ids } } });
              await prisma.commercialOrder.deleteMany({ where: { id: { in: ids } } });
            }
            orderIds.clear();
          },
        },
        {
          label: 'warehouse cover counterparty fixtures',
          run: async () => {
            const counterparties = [...counterpartyIds];
            if (counterparties.length > 0) {
              await prisma.counterparty.deleteMany({ where: { id: { in: counterparties } } });
            }
            counterpartyIds.clear();
          },
        },
        {
          label: 'warehouse cover mocks',
          run: () => {
            jest.restoreAllMocks();
          },
        },
      ],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  async function createOrder(positionCount = 1) {
    sequence += 1;
    const suffix = `${Date.now()}-${process.pid}-${sequence}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Cover concurrency ${suffix}` },
    });
    counterpartyIds.add(counterparty.id);
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-COVER-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        positions: {
          create: Array.from({ length: positionCount }, (_, index) => ({
            rollCount: 1,
            filmType: `Рукав ${index + 1}`,
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            birka: 'ГОСТ',
            spoolType: 'Шпуля 76 мм',
          })),
        },
      },
      include: { positions: { orderBy: { id: 'asc' } } },
    });
    orderIds.add(order.id);
    return order;
  }

  async function openCoverCase(
    order: Awaited<ReturnType<typeof createOrder>>,
    affectedPositionIds = order.positions.map((position) => position.id),
  ) {
    return prisma.orderResolutionCase.create({
      data: {
        orderId: order.id,
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: `warehouse_cover:${order.id}`,
        affectedPositionIds,
        affectedRollIds: [],
        reason: 'real_db_concurrency_fixture',
        nextOwnerRole: 'warehouse',
        createdByRole: 'commercial',
      },
    });
  }

  it('converges simultaneous cover requests to one case, event and order transition', async () => {
    const order = await createOrder();
    const auditReached = deferred();
    const releaseFirst = deferred();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      auditReached.resolve();
      await releaseFirst.promise;
      return originalRecord(input, client);
    });

    const first = commercial.requestCoverCheck(commercialActor, order.id);
    await auditReached.promise;
    const second = commercial.requestCoverCheck(commercialActor, order.id);
    try {
      await waitForTableLock(prisma, 'order_resolution_cases');
    } finally {
      releaseFirst.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.case.id).toBe(secondResult.case.id);
    expect(firstResult.order).toEqual(secondResult.order);
    await expect(
      prisma.orderResolutionCase.count({ where: { orderId: order.id, status: 'open' } }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: order.id, type: 'audit:warehouse_cover_recheck_requested' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.commercialOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { version: true, warehouseCoverStatus: true },
      }),
    ).resolves.toEqual({ version: order.version + 1, warehouseCoverStatus: 'recheck_requested' });
  });

  it('rolls back the case and order CAS when the audit write path fails', async () => {
    const order = await createOrder();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      await originalRecord(input, client);
      throw new Error('forced audit failure');
    });

    await expect(commercial.requestCoverCheck(commercialActor, order.id)).rejects.toThrow(
      'forced audit failure',
    );

    await expect(prisma.orderResolutionCase.count({ where: { orderId: order.id } })).resolves.toBe(
      0,
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: order.id, type: 'audit:warehouse_cover_recheck_requested' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.commercialOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { version: true, warehouseCoverStatus: true },
      }),
    ).resolves.toEqual({ version: order.version, warehouseCoverStatus: 'not_checked' });
  });

  it('preserves both concurrent position expansions on one existing cover case', async () => {
    const order = await createOrder(3);
    const [existingPosition, firstPosition, secondPosition] = order.positions;
    const resolutionCase = await openCoverCase(order, [existingPosition!.id]);
    await prisma.commercialOrder.update({
      where: { id: order.id },
      data: { warehouseCoverStatus: 'recheck_requested' },
    });
    await prisma.commercialOrderPosition.updateMany({
      where: { id: { in: [firstPosition!.id, secondPosition!.id] } },
      data: { warehouseCoverStatus: 'recheck_requested' },
    });
    await prisma.warehouseCoverProposal.createMany({
      data: [firstPosition!, secondPosition!].map((position) => ({
        orderId: order.id,
        positionId: position.id,
        coverType: 'partial',
        route: 'production_only',
        coverQty: 0,
        reserveQty: 0,
        productionQty: 1,
        matchedRollIds: [],
        status: 'recheck_requested',
      })),
    });

    const rowLocked = deferred();
    const releaseRow = deferred();
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM order_resolution_cases
        WHERE id = ${resolutionCase.id}
        FOR UPDATE
      `;
      rowLocked.resolve();
      await releaseRow.promise;
    });
    await rowLocked.promise;

    const proposals = await prisma.warehouseCoverProposal.findMany({
      where: { orderId: order.id },
      orderBy: { positionId: 'asc' },
    });
    const first = commercialCover.requestRecheck(
      commercialActor,
      order.id,
      firstPosition!.id,
      proposals.find((proposal) => proposal.positionId === firstPosition!.id)!.id,
      { expectedVersion: 1, reason: 'Concurrent first position recheck' },
    );
    const second = commercialCover.requestRecheck(
      commercialActor,
      order.id,
      secondPosition!.id,
      proposals.find((proposal) => proposal.positionId === secondPosition!.id)!.id,
      { expectedVersion: 1, reason: 'Concurrent second position recheck' },
    );
    try {
      await waitForTableLock(prisma, 'order_resolution_cases', 2);
    } finally {
      releaseRow.resolve();
    }
    await Promise.all([blocker, first, second]);

    const persistedCase = await prisma.orderResolutionCase.findUniqueOrThrow({
      where: { id: resolutionCase.id },
      select: { affectedPositionIds: true, version: true },
    });
    const persistedScope = persistedCase.affectedPositionIds as string[];
    expect([...persistedScope].sort()).toEqual(order.positions.map(({ id }) => id).sort());
    expect(new Set(persistedScope).size).toBe(persistedScope.length);
    expect(persistedCase.version).toBe(resolutionCase.version + 2);

    const events = await prisma.domainEvent.findMany({
      where: {
        objectId: order.id,
        type: 'audit:warehouse_cover_recheck_requested',
      },
      select: { detail: true },
    });
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => (event.detail as { positionId: string }).positionId).sort(),
    ).toEqual([firstPosition!.id, secondPosition!.id].sort());
    await expect(
      prisma.warehouseCoverProposal.findMany({
        where: { orderId: order.id },
        select: { status: true, version: true },
        orderBy: { positionId: 'asc' },
      }),
    ).resolves.toEqual([
      { status: 'recheck_requested', version: 1 },
      { status: 'recheck_requested', version: 1 },
    ]);
  });

  it('closes a one-position recheck without fresh proposals for unrelated positions', async () => {
    const order = await createOrder(2);
    const [scopedPosition, unrelatedPosition] = order.positions;
    const oldProposals = await Promise.all(
      order.positions.map((position) =>
        prisma.warehouseCoverProposal.create({
          data: {
            orderId: order.id,
            positionId: position.id,
            coverType: 'partial',
            route: 'production_only',
            coverQty: 0,
            reserveQty: 0,
            productionQty: 1,
            matchedRollIds: [],
            status: 'partial_proposed',
          },
        }),
      ),
    );

    await commercialCover.requestRecheck(
      commercialActor,
      order.id,
      scopedPosition!.id,
      oldProposals.find((proposal) => proposal.positionId === scopedPosition!.id)!.id,
      { expectedVersion: 1, reason: 'Refresh only the selected position' },
    );
    const resolutionCase = await prisma.orderResolutionCase.findUniqueOrThrow({
      where: { openScopeKey: `warehouse_cover:${order.id}` },
    });
    expect(resolutionCase.affectedPositionIds).toEqual([scopedPosition!.id]);

    await warehouse.proposeCover(warehouseActor, order.id, {
      positionId: scopedPosition!.id,
      rollIds: [],
    });

    await expect(
      prisma.orderResolutionCase.findUniqueOrThrow({
        where: { id: resolutionCase.id },
        select: { status: true, openScopeKey: true, outcome: true },
      }),
    ).resolves.toEqual({
      status: 'resolved',
      openScopeKey: null,
      outcome: 'cover_proposed_for_all_positions',
    });
    await expect(
      prisma.warehouseCoverProposal.count({
        where: {
          orderId: order.id,
          positionId: unrelatedPosition!.id,
          createdAt: { gte: resolutionCase.createdAt },
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.warehouseCoverProposal.count({
        where: {
          orderId: order.id,
          positionId: scopedPosition!.id,
          createdAt: { gte: resolutionCase.createdAt },
        },
      }),
    ).resolves.toBe(1);
  });

  it('projects only the rechecked position and rejects an out-of-scope proposal over HTTP', async () => {
    const order = await createOrder(2);
    const [unrelatedPosition, scopedPosition] = order.positions;
    const oldProposals = await Promise.all(
      order.positions.map((position) =>
        prisma.warehouseCoverProposal.create({
          data: {
            orderId: order.id,
            positionId: position.id,
            coverType: 'partial',
            route: 'production_only',
            coverQty: 0,
            reserveQty: 0,
            productionQty: 1,
            matchedRollIds: [],
            status: 'partial_proposed',
          },
        }),
      ),
    );
    const scopedProposal = oldProposals.find(
      (proposal) => proposal.positionId === scopedPosition!.id,
    )!;
    const recheckPath =
      `/api/commercial/orders/${order.id}/positions/${scopedPosition!.id}` +
      `/warehouse-cover/${scopedProposal.id}/recheck`;
    await http()
      .post(recheckPath)
      .set('x-role', 'warehouse')
      .send({ expectedVersion: 1, reason: 'Warehouse must not request a commercial recheck' })
      .expect(403);
    await expect(
      prisma.warehouseCoverProposal.findUniqueOrThrow({
        where: { id: scopedProposal.id },
        select: { status: true, version: true },
      }),
    ).resolves.toEqual({ status: 'partial_proposed', version: 1 });
    await expect(prisma.orderResolutionCase.count({ where: { orderId: order.id } })).resolves.toBe(
      0,
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: order.id, type: 'audit:warehouse_cover_recheck_requested' },
      }),
    ).resolves.toBe(0);

    await http()
      .post(recheckPath)
      .set('x-role', 'commercial')
      .send({ expectedVersion: 1, reason: 'Recheck only the selected position over HTTP' })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: scopedProposal.id,
            positionId: scopedPosition!.id,
            status: 'recheck_requested',
            version: 2,
          }),
        );
      });

    const coverPage = await http()
      .get('/api/warehouse/cover-checks?limit=100')
      .set('x-role', 'warehouse')
      .expect(200);
    const projected = coverPage.body.items.find(
      (item: { orderId: string }) => item.orderId === order.id,
    ) as { positions: Array<{ id: string }> } | undefined;
    expect(projected?.positions.map((position) => position.id)).toEqual([scopedPosition!.id]);

    await http()
      .post(`/api/warehouse/orders/${order.id}/cover-proposals`)
      .set('x-role', 'warehouse')
      .send({ positionId: unrelatedPosition!.id, rollIds: [] })
      .expect(409);
    await expect(
      prisma.warehouseCoverProposal.count({ where: { orderId: order.id } }),
    ).resolves.toBe(2);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: order.id, type: 'audit:warehouse_cover_proposed' },
      }),
    ).resolves.toBe(0);
  });

  it('keeps a case open when a newer ineligible proposal supersedes an older eligible one', async () => {
    const order = await createOrder(2);
    const [firstPosition, secondPosition] = order.positions;
    const resolutionCase = await openCoverCase(order);
    const olderCreatedAt = new Date(resolutionCase.createdAt.getTime() + 1_000);
    const newerCreatedAt = new Date(resolutionCase.createdAt.getTime() + 2_000);
    await prisma.warehouseCoverProposal.createMany({
      data: [
        {
          orderId: order.id,
          positionId: firstPosition!.id,
          coverType: 'full',
          route: 'full_cover',
          coverQty: 1,
          reserveQty: 0,
          productionQty: 0,
          matchedRollIds: [],
          status: 'full_proposed',
          createdAt: olderCreatedAt,
        },
        {
          orderId: order.id,
          positionId: firstPosition!.id,
          coverType: 'partial',
          route: 'production_only',
          coverQty: 0,
          reserveQty: 0,
          productionQty: 1,
          matchedRollIds: [],
          status: 'recheck_requested',
          createdAt: newerCreatedAt,
        },
      ],
    });

    await warehouse.proposeCover(warehouseActor, order.id, {
      positionId: secondPosition!.id,
      rollIds: [],
    });

    await expect(
      prisma.orderResolutionCase.findUniqueOrThrow({
        where: { id: resolutionCase.id },
        select: { status: true, openScopeKey: true },
      }),
    ).resolves.toEqual({
      status: 'open',
      openScopeKey: `warehouse_cover:${order.id}`,
    });
    await expect(
      prisma.warehouseCoverProposal.findMany({
        where: { orderId: order.id, positionId: firstPosition!.id },
        select: { status: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ).resolves.toEqual([{ status: 'recheck_requested' }, { status: 'full_proposed' }]);
  });

  it('maps a real concurrent proposal serialization failure and rolls back the loser', async () => {
    const order = await createOrder(2);
    const resolutionCase = await openCoverCase(order);
    const auditReached = deferred();
    const releaseFirst = deferred();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      auditReached.resolve();
      await releaseFirst.promise;
      return originalRecord(input, client);
    });

    const first = warehouse.proposeCover(warehouseActor, order.id, {
      positionId: order.positions[0]!.id,
      rollIds: [],
    });
    await auditReached.promise;
    const second = warehouse.proposeCover(warehouseActor, order.id, {
      positionId: order.positions[1]!.id,
      rollIds: [],
    });
    try {
      await waitForTableLock(prisma, 'commercial_orders');
    } finally {
      releaseFirst.resolve();
    }
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status !== 'rejected') throw new Error('Expected the second proposal to lose');
    expect(secondResult.reason).toBeInstanceOf(ConflictException);
    await expect(
      prisma.warehouseCoverProposal.findMany({
        where: { orderId: order.id },
        select: { positionId: true },
      }),
    ).resolves.toEqual([{ positionId: order.positions[0]!.id }]);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: order.id, type: 'audit:warehouse_cover_proposed' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.orderResolutionCase.findUniqueOrThrow({
        where: { id: resolutionCase.id },
        select: { status: true, openScopeKey: true },
      }),
    ).resolves.toEqual({ status: 'open', openScopeKey: `warehouse_cover:${order.id}` });
    await expect(
      prisma.commercialOrderPosition.findUniqueOrThrow({
        where: { id: order.positions[1]!.id },
        select: { warehouseCoverStatus: true },
      }),
    ).resolves.toEqual({ warehouseCoverStatus: 'not_checked' });
  });

  it('rolls back proposal, event and case closure when P2034 is raised after the audit insert', async () => {
    const order = await createOrder();
    const resolutionCase = await openCoverCase(order);
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      await originalRecord(input, client);
      throw new Prisma.PrismaClientKnownRequestError('forced serialization failure', {
        code: 'P2034',
        clientVersion: 'test',
      });
    });

    await expect(
      warehouse.proposeCover(warehouseActor, order.id, {
        positionId: order.positions[0]!.id,
        rollIds: [],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      prisma.warehouseCoverProposal.count({ where: { orderId: order.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: order.id, type: 'audit:warehouse_cover_proposed' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.orderResolutionCase.findUniqueOrThrow({
        where: { id: resolutionCase.id },
        select: { status: true, openScopeKey: true },
      }),
    ).resolves.toEqual({ status: 'open', openScopeKey: `warehouse_cover:${order.id}` });
    await expect(
      prisma.commercialOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { version: true, warehouseCoverStatus: true },
      }),
    ).resolves.toEqual({ version: order.version, warehouseCoverStatus: 'not_checked' });
    await expect(
      prisma.commercialOrderPosition.findUniqueOrThrow({
        where: { id: order.positions[0]!.id },
        select: { warehouseCoverStatus: true },
      }),
    ).resolves.toEqual({ warehouseCoverStatus: 'not_checked' });
  });
});
