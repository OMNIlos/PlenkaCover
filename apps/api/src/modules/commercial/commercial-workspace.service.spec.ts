import { NotFoundException } from '@nestjs/common';
import { DECORATORS } from '@nestjs/swagger';
import { capabilitiesForRole } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import {
  CommercialOrderDetailResponseDto,
  CommercialOrderSummaryDto,
  CommercialWorkspacePositionDto,
} from './dto/commercial-response.dto';
import { CommercialWorkspaceService } from './commercial-workspace.service';

const actor: Actor = {
  userId: 'commercial-user',
  role: 'commercial',
  capabilities: capabilitiesForRole('commercial'),
};

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'A-1',
    warehouseCoverageWorkflowVersion: 1,
    title: 'Срочная заявка',
    commercialFinanceNote: null,
    version: 1,
    cancellationStatus: 'active',
    cancellationVersion: 1,
    cancelledAt: null,
    cancelledById: null,
    cancellationReason: null,
    creatorRole: 'commercial',
    requestType: 'client_order',
    productionIndicator: 'not_started',
    warehouseCoverStatus: 'not_checked',
    paymentStatus: 'unpaid',
    shipmentStatus: 'not_shipped',
    commercialStage: 'incoming',
    commercialLockedAt: null,
    readyForShipmentAt: null,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-14T10:00:00.000Z'),
    counterparty: {
      id: 'counterparty-1',
      displayName: 'Контрагент',
      legalName: 'ООО Контрагент',
      inn: '7700000000',
      billingSource: 'manual_platform',
      syncStatus: 'ready',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      externalId: null,
      sourceVersion: null,
    },
    positions: [],
    coverProposals: [],
    problems: [],
    resolutionCases: [],
    productionOrder: null,
    financeOrder: null,
    ...overrides,
  };
}

function fullCoverOrder() {
  const position = {
    id: 'position-1',
    orderId: 'order-full-cover',
    rollCount: 2,
    filmType: 'ПВД',
    actualThickness: '80',
    accountingThickness: '80',
    rawMaterialId: 'raw-1',
    spoolType: '76 мм',
    birka: 'Белая',
    comment: null,
    plannedWeightKg: null,
    version: 1,
    warehouseCoverStatus: 'full_confirmed',
    updatedAt: new Date('2026-07-14T10:00:00.000Z'),
    coverProposals: [],
  };
  const proposal = {
    id: 'proposal-1',
    orderId: 'order-full-cover',
    positionId: position.id,
    coverType: 'full',
    route: 'full_cover',
    coverQty: 2,
    reserveQty: 2,
    productionQty: 0,
    status: 'full_confirmed',
    version: 2,
    sourceCapturedAt: new Date('2026-07-14T09:00:00.000Z'),
    expiresAt: null,
    commercialApprovedById: 'commercial-user' as string | null,
    commercialApprovedAt: new Date('2026-07-14T09:30:00.000Z') as Date | null,
    technicalApprovedById: 'production-user' as string | null,
    technicalApprovedAt: new Date('2026-07-14T09:40:00.000Z') as Date | null,
    createdAt: new Date('2026-07-14T09:00:00.000Z'),
    updatedAt: new Date('2026-07-14T09:40:00.000Z'),
    matches: [
      {
        compatible: true,
        criteria: {
          filmType: { expected: 'ПВД', actual: 'ПВД', matches: true },
          actualThickness: { expected: '80', actual: '80', matches: true },
          birka: { expected: 'Белая', actual: 'Белая', matches: true },
          spoolType: { expected: '76 мм', actual: '76 мм', matches: true },
          weight: { expected: 40, actual: 40, matches: true },
        },
        roll: { id: 'roll-1', rollCode: 'STK-1' },
      },
      {
        compatible: true,
        criteria: {
          filmType: { expected: 'ПВД', actual: 'ПВД', matches: true },
          actualThickness: { expected: '80', actual: '80', matches: true },
          birka: { expected: 'Белая', actual: 'Белая', matches: true },
          spoolType: { expected: '76 мм', actual: '76 мм', matches: true },
          weight: { expected: 40, actual: 40, matches: true },
        },
        roll: { id: 'roll-2', rollCode: 'STK-2' },
      },
    ],
    reservedRolls: [
      {
        id: 'roll-1',
        rollCode: 'STK-1',
        reservedForOrderId: 'order-full-cover',
        reservedForPositionId: position.id,
        reservedByProposalId: 'proposal-1',
      },
      {
        id: 'roll-2',
        rollCode: 'STK-2',
        reservedForOrderId: 'order-full-cover',
        reservedForPositionId: position.id,
        reservedByProposalId: 'proposal-1',
      },
    ],
  };
  type PositionFixture = Omit<typeof position, 'coverProposals'> & {
    coverProposals: Array<typeof proposal>;
  };
  const typedPosition = position as PositionFixture;
  typedPosition.coverProposals.push(proposal);
  return baseOrder({
    id: 'order-full-cover',
    orderNumber: 'A-FULL',
    warehouseCoverStatus: 'full_confirmed',
    positions: [typedPosition],
    coverProposals: [proposal],
  }) as Omit<ReturnType<typeof baseOrder>, 'positions' | 'coverProposals'> & {
    positions: PositionFixture[];
    coverProposals: Array<typeof proposal>;
  };
}

function productionOnlyOrder(financeOrder: Record<string, unknown>) {
  const order: any = fullCoverOrder();
  order.commercialStage = 'in_work';
  order.paymentStatus = 'partial';
  order.warehouseCoverStatus = 'needs_production';
  const position = order.positions[0];
  position.warehouseCoverStatus = 'needs_production';
  const proposal = position.coverProposals[0];
  proposal.route = 'production_only';
  proposal.status = 'needs_production';
  proposal.coverType = 'partial';
  proposal.coverQty = 0;
  proposal.reserveQty = 0;
  proposal.productionQty = position.rollCount;
  proposal.technicalApprovedById = null;
  proposal.technicalApprovedAt = null;
  proposal.matches = [];
  proposal.reservedRolls = [];
  order.coverProposals = [proposal];
  order.financeOrder = financeOrder;
  return order;
}

function setup(
  orders: Array<{ id: string }> = [baseOrder()],
  tasks: Array<Record<string, unknown>> = [],
  coverage: { read: jest.Mock; readForCommercial?: jest.Mock } = {
    read: jest.fn().mockResolvedValue({
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 2,
      generation: 1,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T08:00:00.000Z',
      stale: false,
    }),
    readForCommercial: jest.fn().mockResolvedValue({
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 2,
      generation: 1,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T08:00:00.000Z',
      stale: false,
      typeCoverage: [],
    }),
  },
) {
  const coverageProjection = {
    ...coverage,
    readForCommercial:
      coverage.readForCommercial ??
      jest.fn(async (...args: Parameters<typeof coverage.read>) => ({
        ...(await coverage.read(...args)),
        typeCoverage: [],
      })),
  };
  const fulfillmentHandoff = {
    reconcile: jest.fn().mockResolvedValue({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    }),
  };
  const prisma = {
    commercialOrder: {
      findMany: jest.fn().mockResolvedValue(orders),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(orders.find((order) => order.id === where.id) ?? null),
        ),
    },
    warehouseAcceptanceTask: {
      findMany: jest.fn().mockResolvedValue(tasks),
    },
  };
  return {
    fulfillmentHandoff,
    coverage: coverageProjection,
    prisma,
    service: new CommercialWorkspaceService(
      prisma as never,
      fulfillmentHandoff as never,
      coverageProjection as never,
    ),
  };
}

