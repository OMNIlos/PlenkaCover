import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommercialCoverService } from './commercial-cover.service';

const commercialActor = { userId: 'commercial-1', role: 'commercial' as const };
const productionActor = { userId: 'lead-1', role: 'production_lead' as const };

function position() {
  return {
    id: 'position-1',
    orderId: 'order-1',
    rollCount: 1,
    filmType: 'Рукав',
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    birka: 'Гост',
    spoolType: 'Шпуля 76 мм',
    plannedWeightKg: 41.2,
    warehouseCoverStatus: 'full_proposed',
  };
}

function roll(overrides: Record<string, unknown> = {}) {
  return {
    id: 'roll-1',
    rollCode: 'STK-roll-1',
    warehouseStatus: 'received',
    reservedForOrderId: null,
    reservedForPositionId: null,
    reservedByProposalId: null,
    producedForOrderId: null,
    positionSnapshot: {
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      birka: 'Гост',
      spoolType: 'Шпуля 76 мм',
      plannedWeightKg: 41.2,
    },
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  const targetPosition = position();
  const candidate = roll();
  return {
    id: 'proposal-1',
    orderId: 'order-1',
    positionId: targetPosition.id,
    version: 1,
    route: 'production_only',
    coverType: 'full',
    coverQty: 1,
    reserveQty: 0,
    productionQty: 0,
    status: 'full_proposed',
    sourceCapturedAt: new Date('2026-07-14T08:00:00.000Z'),
    expiresAt: new Date('2099-07-14T08:30:00.000Z'),
    commercialApprovedById: null,
    commercialApprovedAt: null,
    technicalApprovedById: null,
    technicalApprovedAt: null,
    position: targetPosition,
    order: {
      id: 'order-1',
      orderNumber: 'A-1',
      version: 1,
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'incoming',
      shipmentStatus: 'not_shipped',
      readyForShipmentAt: null,
      shipmentCompletedAt: null,
      warehouseCoverStatus: 'full_proposed',
      productionIndicator: 'not_started',
      positions: [targetPosition],
    },
    matches: [
      {
        id: 'match-1',
        rollId: candidate.id,
        compatible: true,
        criteria: {},
        roll: candidate,
      },
    ],
    reservedRolls: [],
    ...overrides,
  };
}

async function setup(proposalValue = proposal()) {
  const tx = {
    warehouseCoverProposal: {
      findUnique: jest.fn().mockResolvedValue(proposalValue),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    warehouseRoll: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    warehouseAcceptanceTask: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'reserve-task-1' }),
    },
    commercialOrderPosition: { update: jest.fn() },
    commercialOrder: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'order-1', warehouseCoverageWorkflowVersion: 1 }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderResolutionCase: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn().mockResolvedValue({
        id: 'case-1',
        orderId: 'order-1',
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: 'warehouse_cover:order-1',
        affectedPositionIds: ['position-1'],
        createdAt: new Date('2026-07-15T08:00:00.000Z'),
        updatedAt: new Date('2026-07-15T08:00:00.000Z'),
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn() };
  const fulfillmentHandoff = {
    reconcile: jest.fn().mockResolvedValue({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      CommercialCoverService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: OrderFulfillmentHandoffService, useValue: fulfillmentHandoff },
    ],
  }).compile();
  return {
    service: moduleRef.get(CommercialCoverService),
    prisma,
    tx,
    audit,
    fulfillmentHandoff,
  };
}