describe('CommercialWorkspaceService', () => {
  it('shows the finance note to commercial and hides it from production', async () => {
    const order = baseOrder({
      commercialFinanceNote: '1200 за 20 рулонов',
    });
    const { service } = setup([order]);
    const productionActor: Actor = {
      userId: 'production-user',
      role: 'production_lead',
      capabilities: capabilitiesForRole('production_lead'),
    };

    await expect(service.detail(actor, order.id)).resolves.toMatchObject({
      commercialFinanceNote: '1200 за 20 рулонов',
    });
    const productionDetail = await service.detail(productionActor, order.id);
    expect(productionDetail).not.toHaveProperty('commercialFinanceNote');
  });

  it('projects the persisted order comment and its independent version', async () => {
    const { service } = setup([
      baseOrder({
        comment: ' Позвонить перед отгрузкой ',
        commentVersion: 3,
        version: 7,
      }),
    ]);

    const page = await service.list(actor, {
      bucket: 'incoming',
      mode: 'current',
      limit: 20,
    });

    expect(page.items[0]).toMatchObject({
      comment: ' Позвонить перед отгрузкой ',
      commentVersion: 3,
      version: 7,
    });
  });

  it('projects a cancellation separately from payment, shipment and completed work', async () => {
    const order = baseOrder({
      cancellationStatus: 'cancelled',
      cancellationVersion: 2,
      cancelledAt: new Date('2026-08-04T10:30:00.000Z'),
      cancellationReason: 'Клиент отменил остаток',
      productionIndicator: 'in_production',
      paymentStatus: 'paid',
      shipmentStatus: 'partial_shipped',
      productionOrder: {
        id: 'production-order-1',
        dispatchItems: [
          {
            id: 'done-roll',
            rollCode: 'A-1-roll-1',
            orderLineId: null,
            status: 'done',
            completedAt: new Date('2026-08-04T09:00:00.000Z'),
            operatorLine: { warehouseState: 'received' },
          },
          {
            id: 'cancelled-roll-2',
            rollCode: 'A-1-roll-2',
            orderLineId: null,
            status: 'cancelled',
            completedAt: null,
            operatorLine: null,
          },
          {
            id: 'cancelled-roll-3',
            rollCode: 'A-1-roll-3',
            orderLineId: null,
            status: 'cancelled',
            completedAt: null,
            operatorLine: null,
          },
        ],
      },
    });
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.cancellation).toEqual({
      status: 'cancelled',
      version: 2,
      cancelledAt: '2026-08-04T10:30:00.000Z',
      reason: 'Клиент отменил остаток',
      completedRollCount: 1,
      remainingCancelledRollCount: 2,
    });
    expect(detail.indicators).toEqual({
      production: 'in_production',
      warehouseCover: 'not_checked',
      payment: 'paid',
      shipment: 'partial_shipped',
    });
    expect(detail.nextAction).toEqual({
      code: 'delete_order',
      ownerRole: 'commercial',
      label: 'Удалить заказ без возможности восстановления',
      allowed: true,
    });
    expect(detail.edit.parametersAllowed).toBe(false);
  });

  it('offers permanent deletion instead of reactivation for an untouched cancelled order', async () => {
    const order = baseOrder({ cancellationStatus: 'cancelled' });
    const { service } = setup([order]);

    await expect(service.detail(actor, order.id)).resolves.toMatchObject({
      nextAction: {
        code: 'delete_order',
        ownerRole: 'commercial',
        label: 'Удалить заказ без возможности восстановления',
        allowed: true,
      },
    });
  });

  it('offers finance handoff for an editable incoming V2 order before coverage processing', async () => {
    const order = fullCoverOrder() as any;
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    const { service } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'calculating',
        stateVersion: 1,
        generation: 0,
        availability: 'unknown',
        reasonCodes: [],
        nextOwner: 'system',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 0,
        uncertainRollCount: 2,
        calculatedAt: null,
        stale: false,
      }),
    });

    const detail = await service.detail(actor, order.id);

    expect(detail.edit.parametersAllowed).toBe(true);
    expect(detail.nextAction).toEqual({
      code: 'submit_to_finance',
      ownerRole: 'commercial',
      label: 'Передать в бухгалтерию',
      allowed: true,
    });
  });

  it('allows governed parameter amendments after finance handoff and before invoice', async () => {
    const order = baseOrder({
      commercialStage: 'sent_to_finance',
      financeOrder: {
        id: 'finance-1',
        productionClearedAt: null,
        invoiceStatus: 'not_invoiced',
        invoiceIssuedAt: null,
        invoiceSyncState: 'not_synced',
        paymentStatus: 'unpaid',
        paymentTermsType: null,
        policy: null,
        schedules: [],
      },
    });
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.edit).toMatchObject({
      parametersAllowed: false,
      parametersAmendable: true,
      parametersLockReason: null,
    });
  });

  it.each([
    {
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: null,
      invoiceSyncState: 'not_synced',
    },
    {
      invoiceStatus: 'not_invoiced',
      invoiceIssuedAt: new Date('2026-08-06T08:00:00.000Z'),
      invoiceSyncState: 'not_synced',
    },
    {
      invoiceStatus: 'not_invoiced',
      invoiceIssuedAt: null,
      invoiceSyncState: 'posted',
    },
  ])('projects an invoice parameter lock %#', async (invoiceBoundary) => {
    const order = baseOrder({
      commercialStage: 'sent_to_finance',
      financeOrder: {
        id: 'finance-1',
        productionClearedAt: null,
        paymentStatus: 'unpaid',
        paymentTermsType: null,
        policy: null,
        schedules: [],
        ...invoiceBoundary,
      },
    });
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.edit).toMatchObject({
      parametersAllowed: false,
      parametersAmendable: false,
      parametersLockReason: 'invoice_issued',
    });
  });

  it('projects literal multi-position V2 type coverage without physical roll identifiers', async () => {
    const order = fullCoverOrder() as any;
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    order.positions.push({
      ...order.positions[0],
      id: 'position-2',
      rollCount: 1,
      coverProposals: [],
    });
    const { service, coverage } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 3,
        generation: 2,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        nextOwner: 'finance',
        availableActions: [],
        requiredRollCount: 3,
        matchedRollCount: 3,
        uncertainRollCount: 0,
        calculatedAt: '2026-08-06T09:00:00.000Z',
        stale: false,
      }),
      readForCommercial: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 3,
        generation: 2,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        nextOwner: 'finance',
        availableActions: [],
        requiredRollCount: 3,
        matchedRollCount: 3,
        uncertainRollCount: 0,
        calculatedAt: '2026-08-06T09:00:00.000Z',
        stale: false,
        typeCoverage: [
          {
            positionId: 'position-1',
            label: 'ПНД 60 мкм · 1000 мм',
            requiredRollCount: 2,
            matchedRollCount: 2,
            uncertainRollCount: 0,
            requested: {
              filmType: 'ПНД',
              actualThicknessMicron: 60,
              accountingThicknessMicron: 62,
              widthMm: 1000,
              plannedLengthM: 500,
              weightKg: 40,
              spoolType: '76 мм',
              birka: 'Стандарт',
              recipeName: 'ПНД базовый',
              ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
            },
            matched: {
              filmType: 'ПНД',
              actualThicknessMicron: 60,
              accountingThicknessMicron: 62,
              widthMm: 1000,
              plannedLengthM: 500,
              weightKg: { min: 39.5, max: 40.5, total: 80 },
              spoolType: '76 мм',
              birka: 'Стандарт',
              recipeName: 'ПНД базовый',
              ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
            },
            comparison: {
              filmType: true,
              actualThickness: true,
              accountingThickness: true,
              width: true,
              plannedLength: true,
              weightTolerance: true,
              spoolType: true,
              birka: true,
              ingredients: true,
            },
            rollId: 'SECRET-PHYSICAL-ROLL-ID',
          },
          {
            positionId: 'position-2',
            label: 'ПВД 80 мкм · 1200 мм',
            requiredRollCount: 1,
            matchedRollCount: 1,
            uncertainRollCount: 0,
            requested: {
              filmType: 'ПВД',
              actualThicknessMicron: 80,
              accountingThicknessMicron: 80,
              widthMm: 1200,
              plannedLengthM: 600,
              weightKg: 50,
              spoolType: '76 мм',
              birka: 'Белая',
              recipeName: null,
              ingredients: [],
            },
            matched: {
              filmType: 'ПВД',
              actualThicknessMicron: 80,
              accountingThicknessMicron: 80,
              widthMm: 1200,
              plannedLengthM: 600,
              weightKg: { min: 49.8, max: 49.8, total: 49.8 },
              spoolType: '76 мм',
              birka: 'Белая',
              recipeName: null,
              ingredients: [],
            },
            comparison: {
              filmType: true,
              actualThickness: true,
              accountingThickness: true,
              width: true,
              plannedLength: true,
              weightTolerance: true,
              spoolType: true,
              birka: true,
              ingredients: true,
            },
            rollCode: 'SECRET-PHYSICAL-ROLL-CODE',
          },
        ],
      }),
    });

    const detail = (await service.detail(actor, order.id)) as any;

    expect(coverage.read).not.toHaveBeenCalled();
    expect(coverage.readForCommercial).toHaveBeenCalledWith(order.id, actor);
    expect(detail.warehouseCoverage).toEqual({
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 3,
      generation: 2,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: [],
      requiredRollCount: 3,
      matchedRollCount: 3,
      uncertainRollCount: 0,
      calculatedAt: '2026-08-06T09:00:00.000Z',
      stale: false,
      typeCoverage: [
        {
          positionId: 'position-1',
          label: 'ПНД 60 мкм · 1000 мм',
          requiredRollCount: 2,
          matchedRollCount: 2,
          uncertainRollCount: 0,
          requested: {
            filmType: 'ПНД',
            actualThicknessMicron: 60,
            accountingThicknessMicron: 62,
            widthMm: 1000,
            plannedLengthM: 500,
            weightKg: 40,
            spoolType: '76 мм',
            birka: 'Стандарт',
            recipeName: 'ПНД базовый',
            ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
          },
          matched: {
            filmType: 'ПНД',
            actualThicknessMicron: 60,
            accountingThicknessMicron: 62,
            widthMm: 1000,
            plannedLengthM: 500,
            weightKg: { min: 39.5, max: 40.5, total: 80 },
            spoolType: '76 мм',
            birka: 'Стандарт',
            recipeName: 'ПНД базовый',
            ingredients: [{ name: 'ПНД', shareBasisPoints: 10_000 }],
          },
          comparison: {
            filmType: true,
            actualThickness: true,
            accountingThickness: true,
            width: true,
            plannedLength: true,
            weightTolerance: true,
            spoolType: true,
            birka: true,
            ingredients: true,
          },
        },
        {
          positionId: 'position-2',
          label: 'ПВД 80 мкм · 1200 мм',
          requiredRollCount: 1,
          matchedRollCount: 1,
          uncertainRollCount: 0,
          requested: {
            filmType: 'ПВД',
            actualThicknessMicron: 80,
            accountingThicknessMicron: 80,
            widthMm: 1200,
            plannedLengthM: 600,
            weightKg: 50,
            spoolType: '76 мм',
            birka: 'Белая',
            recipeName: null,
            ingredients: [],
          },
          matched: {
            filmType: 'ПВД',
            actualThicknessMicron: 80,
            accountingThicknessMicron: 80,
            widthMm: 1200,
            plannedLengthM: 600,
            weightKg: { min: 49.8, max: 49.8, total: 49.8 },
            spoolType: '76 мм',
            birka: 'Белая',
            recipeName: null,
            ingredients: [],
          },
          comparison: {
            filmType: true,
            actualThickness: true,
            accountingThickness: true,
            width: true,
            plannedLength: true,
            weightTolerance: true,
            spoolType: true,
            birka: true,
            ingredients: true,
          },
        },
      ],
    });
    expect(JSON.stringify(detail)).not.toMatch(/roll(Id|Code)|SECRET-PHYSICAL/iu);
  });

  it('keeps V2 list rows on the base coverage read and aggregate-only payload', async () => {
    const order = fullCoverOrder() as any;
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    const { service, coverage } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 2,
        generation: 1,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        nextOwner: 'finance',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 2,
        uncertainRollCount: 0,
        calculatedAt: '2026-07-24T08:00:00.000Z',
        stale: false,
        typeCoverage: [{ positionId: 'position-1', rollId: 'SECRET-LIST-ROLL' }],
      }),
      readForCommercial: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 2,
        generation: 1,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        nextOwner: 'finance',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 2,
        uncertainRollCount: 0,
        calculatedAt: '2026-07-24T08:00:00.000Z',
        stale: false,
        typeCoverage: [],
      }),
    });

    const page = await service.list(actor, {
      bucket: 'incoming',
      mode: 'current',
      limit: 20,
    });

    expect(coverage.read).toHaveBeenCalledWith(order.id, actor);
    expect(coverage.readForCommercial).not.toHaveBeenCalled();
    expect(page.items[0]?.warehouseCoverage).toEqual({
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 2,
      generation: 1,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T08:00:00.000Z',
      stale: false,
    });
    expect(JSON.stringify(page.items[0])).not.toMatch(/typeCoverage|roll(Id|Code)|SECRET-LIST/iu);
  });

  it('keeps V1 workspace projection byte-compatible and skips V2 projection reads', async () => {
    const order = baseOrder();
    const { service, coverage } = setup([order]);

    const detail = (await service.detail(actor, order.id)) as any;

    expect(coverage.read).not.toHaveBeenCalled();
    expect(detail).not.toHaveProperty('warehouseCoverageWorkflowVersion');
    expect(detail).not.toHaveProperty('warehouseCoverage');
  });

  it('omits a V2 commercial mutation action from a reader without its capability', async () => {
    const order = productionOnlyOrder({
      invoiceStatus: 'invoiced',
      paymentStatus: 'unpaid',
      policy: {
        id: 'policy-1',
        stages: [{ id: 'shipment-stage', trigger: 'full_shipment' }],
      },
      paymentTermsType: null,
      schedules: [
        {
          paymentPolicyStageId: 'shipment-stage',
          kind: 'post_delivery',
          status: 'unpaid',
        },
      ],
    });
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    const productionActor: Actor = {
      userId: 'production-user',
      role: 'production_lead',
      capabilities: capabilitiesForRole('production_lead'),
    };
    const { service } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'production_required',
        stateVersion: 2,
        generation: 1,
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        nextOwner: 'commercial',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 0,
        uncertainRollCount: 0,
        calculatedAt: '2026-07-24T08:00:00.000Z',
        stale: false,
      }),
    });

    const detail = await service.detail(productionActor, order.id);

    expect(detail.nextAction).toEqual(
      expect.objectContaining({
        code: 'wait_send_to_production',
        ownerRole: 'commercial',
        allowed: false,
      }),
    );
    expect(detail.nextAction.label).not.toMatch(/нет прав|недоступ/u);
  });

  it('reports the exact unpaid prepayment gate after the V2 production route is chosen', async () => {
    const order = productionOnlyOrder({
      invoiceStatus: 'invoiced',
      paymentStatus: 'unpaid',
      paymentTermsType: null,
      policy: {
        id: 'policy-1',
        stages: [{ id: 'invoice-stage', trigger: 'invoice_issued' }],
      },
      schedules: [
        {
          paymentPolicyStageId: 'invoice-stage',
          kind: 'invoice_prepayment',
          status: 'unpaid',
        },
      ],
    });
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    const { service } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'production_required',
        stateVersion: 2,
        generation: 1,
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        nextOwner: 'system',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 0,
        uncertainRollCount: 0,
        calculatedAt: '2026-07-24T08:00:00.000Z',
        stale: false,
      }),
    });

    const detail = await service.detail(actor, order.id);

    expect(detail.nextAction).toEqual({
      code: 'wait_prepayment',
      ownerRole: 'finance',
      label: 'Ожидать предоплату',
      allowed: false,
    });
    expect(detail.nextAction.label).not.toMatch(/решение бухгалтерии/u);
  });

  it('does not request invoice or payment again after production clearance was captured', async () => {
    const order = productionOnlyOrder({
      productionClearedAt: new Date('2026-08-04T10:00:00.000Z'),
      invoiceStatus: 'not_invoiced',
      paymentStatus: 'unpaid',
      paymentTermsType: null,
      policy: null,
      schedules: [],
    });
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    const { service, prisma } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'production_required',
        stateVersion: 2,
        generation: 1,
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        nextOwner: 'system',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 0,
        uncertainRollCount: 0,
        calculatedAt: '2026-08-04T10:05:00.000Z',
        stale: false,
      }),
    });

    const detail = await service.detail(actor, order.id);

    expect(detail.nextAction).toEqual(
      expect.objectContaining({
        code: 'send_to_production',
        ownerRole: 'commercial',
        allowed: true,
      }),
    );
    expect(prisma.commercialOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          financeOrder: {
            select: expect.objectContaining({ productionClearedAt: true }),
          },
        }),
      }),
    );
  });

  it('keeps a stale automatic production route available for atomic handoff refresh', async () => {
    const order = productionOnlyOrder({
      productionClearedAt: new Date('2026-08-27T10:00:00.000Z'),
      invoiceStatus: 'invoiced',
      paymentStatus: 'unpaid',
      paymentTermsType: null,
      policy: null,
      schedules: [],
    });
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = {
      state: 'production_required',
      currentDecision: { kind: 'auto_produce_all' },
    };
    const { service } = setup([order], [], {
      read: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'stale',
        stateVersion: 3,
        generation: 1,
        availability: 'unavailable',
        reasonCodes: ['inventory_changed'],
        nextOwner: 'system',
        availableActions: [],
        requiredRollCount: 2,
        matchedRollCount: 0,
        uncertainRollCount: 0,
        calculatedAt: '2026-08-27T10:05:00.000Z',
        stale: true,
      }),
    });

    const detail = await service.detail(actor, order.id);

    expect(detail.nextAction).toEqual(
      expect.objectContaining({
        code: 'send_to_production',
        ownerRole: 'commercial',
        allowed: true,
      }),
    );
  });

  it('names the undecided V2 coverage step as route selection', async () => {
    const order = fullCoverOrder() as any;
    order.warehouseCoverageWorkflowVersion = 2;
    order.coverageState = null;
    order.commercialStage = 'sent_to_finance';
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.nextAction).toEqual({
      code: 'wait_coverage_decision',
      ownerRole: 'finance',
      label: 'Ожидать выбор маршрута',
      allowed: false,
    });
    expect(detail.nextAction.label).not.toMatch(/решение бухгалтерии/u);
  });

  it('documents the safe selector and immutable recipe snapshot response shape', () => {
    const fields = (
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES_ARRAY,
        CommercialWorkspacePositionDto.prototype,
      ) ?? []
    ).map((field: string) => field.slice(1));

    expect(fields).toEqual(
      expect.arrayContaining([
        'baseRawMaterialDefinitionId',
        'recipeDefinitionVersionId',
        'recipe',
      ]),
    );
    const recipe = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CommercialWorkspacePositionDto.prototype,
      'recipe',
    );
    expect(recipe?.type?.name).toBe('CommercialRecipeSnapshotDto');
    const recipeFields = (
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, recipe.type.prototype) ?? []
    ).map((field: string) => field.slice(1));
    expect(recipeFields).toEqual([
      'recipeDefinitionId',
      'recipeDefinitionVersionId',
      'recipeVersionNumber',
      'recipeName',
      'ingredients',
    ]);
  });

  it('documents explicit base and nested commercial coverage response DTOs', () => {
    const summaryCoverage = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CommercialOrderSummaryDto.prototype,
      'warehouseCoverage',
    );
    const detailCoverage = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CommercialOrderDetailResponseDto.prototype,
      'warehouseCoverage',
    );

    expect(summaryCoverage?.type?.name).toBe('WarehouseCoverageProjectionResponseDto');
    expect(detailCoverage?.type?.name).toBe('CommercialWarehouseCoverageProjectionResponseDto');

    const typeCoverage = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      detailCoverage.type.prototype,
      'typeCoverage',
    );
    const typeCoverageDto = typeCoverage.type;
    expect(typeCoverageDto.name).toBe('WarehouseCoverageTypeResponseDto');
    expect(
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, typeCoverageDto.prototype, 'requested')
        ?.type?.name,
    ).toBe('WarehouseCoverageTypeSpecificationResponseDto');
    expect(
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, typeCoverageDto.prototype, 'matched')
        ?.type?.name,
    ).toBe('WarehouseCoverageMatchedTypeSpecificationResponseDto');
    expect(
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, typeCoverageDto.prototype, 'comparison')
        ?.type?.name,
    ).toBe('WarehouseCoverageTypeComparisonResponseDto');
  });

  it('projects only stored safe selector and immutable composition fields', async () => {
    const order = fullCoverOrder();
    Object.assign(order.positions[0], {
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'version-1',
      recipe: {
        id: 'snapshot-1',
        version: 'v1',
        parameters: [{ label: 'Секретный внутренний параметр', value: 'не проецировать' }],
        source: 'commercial_form',
        createdBy: 'commercial',
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'version-1',
        recipeVersionNumber: 1,
        recipeName: 'Синяя смесь',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-1',
            name: 'Первичное',
            shareBasisPoints: 8000,
            externalId: 'unsafe-1c-id',
            cost: 123,
          },
          {
            rawMaterialDefinitionId: 'm-2',
            name: 'Синий краситель',
            shareBasisPoints: 2000,
            rawPayload: { hidden: true },
          },
        ],
      },
    });
    const { service } = setup(
      [order],
      [
        {
          id: 'task-safe-snapshot',
          orderId: order.id,
          positionId: order.positions[0].id,
          proposalId: order.positions[0].coverProposals[0].id,
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.positions[0]).toMatchObject({
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'version-1',
      recipe: {
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'version-1',
        recipeVersionNumber: 1,
        recipeName: 'Синяя смесь',
        ingredients: [
          { rawMaterialDefinitionId: 'm-1', name: 'Первичное', shareBasisPoints: 8000 },
          {
            rawMaterialDefinitionId: 'm-2',
            name: 'Синий краситель',
            shareBasisPoints: 2000,
          },
        ],
      },
    });
    expect(JSON.stringify(detail.positions[0])).not.toMatch(
      /unsafe-1c-id|rawPayload|cost|createdBy|commercial_form|Секретный/,
    );
  });

  it('projects only the latest cover proposal after a position recheck', async () => {
    const order = fullCoverOrder();
    const position = order.positions[0];
    const oldRecheckProposal = position.coverProposals[0];
    Object.assign(oldRecheckProposal, {
      id: 'proposal-z-old-recheck',
      status: 'recheck_requested',
      commercialApprovedById: null,
      commercialApprovedAt: null,
      technicalApprovedById: null,
      technicalApprovedAt: null,
      createdAt: new Date('2026-07-14T09:00:00.000Z'),
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      reservedRolls: [],
    });
    const currentProposal = {
      ...oldRecheckProposal,
      id: 'proposal-a-current',
      status: 'full_proposed',
      commercialApprovedById: null,
      commercialApprovedAt: null,
      technicalApprovedById: null,
      technicalApprovedAt: null,
      createdAt: new Date('2026-07-14T11:00:00.000Z'),
      updatedAt: new Date('2026-07-14T11:00:00.000Z'),
      matches: [],
      reservedRolls: [],
    };
    position.coverProposals = [oldRecheckProposal, currentProposal];
    order.coverProposals = [oldRecheckProposal, currentProposal];
    const { prisma, service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.positions[0].coverProposals.map((proposal) => proposal.id)).toEqual([
      currentProposal.id,
    ]);
    expect(detail.nextAction).toEqual(expect.objectContaining({ code: 'review_cover' }));
    expect(detail.commercialCompletion).toEqual(
      expect.objectContaining({ requestedQty: 2, fulfilledQty: 0, state: 'incomplete' }),
    );
    expect(prisma.commercialOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          positions: expect.objectContaining({
            select: expect.objectContaining({
              coverProposals: expect.objectContaining({
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: expect.objectContaining({ createdAt: true }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('uses the proposal id as a deterministic tie-breaker for equal creation times', async () => {
    const order = fullCoverOrder();
    const position = order.positions[0];
    const earlierIdProposal = {
      ...position.coverProposals[0],
      id: 'proposal-a',
      createdAt: new Date('2026-07-14T11:00:00.000Z'),
    };
    const laterIdProposal = {
      ...earlierIdProposal,
      id: 'proposal-b',
    };
    position.coverProposals = [earlierIdProposal, laterIdProposal];
    order.coverProposals = [earlierIdProposal, laterIdProposal];

    const detail = await setup([order]).service.detail(actor, order.id);

    expect(detail.positions[0].coverProposals.map((proposal) => proposal.id)).toEqual([
      laterIdProposal.id,
    ]);
  });

  it('ignores obsolete production quantities when choosing the next action', async () => {
    const coveredOrder = fullCoverOrder();
    const position = coveredOrder.positions[0];
    const currentProposal = {
      ...position.coverProposals[0],
      id: 'proposal-current-full-cover',
      createdAt: new Date('2026-07-14T11:00:00.000Z'),
      reservedRolls: position.coverProposals[0].reservedRolls.map((roll) => ({
        ...roll,
        reservedByProposalId: 'proposal-current-full-cover',
      })),
    };
    const obsoleteRecheck = {
      ...currentProposal,
      id: 'proposal-obsolete-recheck',
      coverType: 'partial',
      route: 'production_only',
      coverQty: 0,
      reserveQty: 0,
      productionQty: 2,
      status: 'recheck_requested',
      commercialApprovedById: null,
      commercialApprovedAt: null,
      technicalApprovedById: null,
      technicalApprovedAt: null,
      createdAt: new Date('2026-07-14T10:00:00.000Z'),
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      matches: [],
      reservedRolls: [],
    };
    position.coverProposals = [obsoleteRecheck, currentProposal];
    const order = {
      ...coveredOrder,
      commercialStage: 'in_work',
      coverProposals: [obsoleteRecheck, currentProposal],
      financeOrder: {
        invoiceStatus: 'invoiced',
        paymentStatus: 'unpaid',
        paymentTermsType: 'postpay_100_30d',
        schedules: [],
      },
    };
    const { service } = setup(
      [order],
      [
        {
          id: 'task-current-full-cover',
          orderId: order.id,
          positionId: position.id,
          proposalId: currentProposal.id,
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.commercialCompletion.state).toBe('ready_for_shipment');
    expect(detail.positions[0].coverProposals.map((proposal) => proposal.id)).toEqual([
      currentProposal.id,
    ]);
    expect(detail.nextAction.code).toBe('prepare_shipment');
  });

  it('puts a fully warehouse-covered order in completed without a production order', async () => {
    const order = fullCoverOrder();
    const { service } = setup(
      [order],
      [
        {
          id: 'task-1',
          orderId: order.id,
          positionId: 'position-1',
          proposalId: 'proposal-1',
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.productionOrderId).toBeNull();
    expect(detail.commercialCompletion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: [],
    });
    expect(detail.indicators).toEqual({
      production: 'not_started',
      warehouseCover: 'full_confirmed',
      payment: 'unpaid',
      shipment: 'not_shipped',
    });
    expect(detail.positions[0].coverProposals[0]).toEqual(
      expect.objectContaining({
        id: 'proposal-1',
        route: 'full_cover',
        commercialApproved: true,
        technicalApproved: true,
        matches: [
          expect.objectContaining({ rollId: 'roll-1', rollCode: 'STK-1', compatible: true }),
          expect.objectContaining({ rollId: 'roll-2', rollCode: 'STK-2', compatible: true }),
        ],
      }),
    );
    expect(JSON.stringify(detail)).not.toContain('positionSnapshot');
  });

  it('requires produced rolls to complete operator flow and warehouse acceptance', async () => {
    const position = {
      id: 'position-production',
      orderId: 'order-production',
      rollCount: 2,
      filmType: 'ПВД',
      actualThickness: '80',
      accountingThickness: '80',
      rawMaterialId: 'raw-1',
      spoolType: null,
      birka: null,
      comment: null,
      plannedWeightKg: null,
      version: 1,
      warehouseCoverStatus: 'needs_production',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      coverProposals: [],
    };
    const order = baseOrder({
      id: 'order-production',
      productionIndicator: 'ready',
      warehouseCoverStatus: 'needs_production',
      commercialStage: 'in_work',
      positions: [position],
      productionOrder: {
        id: 'production-order-1',
        dispatchItems: [
          {
            id: 'dispatch-1',
            rollCode: 'P-1',
            orderLineId: position.id,
            status: 'done',
            operatorLine: { warehouseState: 'received' },
          },
          {
            id: 'dispatch-2',
            rollCode: 'P-2',
            orderLineId: position.id,
            status: 'done',
            operatorLine: { warehouseState: 'ready_for_handover' },
          },
        ],
      },
    });
    const { service } = setup(
      [order],
      [
        {
          id: 'task-production',
          orderId: order.id,
          positionId: position.id,
          proposalId: null,
          mode: 'receiving',
          status: 'partial',
          rows: [{ rollCode: 'P-1', scanStatus: 'accepted' }],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.commercialCompletion).toEqual({
      state: 'incomplete',
      requestedQty: 2,
      fulfilledQty: 1,
      blockingReasons: expect.arrayContaining([
        'production_incomplete',
        'warehouse_acceptance_incomplete',
        'warehouse_batch_open',
      ]),
    });
  });

  it('projects only safe correction facts for an actionable production problem', async () => {
    const position = {
      id: 'position-problem',
      orderId: 'order-problem',
      rollCount: 3,
      filmType: 'ПВД',
      actualThickness: '80',
      accountingThickness: '80',
      rawMaterialId: 'raw-1',
      spoolType: '76 мм',
      birka: 'Белая',
      comment: null,
      plannedWeightKg: 40,
      version: 4,
      warehouseCoverStatus: 'needs_production',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      coverProposals: [],
      recipe: {
        id: 'recipe-problem',
        version: 'v2',
        parameters: [{ label: 'Толщина', value: '80' }],
      },
    };
    const operatorLine = {
      warehouseState: 'not_ready',
      spoolKg: null,
      grossKg: null,
      netKg: null,
      weightCaptures: [],
    };
    const order = baseOrder({
      id: 'order-problem',
      commercialStage: 'in_work',
      positions: [position],
      problems: [
        {
          id: 'problem-actionable',
          positionId: position.id,
          rollId: 'A-PROBLEM-roll-2',
          actorRole: 'production_lead',
          reason: 'Клиент изменил толщину',
          recovery: 'Нужна новая версия рецептуры',
          status: 'open',
          type: 'general',
          createdAt: new Date('2026-07-14T09:30:00.000Z'),
        },
      ],
      productionOrder: {
        id: 'production-problem',
        dispatchItems: [
          {
            id: 'roll-1',
            rollCode: 'A-PROBLEM-roll-1',
            orderLineId: position.id,
            positionSequence: 1,
            status: 'done',
            completedAt: new Date('2026-07-14T09:00:00.000Z'),
            operatorLine: { ...operatorLine, warehouseState: 'received', netKg: 40 },
          },
          {
            id: 'roll-2',
            rollCode: 'A-PROBLEM-roll-2',
            orderLineId: position.id,
            positionSequence: 2,
            status: 'blocked',
            completedAt: null,
            operatorLine,
          },
          {
            id: 'roll-3',
            rollCode: 'A-PROBLEM-roll-3',
            orderLineId: position.id,
            positionSequence: 3,
            status: 'assigned',
            completedAt: null,
            operatorLine,
          },
        ],
      },
    });
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.productionProblems).toEqual([
      expect.objectContaining({
        id: 'problem-actionable',
        positionId: position.id,
        reportedRollId: 'A-PROBLEM-roll-2',
        currentRollSequence: 2,
        completedRolls: 1,
        totalRolls: 3,
        ownerRole: 'commercial',
        currentRecipe: {
          snapshotId: 'recipe-problem',
          version: 'v2',
          parameters: [{ label: 'Толщина', value: '80' }],
        },
        candidateRolls: [
          expect.objectContaining({ rollCode: 'A-PROBLEM-roll-2', eligible: true }),
          expect.objectContaining({ rollCode: 'A-PROBLEM-roll-3', eligible: true }),
        ],
      }),
    ]);
    expect(JSON.stringify(detail.productionProblems)).not.toMatch(
      /grossKg|netKg|spoolKg|weightCaptures|machine|operator/,
    );
  });

  it('completes a production-only position after every roll is received in a closed batch', async () => {
    const position = {
      id: 'position-production-ready',
      orderId: 'order-production-ready',
      rollCount: 2,
      filmType: 'ПВД',
      actualThickness: '80',
      accountingThickness: '80',
      rawMaterialId: 'raw-1',
      spoolType: null,
      birka: null,
      comment: null,
      plannedWeightKg: null,
      version: 1,
      warehouseCoverStatus: 'needs_production',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      coverProposals: [],
    };
    const order = baseOrder({
      id: 'order-production-ready',
      productionIndicator: 'ready',
      warehouseCoverStatus: 'needs_production',
      commercialStage: 'in_work',
      positions: [position],
      productionOrder: {
        id: 'production-order-ready',
        dispatchItems: ['dispatch-1', 'dispatch-2'].map((id, index) => ({
          id,
          rollCode: `P-${index + 1}`,
          orderLineId: position.id,
          status: 'done',
          operatorLine: { warehouseState: 'received' },
        })),
      },
    });
    const { service } = setup(
      [order],
      [
        {
          id: 'receiving-ready',
          orderId: order.id,
          positionId: position.id,
          proposalId: null,
          mode: 'receiving',
          status: 'closed',
          rows: [
            { rollCode: 'P-1', scanStatus: 'accepted' },
            { rollCode: 'P-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.commercialCompletion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: [],
    });
  });

  it('keeps a completed order ready when its delivery task is open', async () => {
    const position = {
      id: 'position-delivery-open',
      orderId: 'order-delivery-open',
      rollCount: 2,
      filmType: 'ПВД',
      actualThickness: '80',
      accountingThickness: '80',
      rawMaterialId: 'raw-1',
      spoolType: null,
      birka: null,
      comment: null,
      plannedWeightKg: null,
      version: 1,
      warehouseCoverStatus: 'needs_production',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      coverProposals: [],
    };
    const order = baseOrder({
      id: 'order-delivery-open',
      productionIndicator: 'ready',
      warehouseCoverStatus: 'needs_production',
      commercialStage: 'in_work',
      positions: [position],
      productionOrder: {
        id: 'production-order-delivery-open',
        dispatchItems: ['PRD-1', 'PRD-2'].map((rollCode) => ({
          id: `dispatch-${rollCode}`,
          rollCode,
          orderLineId: position.id,
          status: 'done',
          operatorLine: { warehouseState: 'received' },
        })),
      },
    });
    const { service } = setup(
      [order],
      [
        {
          id: 'receiving-before-delivery',
          orderId: order.id,
          positionId: position.id,
          proposalId: null,
          mode: 'receiving',
          status: 'closed',
          rows: [
            { rollCode: 'PRD-1', scanStatus: 'accepted' },
            { rollCode: 'PRD-2', scanStatus: 'accepted' },
          ],
        },
        {
          id: 'delivery-open',
          orderId: order.id,
          positionId: position.id,
          proposalId: null,
          mode: 'delivery',
          status: 'open',
          rows: [],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.bucket).toBe('completed');
    expect(detail.commercialCompletion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: [],
    });
  });

  it('combines finalized warehouse cover with only the accepted production delta', async () => {
    const order: any = fullCoverOrder();
    order.id = 'order-partial-cover';
    order.orderNumber = 'A-PARTIAL';
    order.warehouseCoverStatus = 'partial_confirmed';
    order.productionIndicator = 'ready';
    order.commercialStage = 'in_work';
    const position = order.positions[0];
    position.orderId = order.id;
    position.warehouseCoverStatus = 'partial_confirmed';
    const proposal = position.coverProposals[0];
    proposal.orderId = order.id;
    proposal.coverType = 'partial';
    proposal.route = 'partial_cover';
    proposal.coverQty = 1;
    proposal.reserveQty = 1;
    proposal.productionQty = 1;
    proposal.status = 'partial_confirmed';
    proposal.matches = proposal.matches.slice(0, 1);
    proposal.reservedRolls = proposal.reservedRolls.slice(0, 1);
    proposal.reservedRolls[0].reservedForOrderId = order.id;
    order.coverProposals = [proposal];
    order.productionOrder = {
      id: 'production-order-partial',
      dispatchItems: [
        {
          id: 'dispatch-partial',
          rollCode: 'P-2',
          orderLineId: position.id,
          status: 'done',
          operatorLine: { warehouseState: 'received' },
        },
      ],
    };
    const tasks = [
      {
        id: 'reserve-partial',
        orderId: order.id,
        positionId: position.id,
        proposalId: proposal.id,
        mode: 'reserve',
        status: 'closed',
        rows: [{ rollCode: 'STK-1', scanStatus: 'accepted' }],
      },
      {
        id: 'receiving-partial',
        orderId: order.id,
        positionId: position.id,
        proposalId: null,
        mode: 'receiving',
        status: 'closed',
        rows: [{ rollCode: 'P-2', scanStatus: 'accepted' }],
      },
    ];
    const { service } = setup([order], tasks);

    const detail = await service.detail(actor, order.id);

    expect(detail.positions[0]).toEqual(
      expect.objectContaining({ coveredQty: 1, productionQty: 1, fulfilledQty: 2 }),
    );
    expect(detail.commercialCompletion.state).toBe('ready_for_shipment');
  });

  it('keeps an otherwise fulfilled order incomplete while a blocking problem is open', async () => {
    const order: any = fullCoverOrder();
    order.problems = [
      { id: 'problem-1', positionId: 'position-1', status: 'open', type: 'wrong_material' },
    ];
    const { service } = setup(
      [order],
      [
        {
          id: 'reserve-with-problem',
          orderId: order.id,
          positionId: 'position-1',
          proposalId: 'proposal-1',
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.commercialCompletion).toEqual({
      state: 'incomplete',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: ['blocking_problem'],
    });
  });

  it('does not trust a closed warehouse task whose rows were not accepted', async () => {
    const order = fullCoverOrder();
    const { service } = setup(
      [order],
      [
        {
          id: 'closed-but-unscanned',
          orderId: order.id,
          positionId: 'position-1',
          proposalId: 'proposal-1',
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'expected' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.commercialCompletion).toEqual(
      expect.objectContaining({
        state: 'incomplete',
        blockingReasons: expect.arrayContaining(['warehouse_acceptance_incomplete']),
      }),
    );
  });

  it('shows shipped only from the independent shipment indicator', async () => {
    const order = fullCoverOrder();
    Object.assign(order, { shipmentStatus: 'shipped' });
    const { service } = setup(
      [order],
      [
        {
          id: 'reserve-shipped',
          orderId: order.id,
          positionId: 'position-1',
          proposalId: 'proposal-1',
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const detail = await service.detail(actor, order.id);

    expect(detail.commercialCompletion.state).toBe('shipped');
    expect(detail.indicators.shipment).toBe('shipped');
  });

  it('delegates ready detail reconciliation to the fulfillment handoff', async () => {
    const order = fullCoverOrder();
    const { fulfillmentHandoff, service } = setup(
      [order],
      [
        {
          id: 'reserve-ready-event',
          orderId: order.id,
          positionId: 'position-1',
          proposalId: 'proposal-1',
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    await service.detail(actor, order.id);

    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledWith(actor, order.id);
  });

  it('does not reconcile an incomplete detail', async () => {
    const order = baseOrder();
    const { fulfillmentHandoff, service } = setup([order]);

    await service.detail(actor, order.id);

    expect(fulfillmentHandoff.reconcile).not.toHaveBeenCalled();
  });

  it('delegates list reconciliation only for non-incomplete page items', async () => {
    const ready = fullCoverOrder();
    const incomplete = baseOrder({ id: 'order-incomplete', orderNumber: 'A-INCOMPLETE' });
    const { fulfillmentHandoff, service } = setup(
      [ready, incomplete],
      [
        {
          id: 'reserve-ready-list',
          orderId: ready.id,
          positionId: 'position-1',
          proposalId: 'proposal-1',
          mode: 'reserve',
          status: 'closed',
          rows: [
            { rollCode: 'STK-1', scanStatus: 'accepted' },
            { rollCode: 'STK-2', scanStatus: 'accepted' },
          ],
        },
      ],
    );

    const page = await service.list(actor, {
      bucket: 'completed',
      mode: 'current',
      limit: 20,
    });

    expect(page.items.map((item) => item.id)).toEqual([ready.id]);
    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledTimes(1);
    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledWith(actor, ready.id);
    expect(fulfillmentHandoff.reconcile).not.toHaveBeenCalledWith(actor, incomplete.id);
  });

  it('groups an unscoped row-linked receiving task into list completion and fallback reconcile', async () => {
    const position = {
      id: 'position-row-linked',
      orderId: 'order-row-linked',
      rollCount: 1,
      filmType: 'ПВД',
      actualThickness: '80',
      accountingThickness: '80',
      rawMaterialId: 'raw-1',
      spoolType: null,
      birka: null,
      comment: null,
      plannedWeightKg: null,
      version: 1,
      warehouseCoverStatus: 'needs_production',
      updatedAt: new Date('2026-07-14T10:00:00.000Z'),
      coverProposals: [],
    };
    const order = baseOrder({
      id: 'order-row-linked',
      orderNumber: 'A-ROW-LINKED',
      productionIndicator: 'ready',
      warehouseCoverStatus: 'needs_production',
      commercialStage: 'in_work',
      positions: [position],
      productionOrder: {
        id: 'production-row-linked',
        dispatchItems: [
          {
            id: 'dispatch-row-linked',
            rollCode: 'ROLL-ROW-LINKED',
            orderLineId: position.id,
            status: 'done',
            operatorLine: { warehouseState: 'received' },
          },
        ],
      },
    });
    const { fulfillmentHandoff, prisma, service } = setup(
      [order],
      [
        {
          id: 'receiving-row-linked',
          orderId: null,
          positionId: null,
          proposalId: null,
          mode: 'receiving',
          status: 'closed',
          rows: [
            {
              rollCode: 'ROLL-ROW-LINKED',
              fromOrderId: order.orderNumber,
              scanStatus: 'accepted',
            },
          ],
        },
      ],
    );

    const page = await service.list(actor, {
      bucket: 'completed',
      mode: 'current',
      limit: 20,
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: order.id,
        commercialCompletion: expect.objectContaining({ state: 'ready_for_shipment' }),
      }),
    ]);
    expect(fulfillmentHandoff.reconcile).toHaveBeenCalledWith(actor, order.id);
    expect(prisma.warehouseAcceptanceTask.findMany).toHaveBeenCalledWith({
      where: {
        mode: { in: ['receiving', 'reserve'] },
        OR: [
          { orderId: { in: [order.id] } },
          {
            orderId: null,
            rows: { some: { fromOrderId: { in: [order.orderNumber] } } },
          },
        ],
      },
      select: expect.objectContaining({
        rows: { select: expect.objectContaining({ fromOrderId: true }) },
      }),
    });
  });

  it('exposes manual production handoff for a canonical policy without prepayment', async () => {
    const order = productionOnlyOrder({
      invoiceStatus: 'invoiced',
      paymentStatus: 'unpaid',
      policy: {
        id: 'policy-1',
        stages: [{ id: 'shipment-stage', trigger: 'full_shipment' }],
      },
      paymentTermsType: null,
      schedules: [
        {
          paymentPolicyStageId: 'shipment-stage',
          kind: 'post_delivery',
          status: 'unpaid',
        },
      ],
    });
    order.paymentStatus = 'unpaid';
    const { prisma, service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(order.productionOrder).toBeNull();
    expect(detail.productionOrderId).toBeNull();
    expect(detail.nextAction).toEqual(
      expect.objectContaining({ code: 'send_to_production', allowed: true }),
    );
    expect(prisma.commercialOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          financeOrder: {
            select: expect.objectContaining({
              policy: {
                select: {
                  id: true,
                  stages: { select: { id: true, trigger: true } },
                },
              },
              schedules: {
                select: { paymentPolicyStageId: true, kind: true, status: true },
              },
            }),
          },
        }),
      }),
    );
    expect(detail).not.toHaveProperty('financeOrder');
    expect(detail.financeSummary).not.toHaveProperty('policy');
    expect(detail.financeSummary).not.toHaveProperty('schedules');
  });

  it('routes stock production directly to production without warehouse-cover or finance gates', async () => {
    const order = productionOnlyOrder({});
    order.id = 'stock-order-1';
    order.orderNumber = 'S-1';
    order.requestType = 'stock_reserve';
    order.stockBatchCode = 'STOCK-S-1';
    order.counterparty = null;
    order.financeOrder = null;
    order.paymentStatus = 'not_applicable';
    order.shipmentStatus = 'not_applicable';
    order.productionOrder = null;
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.nextAction).toEqual({
      code: 'send_to_production',
      ownerRole: 'commercial',
      label: 'Передать производство на запас в производство',
      allowed: true,
    });
    expect(detail.counterparty).toBeNull();
    expect(detail.financeSummary).toBeNull();
  });

  it('keeps 50/50 prepay blocked until invoice prepayment is paid', async () => {
    const unpaid = productionOnlyOrder({
      invoiceStatus: 'invoiced',
      paymentStatus: 'partial',
      paymentTermsType: 'prepay_50_postpay_50_30d',
      schedules: [{ kind: 'invoice_prepayment', status: 'unpaid' }],
    });
    const paid = productionOnlyOrder({
      invoiceStatus: 'invoiced',
      paymentStatus: 'partial',
      paymentTermsType: 'prepay_50_postpay_50_30d',
      schedules: [{ kind: 'invoice_prepayment', status: 'paid' }],
    });

    const unpaidDetail = await setup([unpaid]).service.detail(actor, unpaid.id);
    const paidDetail = await setup([paid]).service.detail(actor, paid.id);

    expect(unpaid.productionOrder).toBeNull();
    expect(unpaidDetail.nextAction).toEqual(
      expect.objectContaining({ code: 'wait_prepayment', allowed: false }),
    );
    expect(paid.productionOrder).toBeNull();
    expect(paidDetail.productionOrderId).toBeNull();
    expect(paidDetail.nextAction).toEqual(
      expect.objectContaining({ code: 'send_to_production', allowed: true }),
    );
  });

  it('keeps production handoff with finance until invoice terms allow production', async () => {
    const order = productionOnlyOrder({
      invoiceStatus: 'not_invoiced',
      paymentStatus: 'partial',
      paymentTermsType: null,
      schedules: [],
    });
    const { service } = setup([order]);

    const detail = await service.detail(actor, order.id);

    expect(detail.nextAction).toEqual(
      expect.objectContaining({ code: 'wait_invoice', ownerRole: 'finance', allowed: false }),
    );
  });

  it.each(['partial', 'paid'] as const)(
    'keeps a %s pre-production order in incoming after finance clearance',
    async (paymentStatus) => {
      const order = productionOnlyOrder({
        productionClearedAt: new Date('2026-08-19T10:00:00.000Z'),
        invoiceStatus: 'invoiced',
        paymentStatus,
        paymentTermsType: null,
        policy: null,
        schedules: [],
      });
      order.paymentStatus = paymentStatus;
      order.warehouseCoverageWorkflowVersion = 2;
      const { service, prisma } = setup([order], [], {
        read: jest.fn().mockResolvedValue({
          workflowVersion: 2,
          state: 'production_required',
          stateVersion: 2,
          generation: 1,
          availability: 'unavailable',
          reasonCodes: ['no_compatible_rolls'],
          nextOwner: 'commercial',
          availableActions: [],
          requiredRollCount: 2,
          matchedRollCount: 0,
          uncertainRollCount: 0,
          calculatedAt: '2026-08-19T10:05:00.000Z',
          stale: false,
        }),
      });

      const page = await service.list(actor, {
        bucket: 'incoming',
        mode: 'current',
        limit: 20,
      });

      expect(page.items).toEqual([
        expect.objectContaining({
          id: order.id,
          bucket: 'incoming',
          nextAction: expect.objectContaining({ code: 'send_to_production', allowed: true }),
        }),
      ]);
      expect(prisma.commercialOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              {
                commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
                productionOrder: { is: null },
                requestType: { not: 'stock_reserve' },
              },
              {},
            ],
          },
        }),
      );
    },
  );

  it('uses an inclusive UTC date range', async () => {
    const { service, prisma } = setup([]);

    await service.list(actor, {
      bucket: 'incoming',
      mode: 'current',
      from: '2026-07-01',
      to: '2026-07-01',
      limit: 20,
    });

    expect(prisma.commercialOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-07-01T00:00:00.000Z'),
            lte: new Date('2026-07-01T23:59:59.999Z'),
          },
        }),
      }),
    );
  });

  it('returns only server-derived actionable rows in action-required mode', async () => {
    const draft = baseOrder({
      id: 'draft-1',
      orderNumber: 'D-1',
      commercialStage: 'draft',
    });
    const waitingForFinance = baseOrder({
      id: 'finance-1',
      orderNumber: 'A-2',
      commercialStage: 'sent_to_finance',
    });
    const { service } = setup([draft, waitingForFinance]);

    const page = await service.list(actor, {
      bucket: 'drafts',
      mode: 'action_required',
      limit: 20,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        id: 'draft-1',
        nextAction: expect.objectContaining({ code: 'promote_draft', allowed: true }),
      }),
    );
  });

  it('paginates equal timestamps deterministically without repeating an order', async () => {
    const updatedAt = new Date('2026-07-14T10:00:00.000Z');
    const orders = [
      baseOrder({ id: 'draft-1', commercialStage: 'draft', updatedAt }),
      baseOrder({ id: 'draft-2', commercialStage: 'draft', updatedAt }),
    ];
    const { service } = setup(orders);

    const first = await service.list(actor, {
      bucket: 'drafts',
      mode: 'current',
      limit: 1,
    });
    const second = await service.list(actor, {
      bucket: 'drafts',
      mode: 'current',
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });

    expect(first.items.map((item) => item.id)).toEqual(['draft-2']);
    expect(second.items.map((item) => item.id)).toEqual(['draft-1']);
    expect(second.nextCursor).toBeNull();
  });

  it('pages current work by newest update regardless of action priority', async () => {
    const orders = [
      baseOrder({
        id: 'older-problem',
        commercialStage: 'in_work',
        requestType: 'stock_reserve',
        problems: [{ id: 'problem', status: 'open' }],
      }),
      ...['newer-1', 'newer-2'].map((id) =>
        baseOrder({
          id,
          commercialStage: 'in_work',
          requestType: 'stock_reserve',
          productionOrder: { id: `production-${id}`, dispatchItems: [] },
          updatedAt: new Date('2026-07-15T10:00:00.000Z'),
        }),
      ),
    ];
    const { service } = setup(orders);
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < orders.length; pageIndex++) {
      const page = await service.list(actor, {
        bucket: 'in_work',
        mode: 'current',
        limit: 1,
        cursor,
      });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids).toEqual(['newer-2', 'newer-1', 'older-problem']);
    expect(cursor).toBeUndefined();

    const actionable = await service.list(actor, {
      bucket: 'in_work',
      mode: 'action_required',
      limit: 20,
    });
    expect(actionable.items.map((item) => item.id)).toEqual(['older-problem']);
  });

  it('keeps action priority in incoming orders', async () => {
    const { service } = setup([
      baseOrder({ id: 'newer', updatedAt: new Date('2026-07-15T10:00:00.000Z') }),
      baseOrder({ id: 'older-problem', problems: [{ id: 'problem', status: 'open' }] }),
    ]);
    const page = await service.list(actor, { bucket: 'incoming', mode: 'current', limit: 20 });
    expect(page.items.map((item) => item.id)).toEqual(['older-problem', 'newer']);
  });

  it('hides a draft from a non-commercial reader as not found', async () => {
    const draft = baseOrder({ id: 'draft-1', commercialStage: 'draft' });
    const { service } = setup([draft]);
    const productionActor: Actor = {
      userId: 'production-user',
      role: 'production_lead',
      capabilities: capabilitiesForRole('production_lead'),
    };

    await expect(service.detail(productionActor, draft.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