describe('CommercialCoverService', () => {
  it.each([
    {
      route: 'commercial approval',
      buildProposal: () => {
        const value = proposal({
          commercialApprovedById: 'commercial-1',
          commercialApprovedAt: new Date('2026-07-14T08:10:00.000Z'),
        });
        value.order.warehouseCoverageWorkflowVersion = 2;
        return value;
      },
      invoke: (service: CommercialCoverService) =>
        service.approveCommercial(commercialActor, 'order-1', 'position-1', 'proposal-1', {
          expectedVersion: 1,
          route: 'production_only',
        }),
    },
    {
      route: 'technical approval',
      buildProposal: () => {
        const reserved = roll({
          reservedForOrderId: 'order-1',
          reservedForPositionId: 'position-1',
          reservedByProposalId: 'proposal-1',
        });
        const value = proposal({
          technicalApprovedById: 'lead-1',
          technicalApprovedAt: new Date('2026-07-14T08:20:00.000Z'),
          reservedRolls: [reserved],
        });
        value.order.warehouseCoverageWorkflowVersion = 2;
        return value;
      },
      invoke: (service: CommercialCoverService) =>
        service.finalizeTechnicalApproval(productionActor, 'order-1', 'position-1', 'proposal-1', {
          expectedVersion: 1,
        }),
    },
    {
      route: 'position recheck',
      buildProposal: () => {
        const value = proposal();
        value.order.warehouseCoverageWorkflowVersion = 2;
        return value;
      },
      invoke: (service: CommercialCoverService) =>
        service.requestRecheck(commercialActor, 'order-1', 'position-1', 'proposal-1', {
          expectedVersion: 1,
          reason: 'legacy request',
        }),
    },
  ])(
    'rejects the legacy $route route for a V2 order without requiring a legacy proposal',
    async ({ buildProposal, invoke }) => {
      const { service, tx, audit } = await setup(buildProposal());
      tx.commercialOrder.findUnique.mockResolvedValue({
        id: 'order-1',
        warehouseCoverageWorkflowVersion: 2,
      });
      tx.warehouseCoverProposal.findUnique.mockResolvedValue(null);

      await expect(invoke(service)).rejects.toMatchObject({
        response: {
          statusCode: 409,
          code: 'warehouse_coverage_workflow_mismatch',
          expected: 1,
          actual: 2,
        },
      });
      expect(tx.commercialOrder.findUnique).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        select: { warehouseCoverageWorkflowVersion: true },
      });
      expect(tx.warehouseCoverProposal.findUnique).not.toHaveBeenCalled();
      expect(tx.warehouseCoverProposal.updateMany).not.toHaveBeenCalled();
      expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
      expect(tx.orderResolutionCase.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('rejects a roll whose compatibility facts do not match the position', async () => {
    const wrongRoll = roll({
      positionSnapshot: {
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        birka: 'Гост',
        spoolType: 'Шпуля 152 мм',
        plannedWeightKg: 41.2,
      },
    });
    const mismatched = proposal({
      matches: [
        {
          id: 'match-1',
          rollId: wrongRoll.id,
          compatible: true,
          criteria: {},
          roll: wrongRoll,
        },
      ],
    });
    const { service, tx, audit } = await setup(mismatched);

    await expect(
      service.approveCommercial(commercialActor, 'order-1', 'position-1', 'proposal-1', {
        expectedVersion: 1,
        route: 'full_cover',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.warehouseCoverProposal.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a stale proposal version before recording commercial approval', async () => {
    const { service, tx, audit } = await setup(proposal({ version: 3 }));

    await expect(
      service.approveCommercial(commercialActor, 'order-1', 'position-1', 'proposal-1', {
        expectedVersion: 2,
        route: 'full_cover',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.warehouseCoverProposal.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns conflict when another order reserves a proposed roll first', async () => {
    const commerciallyApproved = proposal({
      version: 2,
      route: 'full_cover',
      commercialApprovedById: 'commercial-1',
      commercialApprovedAt: new Date('2026-07-14T08:10:00.000Z'),
    });
    const { service, tx, audit } = await setup(commerciallyApproved);
    tx.warehouseRoll.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.finalizeTechnicalApproval(productionActor, 'order-1', 'position-1', 'proposal-1', {
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(tx.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('atomically reserves exact rolls, creates preparation rows and audits both facts', async () => {
    const commerciallyApproved = proposal({
      version: 2,
      route: 'full_cover',
      commercialApprovedById: 'commercial-1',
      commercialApprovedAt: new Date('2026-07-14T08:10:00.000Z'),
    });
    const { service, tx, audit, fulfillmentHandoff } = await setup(commerciallyApproved);

    await service.finalizeTechnicalApproval(
      productionActor,
      'order-1',
      'position-1',
      'proposal-1',
      { expectedVersion: 2 },
    );

    expect(tx.warehouseRoll.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'roll-1',
        reservedForOrderId: null,
        OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
        warehouseStatus: 'received',
      },
      data: expect.objectContaining({
        reservedForOrderId: 'order-1',
        reservedForPositionId: 'position-1',
        reservedByProposalId: 'proposal-1',
      }),
    });
    expect(tx.warehouseAcceptanceTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mode: 'reserve',
        orderId: 'order-1',
        positionId: 'position-1',
        proposalId: 'proposal-1',
        rows: {
          create: [
            {
              rollCode: 'STK-roll-1',
              fromOrderId: 'A-1',
              scanStatus: 'expected',
            },
          ],
        },
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_cover_technical_approved' }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_rolls_reserved_for_order' }),
      tx,
    );
    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledWith(productionActor, 'order-1', tx);
  });

  it('preserves order recheck while technical approval finalizes another position', async () => {
    const commerciallyApproved = proposal({
      version: 2,
      route: 'full_cover',
      commercialApprovedById: 'commercial-1',
      commercialApprovedAt: new Date('2026-07-14T08:10:00.000Z'),
    });
    const mixedOrder = {
      ...commerciallyApproved,
      order: {
        ...commerciallyApproved.order,
        positions: [
          commerciallyApproved.position,
          {
            ...commerciallyApproved.position,
            id: 'position-2',
            warehouseCoverStatus: 'recheck_requested',
          },
        ],
      },
    };
    const { service, tx } = await setup(mixedOrder);

    await service.finalizeTechnicalApproval(
      productionActor,
      'order-1',
      'position-1',
      'proposal-1',
      { expectedVersion: 2 },
    );

    expect(tx.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ warehouseCoverStatus: 'recheck_requested' }),
      }),
    );
  });

  it('returns an already finalized compatible approval without another event', async () => {
    const reserved = roll({
      reservedForOrderId: 'order-1',
      reservedForPositionId: 'position-1',
      reservedByProposalId: 'proposal-1',
    });
    const finalized = proposal({
      version: 3,
      route: 'full_cover',
      status: 'full_confirmed',
      commercialApprovedById: 'commercial-1',
      commercialApprovedAt: new Date('2026-07-14T08:10:00.000Z'),
      technicalApprovedById: 'lead-1',
      technicalApprovedAt: new Date('2026-07-14T08:11:00.000Z'),
      reservedRolls: [reserved],
      matches: [
        {
          id: 'match-1',
          rollId: reserved.id,
          compatible: true,
          criteria: {},
          roll: reserved,
        },
      ],
    });
    const { service, tx, audit } = await setup(finalized);

    await expect(
      service.finalizeTechnicalApproval(productionActor, 'order-1', 'position-1', 'proposal-1', {
        expectedVersion: 2,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'proposal-1', status: 'full_confirmed' }));

    expect(tx.warehouseCoverProposal.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
    expect(tx.warehouseAcceptanceTask.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('maps a serializable reservation conflict to a retryable domain conflict', async () => {
    const commerciallyApproved = proposal({
      version: 2,
      route: 'full_cover',
      commercialApprovedById: 'commercial-1',
      commercialApprovedAt: new Date('2026-07-14T08:10:00.000Z'),
    });
    const { service, prisma } = await setup(commerciallyApproved);
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('serialization failure', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.finalizeTechnicalApproval(productionActor, 'order-1', 'position-1', 'proposal-1', {
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates an explicit position-scoped warehouse task in the recheck transaction', async () => {
    const { service, tx, audit } = await setup();

    await service.requestRecheck(commercialActor, 'order-1', 'position-1', 'proposal-1', {
      expectedVersion: 1,
      reason: 'Refresh stock facts',
    });

    expect(tx.orderResolutionCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: 'warehouse_cover:order-1',
        affectedPositionIds: ['position-1'],
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_cover_recheck_requested',
        detail: { positionId: 'position-1', caseId: 'case-1' },
      }),
      tx,
    );
    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        version: 1,
        commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
        shipmentStatus: { not: 'shipped' },
        readyForShipmentAt: null,
        shipmentCompletedAt: null,
      },
      data: { warehouseCoverStatus: 'recheck_requested', version: { increment: 1 } },
    });
  });

  it('repairs a missing task for an already requested position without another version transition', async () => {
    const { service, tx, audit } = await setup(
      proposal({ status: 'recheck_requested', version: 2 }),
    );

    await expect(
      service.requestRecheck(commercialActor, 'order-1', 'position-1', 'proposal-1', {
        expectedVersion: 1,
        reason: 'Recover explicit task',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'proposal-1', version: 2, status: 'recheck_requested' }),
    );

    expect(tx.orderResolutionCase.create).toHaveBeenCalledTimes(1);
    expect(tx.warehouseCoverProposal.updateMany).not.toHaveBeenCalled();
    expect(tx.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(tx.commercialOrder.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { positionId: 'position-1', caseId: 'case-1' },
        oldValue: expect.objectContaining({ version: 2 }),
        newValue: expect.objectContaining({ version: 2 }),
      }),
      tx,
    );
  });

  it('adds the requested position to a compatible case acquired by another cover command', async () => {
    const { service, tx } = await setup();
    const existingCase = {
      id: 'case-existing',
      orderId: 'order-1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:order-1',
      affectedPositionIds: ['other-position'],
      version: 3,
      createdAt: new Date('2026-07-15T08:00:00.000Z'),
      updatedAt: new Date('2026-07-15T08:00:00.000Z'),
    };
    tx.orderResolutionCase.findUnique.mockResolvedValue(existingCase);
    const expandedCase = {
      ...existingCase,
      affectedPositionIds: ['other-position', 'position-1'],
      version: 4,
    };
    tx.orderResolutionCase.update.mockResolvedValue(expandedCase);
    tx.orderResolutionCase.findUniqueOrThrow.mockResolvedValue(expandedCase);

    await service.requestRecheck(commercialActor, 'order-1', 'position-1', 'proposal-1', {
      expectedVersion: 1,
      reason: 'Add this position',
    });

    expect(tx.orderResolutionCase.create).not.toHaveBeenCalled();
    expect(tx.orderResolutionCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'case-existing',
        version: 3,
        status: 'open',
        openScopeKey: 'warehouse_cover:order-1',
      },
      data: {
        affectedPositionIds: ['other-position', 'position-1'],
        version: { increment: 1 },
      },
    });
    expect(tx.orderResolutionCase.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'case-existing' },
    });
  });

  it('retries the full transaction when an existing case scope CAS is stale', async () => {
    const { service, prisma, tx, audit } = await setup();
    const firstSnapshot = {
      id: 'case-existing',
      orderId: 'order-1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:order-1',
      affectedPositionIds: ['other-position'],
      version: 3,
      createdAt: new Date('2026-07-15T08:00:00.000Z'),
      updatedAt: new Date('2026-07-15T08:00:00.000Z'),
    };
    const winnerSnapshot = {
      ...firstSnapshot,
      affectedPositionIds: ['other-position', 'racing-position'],
      version: 4,
    };
    tx.orderResolutionCase.findUnique
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(winnerSnapshot);
    tx.orderResolutionCase.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const expandedCase = {
      ...winnerSnapshot,
      affectedPositionIds: ['other-position', 'racing-position', 'position-1'],
      version: 5,
    };
    tx.orderResolutionCase.update.mockResolvedValue(expandedCase);
    tx.orderResolutionCase.findUniqueOrThrow.mockResolvedValue(expandedCase);

    await service.requestRecheck(commercialActor, 'order-1', 'position-1', 'proposal-1', {
      expectedVersion: 1,
      reason: 'Merge after a concurrent expansion',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.orderResolutionCase.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'case-existing',
        version: 4,
        status: 'open',
        openScopeKey: 'warehouse_cover:order-1',
      },
      data: {
        affectedPositionIds: ['other-position', 'racing-position', 'position-1'],
        version: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('replays a position recheck against the P2002 winner and records its real case id', async () => {
    const { service, prisma, tx, audit } = await setup();
    const winner = {
      id: 'case-winner',
      orderId: 'order-1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:order-1',
      affectedPositionIds: ['position-1'],
      version: 1,
      createdAt: new Date('2026-07-15T08:00:00.000Z'),
      updatedAt: new Date('2026-07-15T08:00:00.000Z'),
    };
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['openScopeKey'] },
      }),
    );
    tx.orderResolutionCase.findUnique.mockResolvedValue(winner);

    await service.requestRecheck(commercialActor, 'order-1', 'position-1', 'proposal-1', {
      expectedVersion: 1,
      reason: 'Concurrent position request',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.orderResolutionCase.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { positionId: 'position-1', caseId: 'case-winner' } }),
      tx,
    );
  });
});
