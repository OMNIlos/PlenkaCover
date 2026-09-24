import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommercialService, createOrderFingerprintInput } from './commercial.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { RecipeCatalogService } from '../material-catalog/recipe-catalog.service';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { CommercialController } from './commercial.controller';
import { WarehouseCoverageCalculationService } from '../warehouse-coverage/warehouse-coverage-calculation.service';
import {
  runCoverageSerializable,
  WarehouseCoverageTransaction,
} from '../warehouse-coverage/warehouse-coverage-transaction';

const serverRecipeSelection = {
  baseRawMaterialDefinitionId: null,
  recipeDefinitionId: 'recipe-1',
  recipeDefinitionVersionId: 'version-1',
  version: 1,
  name: 'Синяя смесь',
  ingredients: [
    { rawMaterialDefinitionId: 'm-1', name: 'Первичное', shareBasisPoints: 8000 },
    { rawMaterialDefinitionId: 'm-2', name: 'Синий краситель', shareBasisPoints: 2000 },
  ],
};
const TEST_RUNTIME_CONFIG = { warehouseCoverageV2Enabled: false };

function recipeOrder(recipeDefinitionVersionId: string) {
  return {
    clientRequestId: '00000000-0000-4000-8000-000000000051',
    orderNumber: 'A-RECIPE',
    counterpartyId: 'cp1',
    requestType: 'client_order' as const,
    positions: [
      {
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80',
        accountingThickness: '75',
        widthMm: 1700,
        plannedLengthM: 275,
        recipeDefinitionVersionId,
        recipeParameters: [],
      },
    ],
  };
}

function incompleteV2HandoffOrder(commercialStage = 'incoming') {
  return {
    id: 'o1',
    orderNumber: 'A-1',
    warehouseCoverageWorkflowVersion: 2,
    counterpartyId: 'cp1',
    commercialStage,
    paymentStatus: 'unpaid',
    commercialLockedAt: null,
    financeOrder:
      commercialStage === 'sent_to_finance' ? { amountValue: 1000, amountLabel: null } : null,
    positions: [
      {
        id: 'position-1',
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80',
        accountingThickness: '78',
        widthMm: 1700,
        plannedLengthM: 275,
        birka: null,
        spoolType: '76 мм',
        plannedWeightKg: 275,
        baseRawMaterialDefinitionId: 'material-1',
        recipeDefinitionVersionId: null,
        recipe: {
          id: 'snapshot-1',
          version: 'v1',
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeVersionNumber: null,
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-1',
              name: 'ПВД',
              shareBasisPoints: 10_000,
            },
          ],
        },
      },
    ],
  };
}

function completeV2HandoffOrder(commercialStage = 'incoming') {
  const order = incompleteV2HandoffOrder(commercialStage);
  return {
    ...order,
    positions: order.positions.map((position) => ({
      ...position,
      birka: 'ГОСТ',
    })),
  };
}

function mockPrisma() {
  const prisma = {
    commercialOrder: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    counterparty: { findUnique: jest.fn() },
    counterpartyOrderTemplate: {
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    counterpartyOrderTemplateVersion: { create: jest.fn() },
    stockProductionTemplate: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    financeOrder: { upsert: jest.fn() },
  };
  return Object.assign(prisma, {
    $transaction: jest.fn(async (work: (client: typeof prisma) => unknown) => work(prisma)),
  });
}

type NestedPositionCreate = {
  [key: string]: unknown;
  recipe: { create: Record<string, unknown> };
};

type OrderCreateArgs = {
  data: {
    [key: string]: unknown;
    commercialStage?: string;
    counterpartyId: string | null;
    positions: { create: NestedPositionCreate[] };
  };
};

type CreatedOrderProjection = {
  positions: Array<{
    [key: string]: unknown;
    recipe: Record<string, unknown>;
  }>;
};

function primeCreatedOrderPersistence(prisma: ReturnType<typeof mockPrisma>, id = 'order-created') {
  let storedOrder: Record<string, unknown> | null = null;
  prisma.commercialOrder.create.mockImplementation(async ({ data }: OrderCreateArgs) => {
    storedOrder = {
      id,
      ...data,
      commercialStage: data.commercialStage ?? 'incoming',
      paymentStatus: data.paymentStatus ?? 'unpaid',
      productionIndicator: data.productionIndicator ?? 'not_started',
      warehouseCoverStatus: 'not_checked',
      shipmentStatus: data.shipmentStatus ?? 'not_shipped',
      counterparty: data.counterpartyId
        ? { id: data.counterpartyId, displayName: 'УралПак', legalName: null }
        : null,
      positions: data.positions.create.map((position, index) => ({
        id: `position-${index + 1}`,
        ...position,
        recipe: {
          id: `snapshot-${index + 1}`,
          ...JSON.parse(
            JSON.stringify({
              ...position.recipe.create,
              ingredients:
                position.recipe.create.ingredients === Prisma.DbNull
                  ? null
                  : position.recipe.create.ingredients,
            }),
          ),
        },
      })),
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
      stockProductionTemplateVersion: data.stockProductionTemplateVersionId ? { version: 2 } : null,
    };
    return { id };
  });
  prisma.commercialOrder.findUnique.mockImplementation(async () => storedOrder);
}

function createCommercialService(
  prisma: PrismaService,
  audit: { record: jest.Mock } = { record: jest.fn() },
  coverageCalculation: { initializeAtInvoiceHandoff: jest.Mock } = {
    initializeAtInvoiceHandoff: jest.fn(),
  },
  coverageTransaction: { run: jest.Mock } = { run: jest.fn() },
) {
  return new CommercialService(
    prisma,
    audit as never,
    { resolveSelections: jest.fn() } as never,
    TEST_RUNTIME_CONFIG as never,
    coverageCalculation as never,
    coverageTransaction as never,
  );
}

async function buildCommercialPositionHarness(orderState: {
  paymentStatus: string;
  commercialStage: string;
  commercialLockedAt: Date | null;
}) {
  const recipeCatalog = { resolveSelections: jest.fn() };
  const prisma: any = {
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'o1',
        ...orderState,
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      }),
    },
    commercialOrderPosition: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'pos1',
        orderId: 'o1',
        version: 1,
        rawMaterialId: null,
        baseRawMaterialDefinitionId: 'material-old',
        recipeDefinitionVersionId: null,
        order: { id: 'o1', ...orderState },
        recipe: {
          id: 'r1',
          parameters: [],
          version: 'v1',
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeVersionNumber: null,
          recipeName: 'Первичное',
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-old',
              name: 'Первичное',
              shareBasisPoints: 10_000,
            },
          ],
        },
      }),
      update: jest.fn().mockResolvedValue({ id: 'pos1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    recipeSnapshot: {
      update: jest.fn().mockResolvedValue({ id: 'r1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    domainEvent: { create: jest.fn().mockResolvedValue({ id: 'evt1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'o1' }]),
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const audit = { record: jest.fn() };
  const mod = await Test.createTestingModule({
    providers: [
      CommercialService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: RecipeCatalogService, useValue: recipeCatalog },
      { provide: RUNTIME_CONFIG, useValue: TEST_RUNTIME_CONFIG },
      {
        provide: WarehouseCoverageCalculationService,
        useValue: { initializeAtInvoiceHandoff: jest.fn() },
      },
      { provide: WarehouseCoverageTransaction, useValue: { run: jest.fn() } },
    ],
  }).compile();
  return { service: mod.get(CommercialService), prisma, recipeCatalog, audit };
}

describe('CommercialService.updateOrderComment', () => {
  const actor = { userId: 'commercial-1', role: 'commercial' as const };
  const command = { expectedVersion: 4, comment: 'Новый текст' };
  let service: CommercialService;
  let prisma: ReturnType<typeof mockPrisma>;
  let audit: { record: jest.Mock };
  let coverageCalculation: { initializeAtInvoiceHandoff: jest.Mock };
  let coverageTransaction: { run: jest.Mock };

  beforeEach(() => {
    prisma = mockPrisma();
    audit = { record: jest.fn() };
    coverageCalculation = { initializeAtInvoiceHandoff: jest.fn() };
    coverageTransaction = { run: jest.fn() };
    service = createCommercialService(
      prisma as never,
      audit,
      coverageCalculation,
      coverageTransaction,
    );
  });

  it('CAS-updates the comment and records old/new values in one transaction', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      comment: 'Старый текст',
      commentVersion: 4,
    });
    prisma.commercialOrder.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.updateOrderComment(actor, 'order-1', {
        expectedVersion: 4,
        comment: '  Новый текст  ',
      }),
    ).resolves.toEqual({ comment: 'Новый текст', commentVersion: 5 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.commercialOrder.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      select: {
        id: true,
        orderNumber: true,
        comment: true,
        commentVersion: true,
        financeOrder: { select: { id: true } },
        productionOrder: { select: { id: true } },
      },
    });
    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', commentVersion: 4 },
      data: { comment: 'Новый текст', commentVersion: { increment: 1 } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_order_comment_updated',
        actorRole: 'commercial',
        actorId: 'commercial-1',
        objectId: 'order-1',
        oldValue: { comment: 'Старый текст', commentVersion: 4 },
        newValue: { comment: 'Новый текст', commentVersion: 5 },
      }),
      prisma,
    );
  });

  it('does not mutate the aggregate version or invoke warehouse coverage behavior', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      comment: 'Старый текст',
      commentVersion: 4,
    });
    prisma.commercialOrder.updateMany.mockResolvedValue({ count: 1 });

    await service.updateOrderComment(actor, 'order-1', command);

    const update = prisma.commercialOrder.updateMany.mock.calls[0][0];
    expect(update.data).toEqual({
      comment: 'Новый текст',
      commentVersion: { increment: 1 },
    });
    expect(update.data).not.toHaveProperty('version');
    expect(coverageCalculation.initializeAtInvoiceHandoff).not.toHaveBeenCalled();
    expect(coverageTransaction.run).not.toHaveBeenCalled();
  });

  it('updates a paid posted order comment without reopening finance or production', async () => {
    const productionClearedAt = new Date('2026-08-04T10:00:00.000Z');
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'A-17',
      comment: 'Старый текст',
      commentVersion: 4,
      commercialStage: 'in_work',
      financeOrder: {
        id: 'finance-1',
        invoiceSyncState: 'posted',
        paymentStatus: 'paid',
        productionClearedAt,
      },
      productionOrder: { id: 'production-1' },
    });
    prisma.commercialOrder.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.updateOrderComment(actor, 'order-1', command)).resolves.toEqual({
      comment: 'Новый текст',
      commentVersion: 5,
    });

    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', commentVersion: 4 },
      data: { comment: 'Новый текст', commentVersion: { increment: 1 } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_order_amended',
        objectId: 'order-1',
        detail: {
          orderId: 'order-1',
          orderNumber: 'A-17',
          field: 'comment',
          recipientRoles: ['finance', 'production_lead'],
        },
      }),
      prisma,
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('normalizes whitespace-only text to null', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      comment: 'Старый текст',
      commentVersion: 4,
    });
    prisma.commercialOrder.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.updateOrderComment(actor, 'order-1', { expectedVersion: 4, comment: '   ' }),
    ).resolves.toEqual({ comment: null, commentVersion: 5 });

    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', commentVersion: 4 },
      data: { comment: null, commentVersion: { increment: 1 } },
    });
  });

  it('returns 404 without writing or auditing when the order is missing', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue(null);

    await expect(service.updateOrderComment(actor, 'missing', command)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns 409 without writing or auditing when the expected version is stale', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      comment: null,
      commentVersion: 5,
    });

    await expect(service.updateOrderComment(actor, 'order-1', command)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns 409 without auditing when the compare-and-swap loses a race', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      comment: 'Старый текст',
      commentVersion: 4,
    });
    prisma.commercialOrder.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.updateOrderComment(actor, 'order-1', command)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', commentVersion: 4 },
      data: { comment: 'Новый текст', commentVersion: { increment: 1 } },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('CommercialService.createOrder', () => {
  let service: CommercialService;
  let prisma: ReturnType<typeof mockPrisma>;
  let audit: { record: jest.Mock };
  let recipeCatalog: { resolveSelections: jest.Mock };
  let runtimeConfig: { warehouseCoverageV2Enabled: boolean };

  beforeEach(async () => {
    prisma = mockPrisma();
    audit = { record: jest.fn() };
    runtimeConfig = { warehouseCoverageV2Enabled: false };
    recipeCatalog = {
      resolveSelections: jest.fn(
        async (
          _tx: unknown,
          selectors: Array<{
            baseRawMaterialDefinitionId?: string;
            recipeDefinitionVersionId?: string;
          }>,
        ) =>
          selectors.map((selector) => {
            if (typeof selector.recipeDefinitionVersionId === 'string') {
              return {
                ...serverRecipeSelection,
                recipeDefinitionVersionId: selector.recipeDefinitionVersionId,
              };
            }
            const baseRawMaterialDefinitionId =
              selector.baseRawMaterialDefinitionId ?? 'fixture-base-material';
            return {
              baseRawMaterialDefinitionId,
              recipeDefinitionId: null,
              recipeDefinitionVersionId: null,
              version: null,
              name: 'Первичное',
              ingredients: [
                {
                  rawMaterialDefinitionId: baseRawMaterialDefinitionId,
                  name: 'Первичное',
                  shareBasisPoints: 10_000,
                },
              ],
            };
          }),
      ),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CommercialService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RecipeCatalogService, useValue: recipeCatalog },
        { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
        {
          provide: WarehouseCoverageCalculationService,
          useValue: { initializeAtInvoiceHandoff: jest.fn() },
        },
        { provide: WarehouseCoverageTransaction, useValue: { run: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CommercialService);
  });

  it('includes the selected recipe version in the idempotency fingerprint', () => {
    expect(createOrderFingerprintInput('commercial', recipeOrder('version-1'))).not.toEqual(
      createOrderFingerprintInput('commercial', recipeOrder('version-2')),
    );
  });

  it('includes roll dimensions and the separate manual label in the idempotency fingerprint', () => {
    const original = recipeOrder('version-1');

    expect(createOrderFingerprintInput('commercial', original)).not.toEqual(
      createOrderFingerprintInput('commercial', {
        ...original,
        positions: [{ ...original.positions[0], widthMm: 1600 }],
      }),
    );
    expect(createOrderFingerprintInput('commercial', original)).not.toEqual(
      createOrderFingerprintInput('commercial', {
        ...original,
        positions: [{ ...original.positions[0], plannedLengthM: 300 }],
      }),
    );
    expect(createOrderFingerprintInput('commercial', original)).not.toEqual(
      createOrderFingerprintInput('commercial', {
        ...original,
        positions: [{ ...original.positions[0], manualBirka: 'Маркировка А-17' }],
      }),
    );
  });

  it('includes the selected stock production template version in the idempotency fingerprint', () => {
    const stockOrder = {
      clientRequestId: '00000000-0000-4000-8000-000000000065',
      requestType: 'stock_reserve' as const,
      stockProductionTemplateId: 'stock-template-1',
      stockProductionTemplateVersionId: 'stock-template-version-1',
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          baseRawMaterialDefinitionId: 'material-1',
        },
      ],
    };

    expect(createOrderFingerprintInput('commercial', stockOrder)).not.toEqual(
      createOrderFingerprintInput('commercial', {
        ...stockOrder,
        stockProductionTemplateVersionId: 'stock-template-version-2',
      } as never),
    );
  });

  it('canonicalizes omitted legacy recipe parameters as an empty idempotency value', () => {
    const explicitLegacyFields = recipeOrder('version-1');
    const { recipeParameters: _legacyRecipeParameters, ...positionWithoutLegacyFields } =
      explicitLegacyFields.positions[0];
    const omittedLegacyFields = {
      ...explicitLegacyFields,
      positions: [positionWithoutLegacyFields],
    };

    expect(createOrderFingerprintInput('commercial', omittedLegacyFields)).toEqual(
      createOrderFingerprintInput('commercial', explicitLegacyFields),
    );
  });

  it('fingerprints template saving only when it is requested', () => {
    const original = recipeOrder('version-1');

    expect(createOrderFingerprintInput('commercial', original)).toEqual(
      createOrderFingerprintInput('commercial', { ...original, saveAsTemplate: false } as never),
    );
    expect(createOrderFingerprintInput('commercial', original)).not.toEqual(
      createOrderFingerprintInput('commercial', { ...original, saveAsTemplate: true } as never),
    );
  });

  it('saves the composed order as one idempotent counterparty template', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    prisma.counterpartyOrderTemplate.create.mockResolvedValue({
      id: 'template-from-order',
      name: 'Заявка A-TEMPLATE',
    });
    prisma.counterpartyOrderTemplateVersion.create.mockResolvedValue({
      id: 'template-version-from-order',
    });
    primeCreatedOrderPersistence(prisma, 'order-with-template');
    const dto = {
      ...recipeOrder('version-1'),
      orderNumber: 'A-TEMPLATE',
      saveAsTemplate: true,
    };

    const first = await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      dto as never,
    );
    const replay = await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      dto as never,
    );

    expect(replay).toEqual(first);
    expect(prisma.counterpartyOrderTemplate.create).toHaveBeenCalledTimes(1);
    expect(prisma.counterpartyOrderTemplate.create).toHaveBeenCalledWith({
      data: {
        counterpartyId: 'cp1',
        name: 'Заявка A-TEMPLATE',
        ownerRole: 'production_lead',
        createdById: 'commercial-1',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '75',
            widthMm: 1700,
            plannedLengthM: 275,
            recipeDefinitionVersionId: 'version-1',
            recipeParameters: [{ label: 'Сырьё', value: 'Синяя смесь' }],
          },
        ],
        version: 1,
      },
    });
    expect(prisma.counterpartyOrderTemplateVersion.create).toHaveBeenCalledWith({
      data: {
        templateId: 'template-from-order',
        version: 1,
        positions: expect.any(Array),
        createdById: 'commercial-1',
      },
    });
    expect(
      audit.record.mock.calls.filter(
        ([event]) => event.type === 'audit:counterparty_template_created',
      ),
    ).toEqual([
      [
        expect.objectContaining({
          type: 'audit:counterparty_template_created',
          actorRole: 'commercial',
          actorId: 'commercial-1',
          objectId: 'template-from-order',
          detail: expect.objectContaining({
            counterpartyId: 'cp1',
            sourceOrderId: 'order-with-template',
            positionCount: 1,
            version: 1,
          }),
        }),
        prisma,
      ],
    ]);
  });

  it.each([
    ['filmType', 'Пятый тип'],
    ['spoolType', 'Самодельная'],
    ['birka', 'Произвольная'],
  ])('rejects saving an order with unsupported template %s', async (field, value) => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    primeCreatedOrderPersistence(prisma, `invalid-template-${field}`);
    const original = recipeOrder('version-1');

    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        ...original,
        clientRequestId: `00000000-0000-4000-8000-${
          field === 'filmType'
            ? '000000000081'
            : field === 'spoolType'
              ? '000000000082'
              : '000000000083'
        }`,
        saveAsTemplate: true,
        positions: [{ ...original.positions[0], [field]: value }],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.counterpartyOrderTemplate.create).not.toHaveBeenCalled();
  });

  it('persists the normalized top-level comment and returns it from creation', async () => {
    primeCreatedOrderPersistence(prisma);
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);

    const created = await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000066',
        orderNumber: 'A-COMMENT',
        comment: ' Позвонить перед отгрузкой ',
        counterpartyId: 'cp1',
        requestType: 'client_order',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            baseRawMaterialDefinitionId: 'material-1',
          },
        ],
      },
    );

    expect(created).toMatchObject({
      id: 'order-created',
      comment: 'Позвонить перед отгрузкой',
    });
  });

  it('creates stock production without counterparty or finance semantics', async () => {
    primeCreatedOrderPersistence(prisma, 'stock-order');

    const order = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
      clientRequestId: '00000000-0000-4000-8000-000000000052',
      orderNumber: 'S-1',
      requestType: 'stock_reserve',
      positions: [
        {
          rollCount: 2,
          filmType: 'Полотно',
          actualThickness: '80',
          accountingThickness: '80',
          baseRawMaterialDefinitionId: 'material-1',
          plannedWeightKg: 40,
          widthMm: 1700,
          plannedLengthM: 275,
          birka: 'ГОСТ',
          manualBirka: 'Маркировка А-17',
        },
      ],
    } as never);

    expect(prisma.counterparty.findUnique).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestType: 'stock_reserve',
        counterpartyId: null,
        stockBatchCode: 'STOCK-S-1',
        paymentStatus: 'not_applicable',
        shipmentStatus: 'not_applicable',
        positions: {
          create: [
            expect.objectContaining({
              widthMm: 1700,
              plannedLengthM: 275,
              birka: 'ГОСТ',
              manualBirka: 'Маркировка А-17',
            }),
          ],
        },
      }),
    });
    expect(order).toMatchObject({
      requestType: 'stock_reserve',
      counterparty: null,
      stockBatchCode: 'STOCK-S-1',
      paymentStatus: 'not_applicable',
      shipmentStatus: 'not_applicable',
      canSendToFinance: false,
      canSendToProduction: true,
      productionHandoffState: 'ready',
    });
  });

  it('applies an immutable stock template version while preserving edited positions', async () => {
    prisma.stockProductionTemplate.findFirst.mockResolvedValue({
      id: 'st-1',
      name: 'Рукав 80 на запас',
      versions: [{ id: 'stv-2', version: 2 }],
    });
    prisma.stockProductionTemplate.update.mockResolvedValue({ id: 'st-1' });
    primeCreatedOrderPersistence(prisma, 'stock-template-order');

    const order = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
      clientRequestId: '00000000-0000-4000-8000-000000000066',
      orderNumber: 'S-TEMPLATE-1',
      requestType: 'stock_reserve',
      stockProductionTemplateId: 'st-1',
      stockProductionTemplateVersionId: 'stv-2',
      positions: [
        {
          rollCount: 4,
          filmType: 'Полотно',
          actualThickness: '40',
          accountingThickness: '40',
          baseRawMaterialDefinitionId: 'material-edited',
          plannedWeightKg: 80,
        },
      ],
    } as never);

    expect(order).toMatchObject({
      stockProductionTemplateId: 'st-1',
      stockProductionTemplateVersionId: 'stv-2',
      stockProductionTemplate: {
        id: 'st-1',
        name: 'Рукав 80 на запас',
        versionId: 'stv-2',
        version: 2,
      },
      positions: [
        expect.objectContaining({
          rollCount: 4,
          filmType: 'Полотно',
          baseRawMaterialDefinitionId: 'material-edited',
        }),
      ],
    });
    expect(recipeCatalog.resolveSelections).toHaveBeenCalledWith(prisma, [
      { baseRawMaterialDefinitionId: 'material-edited' },
    ]);
  });

  it('rejects a stock production template on a client order', async () => {
    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        ...recipeOrder('version-1'),
        stockProductionTemplateId: 'st-1',
        stockProductionTemplateVersionId: 'stv-2',
      } as never),
    ).rejects.toThrow('client_order must not use a stock production template');

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it('rejects a counterparty template on a stock order', async () => {
    await expect(
      service.createOrder(
        { userId: 'commercial-1', role: 'commercial' },
        {
          clientRequestId: '00000000-0000-4000-8000-000000000067',
          requestType: 'stock_reserve',
          templateId: 'client-template',
          templateVersionId: 'client-template-version',
          positions: [
            {
              rollCount: 1,
              filmType: 'Рукав',
              actualThickness: '80',
              accountingThickness: '80',
              baseRawMaterialDefinitionId: 'material-1',
            },
          ],
        },
      ),
    ).rejects.toThrow('stock_reserve must not use a counterparty template');

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it('rejects saving a stock order as a counterparty template', async () => {
    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        clientRequestId: '00000000-0000-4000-8000-000000000078',
        requestType: 'stock_reserve',
        saveAsTemplate: true,
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            baseRawMaterialDefinitionId: 'material-1',
          },
        ],
      } as never),
    ).rejects.toThrow('stock_reserve must not save a counterparty template');

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it.each([
    { ids: { stockProductionTemplateId: 'st-1' }, missing: 'version id' },
    { ids: { stockProductionTemplateVersionId: 'stv-2' }, missing: 'template id' },
  ])('requires paired stock template provenance when the $missing is absent', async ({ ids }) => {
    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        clientRequestId: '00000000-0000-4000-8000-000000000068',
        requestType: 'stock_reserve',
        ...ids,
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            baseRawMaterialDefinitionId: 'material-1',
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it('rejects an archived stock production template', async () => {
    prisma.stockProductionTemplate.findFirst.mockResolvedValue(null);

    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        clientRequestId: '00000000-0000-4000-8000-000000000069',
        requestType: 'stock_reserve',
        stockProductionTemplateId: 'stock-template-archived',
        stockProductionTemplateVersionId: 'stock-template-version-1',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            baseRawMaterialDefinitionId: 'material-1',
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it('rejects a stock template version belonging to another template', async () => {
    prisma.stockProductionTemplate.findFirst.mockResolvedValue({
      id: 'st-1',
      name: 'Рукав 80 на запас',
      versions: [],
    });

    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        clientRequestId: '00000000-0000-4000-8000-000000000070',
        requestType: 'stock_reserve',
        stockProductionTemplateId: 'st-1',
        stockProductionTemplateVersionId: 'stv-other-template',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            baseRawMaterialDefinitionId: 'material-1',
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it('increments stock template usage and audits only the newly inserted idempotent order', async () => {
    prisma.stockProductionTemplate.findFirst.mockResolvedValue({
      id: 'st-1',
      name: 'Рукав 80 на запас',
      versions: [{ id: 'stv-2', version: 2 }],
    });
    prisma.stockProductionTemplate.update.mockResolvedValue({ id: 'st-1' });
    primeCreatedOrderPersistence(prisma, 'stock-idempotent-order');
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000071',
      orderNumber: 'S-IDEMPOTENT',
      requestType: 'stock_reserve' as const,
      stockProductionTemplateId: 'st-1',
      stockProductionTemplateVersionId: 'stv-2',
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          baseRawMaterialDefinitionId: 'material-1',
        },
      ],
    };

    const first = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, dto);
    const replay = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, dto);

    expect(replay).toEqual(first);
    expect(prisma.commercialOrder.create).toHaveBeenCalledTimes(1);
    expect(prisma.stockProductionTemplate.update).toHaveBeenCalledTimes(1);
    expect(prisma.stockProductionTemplate.update).toHaveBeenCalledWith({
      where: { id: 'st-1' },
      data: {
        usageCount: { increment: 1 },
        lastUsedAt: expect.any(Date),
      },
    });
    expect(
      audit.record.mock.calls.filter(
        ([event]) => event.type === 'audit:stock_production_template_applied',
      ),
    ).toEqual([
      [
        expect.objectContaining({
          type: 'audit:stock_production_template_applied',
          objectId: 'stock-idempotent-order',
          detail: expect.objectContaining({
            templateId: 'st-1',
            templateVersionId: 'stv-2',
            templateVersion: 2,
          }),
        }),
        prisma,
      ],
    ]);
  });

  it('reads the rollout flag once inside create and preserves the stored version on replay', async () => {
    let transactionActive = false;
    let flagReads = 0;
    Object.defineProperty(runtimeConfig, 'warehouseCoverageV2Enabled', {
      configurable: true,
      get: () => {
        expect(transactionActive).toBe(true);
        flagReads += 1;
        return true;
      },
    });
    prisma.$transaction.mockImplementation(async (work: (client: typeof prisma) => unknown) => {
      transactionActive = true;
      try {
        return await work(prisma);
      } finally {
        transactionActive = false;
      }
    });
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    primeCreatedOrderPersistence(prisma, 'order-v2');
    const dto = recipeOrder('version-1');

    const created = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, dto);
    const replay = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, dto);

    expect(created.warehouseCoverageWorkflowVersion).toBe(2);
    expect(replay.warehouseCoverageWorkflowVersion).toBe(2);
    expect(flagReads).toBe(1);
    expect(prisma.commercialOrder.create).toHaveBeenCalledTimes(1);
    expect(prisma.commercialOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        warehouseCoverageWorkflowVersion: 2,
        coverageState: { create: {} },
      }),
    });
  });

  it('copies the server recipe composition instead of client data inside the order transaction', async () => {
    let transactionActive = false;
    prisma.$transaction.mockImplementation(async (work: (client: typeof prisma) => unknown) => {
      transactionActive = true;
      try {
        return await work(prisma);
      } finally {
        transactionActive = false;
      }
    });
    recipeCatalog.resolveSelections.mockImplementation(async (tx, selectors) => {
      expect(transactionActive).toBe(true);
      expect(tx).toBe(prisma);
      expect(selectors).toEqual([{ recipeDefinitionVersionId: 'version-1' }]);
      return [serverRecipeSelection];
    });
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    primeCreatedOrderPersistence(prisma, 'order-recipe');

    const order = await service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
      ...recipeOrder('version-1'),
      positions: [
        {
          ...recipeOrder('version-1').positions[0],
          ingredients: [
            {
              rawMaterialDefinitionId: 'client-material',
              name: 'Недоверенный состав',
              shareBasisPoints: 10_000,
            },
          ],
        },
      ],
    } as never);

    const createdOrder = order as unknown as CreatedOrderProjection;
    expect(createdOrder.positions[0]).toMatchObject({
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'version-1',
      rawMaterialId: null,
      recipe: {
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'version-1',
        recipeVersionNumber: 1,
        recipeName: 'Синяя смесь',
        ingredients: serverRecipeSelection.ingredients,
      },
    });
    expect(JSON.stringify(createdOrder.positions[0].recipe)).not.toContain('Недоверенный состав');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_recipe_snapshot_set',
        detail: expect.objectContaining({
          positions: [
            expect.objectContaining({
              recipeDefinitionVersionId: 'version-1',
              recipeName: 'Синяя смесь',
              ingredients: serverRecipeSelection.ingredients,
            }),
          ],
        }),
      }),
      prisma,
    );
  });

  it('creates a one-component immutable snapshot for a base selection', async () => {
    const baseSelection = {
      baseRawMaterialDefinitionId: 'm-base',
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      version: null,
      name: 'Первичное',
      ingredients: [
        {
          rawMaterialDefinitionId: 'm-base',
          name: 'Первичное',
          shareBasisPoints: 10_000,
        },
      ],
    };
    recipeCatalog.resolveSelections.mockResolvedValue([baseSelection]);
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    primeCreatedOrderPersistence(prisma, 'order-base');

    const order = (await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      {
        ...recipeOrder('unused'),
        clientRequestId: '00000000-0000-4000-8000-000000000052',
        positions: [
          {
            ...recipeOrder('unused').positions[0],
            recipeDefinitionVersionId: undefined,
            baseRawMaterialDefinitionId: 'm-base',
          },
        ],
      },
    )) as unknown as CreatedOrderProjection;

    expect(order.positions[0]).toMatchObject({
      baseRawMaterialDefinitionId: 'm-base',
      recipeDefinitionVersionId: null,
      rawMaterialId: null,
      recipe: {
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Первичное',
        ingredients: baseSelection.ingredients,
      },
    });
  });

  it.each(['unknown', 'archived'])(
    'returns 409 without creating an order for an %s recipe version',
    async (state) => {
      recipeCatalog.resolveSelections.mockRejectedValue(
        new ConflictException({
          code: 'RECIPE_VERSION_UNAVAILABLE',
          message: `Recipe version is ${state}.`,
        }),
      );
      prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
      primeCreatedOrderPersistence(prisma);

      await expect(
        service.createOrder(
          { userId: 'commercial-1', role: 'commercial' },
          {
            ...recipeOrder(`version-${state}`),
            clientRequestId:
              state === 'unknown'
                ? '00000000-0000-4000-8000-000000000053'
                : '00000000-0000-4000-8000-000000000054',
          },
        ),
      ).rejects.toMatchObject({ status: 409 });

      expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('returns 400 without creating an order when a position contains both selectors', async () => {
    recipeCatalog.resolveSelections.mockRejectedValue(
      new BadRequestException({
        code: 'INVALID_MATERIAL_SELECTION',
        message: 'A position must select exactly one material.',
      }),
    );
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    primeCreatedOrderPersistence(prisma);

    await expect(
      service.createOrder({ userId: 'commercial-1', role: 'commercial' }, {
        ...recipeOrder('version-1'),
        clientRequestId: '00000000-0000-4000-8000-000000000055',
        positions: [
          {
            ...recipeOrder('version-1').positions[0],
            baseRawMaterialDefinitionId: 'm-base',
          },
        ],
      } as never),
    ).rejects.toMatchObject({ status: 400 });

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['too few', []],
    ['too many', [serverRecipeSelection, null]],
  ])(
    'aborts before persistence when the recipe resolver returns %s selections',
    async (_case, malformedSelections) => {
      recipeCatalog.resolveSelections.mockResolvedValue(malformedSelections);
      prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
      primeCreatedOrderPersistence(prisma);

      await expect(
        service.createOrder(
          { userId: 'commercial-1', role: 'commercial' },
          {
            ...recipeOrder('version-1'),
            clientRequestId: '00000000-0000-4000-8000-000000000059',
          },
        ),
      ).rejects.toMatchObject({
        status: 500,
        response: expect.objectContaining({
          code: 'RECIPE_SELECTION_RESOLUTION_INVARIANT',
        }),
      });

      expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('keeps a template-only legacy position without resolving the catalog', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    prisma.counterpartyOrderTemplate.findFirst.mockResolvedValue({
      id: 'template-legacy',
      counterpartyId: 'cp1',
      name: 'Старый шаблон',
      positions: [
        {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '75',
          rawMaterialId: 'legacy-pvd',
          recipeParameters: [{ label: 'Сырье', value: 'ПВД 15803' }],
        },
      ],
    } as never);
    prisma.counterpartyOrderTemplate.update.mockResolvedValue({ id: 'template-legacy' } as never);
    primeCreatedOrderPersistence(prisma, 'order-legacy-template');

    const order = (await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000056',
        orderNumber: 'A-LEGACY-TEMPLATE',
        counterpartyId: 'cp1',
        requestType: 'client_order',
        templateId: 'template-legacy',
      },
    )) as unknown as CreatedOrderProjection;

    expect(recipeCatalog.resolveSelections).not.toHaveBeenCalled();
    expect(order.positions[0]).toMatchObject({
      rawMaterialId: 'legacy-pvd',
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipe: {
        parameters: [{ label: 'Сырье', value: 'ПВД 15803' }],
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: null,
        ingredients: null,
      },
    });
  });

  it('resolves a structured selector stored in a template inside the order transaction', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    prisma.counterpartyOrderTemplate.findFirst.mockResolvedValue({
      id: 'template-structured',
      counterpartyId: 'cp1',
      name: 'Шаблон синей смеси',
      positions: [
        {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '75',
          recipeDefinitionVersionId: 'version-1',
          recipeParameters: [],
        },
      ],
    } as never);
    prisma.counterpartyOrderTemplate.update.mockResolvedValue({
      id: 'template-structured',
    } as never);
    recipeCatalog.resolveSelections.mockResolvedValue([serverRecipeSelection]);
    primeCreatedOrderPersistence(prisma, 'order-structured-template');

    const order = (await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000058',
        orderNumber: 'A-STRUCTURED-TEMPLATE',
        counterpartyId: 'cp1',
        requestType: 'client_order',
        templateId: 'template-structured',
      },
    )) as unknown as CreatedOrderProjection;

    expect(recipeCatalog.resolveSelections).toHaveBeenCalledWith(prisma, [
      { recipeDefinitionVersionId: 'version-1' },
    ]);
    expect(order.positions[0]).toMatchObject({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'version-1',
      recipe: {
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'version-1',
        recipeVersionNumber: 1,
        recipeName: 'Синяя смесь',
        ingredients: serverRecipeSelection.ingredients,
      },
    });
  });

  it('keeps the stored snapshot unchanged when later catalog rows change', async () => {
    const selected = JSON.parse(JSON.stringify(serverRecipeSelection));
    recipeCatalog.resolveSelections.mockResolvedValue([selected]);
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    primeCreatedOrderPersistence(prisma, 'order-immutable');

    const created = (await service.createOrder(
      { userId: 'commercial-1', role: 'commercial' },
      {
        ...recipeOrder('version-1'),
        clientRequestId: '00000000-0000-4000-8000-000000000057',
      },
    )) as unknown as CreatedOrderProjection;

    selected.name = 'Переименовано позже';
    selected.ingredients[0].name = 'Изменено позже';
    const reloaded = (await service.getOrder(
      'commercial',
      'order-immutable',
    )) as unknown as CreatedOrderProjection;

    expect(created.positions[0].recipe).toEqual(reloaded.positions[0].recipe);
    expect(reloaded.positions[0].recipe).toMatchObject({
      recipeName: 'Синяя смесь',
      ingredients: expect.arrayContaining([
        expect.objectContaining({ rawMaterialDefinitionId: 'm-1', name: 'Первичное' }),
      ]),
    });
  });

  it('creates an order, snapshots the recipe, and audits recipe set', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.commercialOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'A-1' } as any);
    prisma.commercialOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
    } as any);

    await service.createOrder(
      { userId: null, role: 'commercial' },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000001',
        orderNumber: 'A-1',
        counterpartyId: 'cp1',
        requestType: 'client_order',
        positions: [
          {
            rollCount: 2,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '75 мкм',
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД' }],
          },
        ],
      },
    );

    expect(prisma.commercialOrder.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_recipe_snapshot_set',
        actorRole: 'commercial',
      }),
      prisma,
    );
  });

  it('dedupes only the same commercial create request', async () => {
    const actor = { userId: 'u1', role: 'commercial' as const };
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    };
    const fingerprint = requestFingerprint({
      actorRole: 'commercial',
      title: null,
      commercialFinanceNote: null,
      mode: 'submit',
      orderNumber: null,
      counterpartyId: 'cp1',
      requestType: 'client_order',
      templateId: null,
      templateVersionId: null,
      onBehalfOfCommercial: false,
      positions: [
        {
          ...dto.positions[0],
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: null,
          spoolType: null,
          birka: null,
          comment: null,
          plannedWeightKg: null,
        },
      ],
    });
    const existingOrder = {
      id: 'existing-order',
      orderNumber: 'A-EXISTING',
      clientRequestId: dto.clientRequestId,
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
    };
    prisma.commercialOrder.findUnique.mockResolvedValue({
      ...existingOrder,
      requestFingerprint: fingerprint,
    } as never);

    await expect(service.createOrder(actor, dto)).resolves.toMatchObject({
      id: existingOrder.id,
    });
    expect(recipeCatalog.resolveSelections).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    await expect(
      service.createOrder(actor, { ...dto, title: 'Другой заказ' }),
    ).rejects.toMatchObject({ response: { code: 'COMMERCIAL_REQUEST_ID_CONFLICT' } });
  });

  it('dedupes a no-comment replay stored with the legacy fingerprint shape', async () => {
    const actor = { userId: 'u1', role: 'commercial' as const };
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000069',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    };
    const legacyFingerprint = requestFingerprint({
      actorRole: 'commercial',
      title: null,
      mode: 'submit',
      orderNumber: null,
      counterpartyId: 'cp1',
      requestType: 'client_order',
      templateId: null,
      templateVersionId: null,
      onBehalfOfCommercial: false,
      positions: [
        {
          ...dto.positions[0],
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: null,
          spoolType: null,
          birka: null,
          comment: null,
          plannedWeightKg: null,
        },
      ],
    });
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'legacy-order',
      orderNumber: 'A-LEGACY',
      clientRequestId: dto.clientRequestId,
      requestFingerprint: legacyFingerprint,
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
    } as never);

    await expect(service.createOrder(actor, dto)).resolves.toMatchObject({
      id: 'legacy-order',
    });
    expect(recipeCatalog.resolveSelections).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a replay when only the top-level comment changes', async () => {
    primeCreatedOrderPersistence(prisma);
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    const actor = { userId: 'u1', role: 'commercial' as const };
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000067',
      orderNumber: 'A-COMMENT-REPLAY',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          baseRawMaterialDefinitionId: 'material-1',
        },
      ],
    };

    await service.createOrder(actor, { ...dto, comment: 'Позвонить клиенту' });

    await expect(
      service.createOrder(actor, { ...dto, comment: 'Написать клиенту' }),
    ).rejects.toMatchObject({ response: { code: 'COMMERCIAL_REQUEST_ID_CONFLICT' } });
    expect(prisma.commercialOrder.create).toHaveBeenCalledTimes(1);
  });

  it('dedupes a replay whose top-level comment differs only by outer whitespace', async () => {
    primeCreatedOrderPersistence(prisma);
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    const actor = { userId: 'u1', role: 'commercial' as const };
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000068',
      orderNumber: 'A-COMMENT-TRIM',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          baseRawMaterialDefinitionId: 'material-1',
        },
      ],
    };

    await service.createOrder(actor, { ...dto, comment: 'Позвонить клиенту' });

    await expect(
      service.createOrder(actor, { ...dto, comment: '  Позвонить клиенту  ' }),
    ).resolves.toMatchObject({
      id: 'order-created',
      comment: 'Позвонить клиенту',
    });
    expect(prisma.commercialOrder.create).toHaveBeenCalledTimes(1);
  });

  it('dedupes a replay whose unused template ids change from omitted to empty', async () => {
    const actor = { userId: 'u1', role: 'commercial' as const };
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    };
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'existing-order',
      orderNumber: 'A-EXISTING',
      clientRequestId: dto.clientRequestId,
      requestFingerprint: requestFingerprint(createOrderFingerprintInput(actor.role, dto)),
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
    } as never);

    await expect(
      service.createOrder(actor, { ...dto, templateId: '', templateVersionId: '' }),
    ).resolves.toMatchObject({ id: 'existing-order' });
  });

  it('dedupes a commercial replay whose delegation flag has no persistence effect', async () => {
    const actor = { userId: 'u1', role: 'commercial' as const };
    const dto = {
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    };
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'existing-order',
      orderNumber: 'A-EXISTING',
      clientRequestId: dto.clientRequestId,
      requestFingerprint: requestFingerprint(createOrderFingerprintInput(actor.role, dto)),
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
    } as never);

    await expect(
      service.createOrder(actor, { ...dto, onBehalfOfCommercial: true }),
    ).resolves.toMatchObject({ id: 'existing-order' });
  });

  it('fails closed when a legacy request key has no fingerprint', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'existing-order',
      orderNumber: 'A-EXISTING',
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      requestFingerprint: null,
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
    } as never);
    await expect(
      service.createOrder(
        { userId: 'u1', role: 'commercial' },
        {
          clientRequestId: '00000000-0000-4000-8000-000000000001',
          counterpartyId: 'cp1',
          requestType: 'client_order',
          positions: [
            {
              rollCount: 1,
              filmType: 'Рукав',
              actualThickness: '80',
              accountingThickness: '80',
              recipeParameters: [],
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'COMMERCIAL_REQUEST_ID_CONFLICT' } });
  });

  it('rejects a divergent request that loses the create race', async () => {
    const clientRequestId = '00000000-0000-4000-8000-000000000001';
    const dto = {
      clientRequestId,
      orderNumber: 'A-RACE',
      counterpartyId: 'cp1',
      requestType: 'client_order' as const,
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '80',
          recipeParameters: [],
        },
      ],
    };
    const raceWinner = {
      id: 'race-winner',
      orderNumber: 'A-RACE-WINNER',
      clientRequestId,
      requestFingerprint: requestFingerprint({ different: true }),
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
      productionOrder: null,
    };
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(raceWinner as never)
      .mockResolvedValueOnce(raceWinner as never);
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1' } as never);
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['clientRequestId'] },
      }),
    );

    await expect(
      service.createOrder({ userId: 'u1', role: 'commercial' }, dto),
    ).rejects.toMatchObject({ response: { code: 'COMMERCIAL_REQUEST_ID_CONFLICT' } });
  });

  it('records the selected template while preserving user-edited position values', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.counterpartyOrderTemplate.findFirst.mockResolvedValue({
      id: 'tpl1',
      counterpartyId: 'cp1',
      name: 'УралПак · рукав 80',
      positions: [
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          rawMaterialId: 'PVD-15803',
          spoolType: 'Шпуля 76 мм',
          birka: 'Гост',
          recipeParameters: [
            { label: 'Температура', value: '190' },
            { label: 'Сырье', value: 'ПВД 15803' },
          ],
        },
      ],
    } as any);
    prisma.counterpartyOrderTemplate.update.mockResolvedValue({ id: 'tpl1' } as any);
    prisma.commercialOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'A-1' } as any);
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      commercialStage: 'incoming',
      counterpartyTemplateId: 'tpl1',
      counterpartyTemplateName: 'УралПак · рукав 80',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
    } as any);

    await service.createOrder({ userId: 'u1', role: 'commercial' }, {
      orderNumber: 'A-1',
      counterpartyId: 'cp1',
      requestType: 'client_order',
      templateId: 'tpl1',
      positions: [
        {
          rollCount: 1,
          filmType: 'Полотно',
          actualThickness: '40 мкм',
          accountingThickness: '40 мкм',
          recipeParameters: [{ label: 'Сырье', value: 'НЕ ДОЛЖНО ПОПАСТЬ В ЗАКАЗ' }],
        },
      ],
    } as any);

    const createArg = prisma.commercialOrder.create.mock.calls[0][0].data;
    expect(createArg.counterpartyTemplateId).toBe('tpl1');
    expect(createArg.counterpartyTemplateName).toBe('УралПак · рукав 80');
    expect(createArg.positions.create).toEqual([
      expect.objectContaining({
        rollCount: 1,
        filmType: 'Полотно',
        actualThickness: '40 мкм',
        accountingThickness: '40 мкм',
        recipe: {
          create: expect.objectContaining({
            source: 'template',
            parameters: [{ label: 'Сырье', value: 'НЕ ДОЛЖНО ПОПАСТЬ В ЗАКАЗ' }],
          }),
        },
      }),
    ]);
    expect(prisma.counterpartyOrderTemplate.update).toHaveBeenCalledWith({
      where: { id: 'tpl1' },
      data: {
        usageCount: { increment: 1 },
        lastUsedAt: expect.any(Date),
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:counterparty_template_applied',
        objectId: 'o1',
        detail: expect.objectContaining({ templateId: 'tpl1' }),
      }),
      prisma,
    );
  });

  it('rejects selected template when it belongs to another counterparty', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.counterpartyOrderTemplate.findFirst.mockResolvedValue(null);

    await expect(
      service.createOrder({ userId: 'u1', role: 'commercial' }, {
        orderNumber: 'A-1',
        counterpartyId: 'cp1',
        requestType: 'client_order',
        templateId: 'tpl-other',
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.commercialOrder.create).not.toHaveBeenCalled();
  });

  it('creates a draft without production or finance handoff', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.commercialOrder.count.mockResolvedValue(0);
    prisma.commercialOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'o1',
      orderNumber: 'D-1',
      commercialStage: 'draft',
      counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
    } as any);
    prisma.commercialOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'D-1' } as any);

    await service.createOrder({ userId: null, role: 'commercial' }, {
      mode: 'draft',
      counterpartyId: 'cp1',
      requestType: 'client_order',
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '75',
          recipeParameters: [],
        },
      ],
    } as any);

    const createArg = prisma.commercialOrder.create.mock.calls[0][0].data;
    expect(createArg.orderNumber).toMatch(/^D-/);
    expect(createArg.commercialStage).toBe('draft');
    expect(createArg.draftedAt).toBeInstanceOf(Date);
    expect(prisma.financeOrder.upsert).not.toHaveBeenCalled();
  });

  it('generates a unique orderNumber when the DTO omits it', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.commercialOrder.count.mockResolvedValue(41);
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce(null) // uniqueness probe: A-42 is free
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-42',
        commercialStage: 'incoming',
        counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      } as any); // getOrder reload
    prisma.commercialOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'A-42' } as any);

    await service.createOrder({ userId: null, role: 'commercial' }, {
      counterpartyId: 'cp1',
      requestType: 'client_order',
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '75',
          recipeParameters: [],
        },
      ],
    } as any);

    const createArg = prisma.commercialOrder.create.mock.calls[0][0].data;
    expect(createArg.orderNumber).toBe('A-42');
  });

  it('retries generation past a taken number', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.commercialOrder.count.mockResolvedValue(41);
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({ id: 'taken', orderNumber: 'A-42' } as any) // A-42 taken
      .mockResolvedValueOnce(null) // A-43 free
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-43',
        commercialStage: 'incoming',
        counterparty: { id: 'cp1', displayName: 'УралПак', legalName: null },
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      } as any);
    prisma.commercialOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'A-43' } as any);

    await service.createOrder({ userId: null, role: 'commercial' }, {
      counterpartyId: 'cp1',
      requestType: 'client_order',
      positions: [
        {
          rollCount: 1,
          filmType: 'Рукав',
          actualThickness: '80',
          accountingThickness: '75',
          recipeParameters: [],
        },
      ],
    } as any);

    const createArg = prisma.commercialOrder.create.mock.calls[0][0].data;
    expect(createArg.orderNumber).toBe('A-43');
  });

  it('marks delegation + bypass policy + audits on-behalf creation', async () => {
    prisma.counterparty.findUnique.mockResolvedValue({ id: 'cp1', displayName: 'УралПак' } as any);
    prisma.commercialOrder.create.mockResolvedValue({ id: 'o2' } as any);
    prisma.commercialOrder.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'o2',
      commercialStage: 'incoming',
      counterparty: { id: 'cp1', displayName: 'УралПак' },
      positions: [],
      coverProposals: [],
      problems: [],
      financeOrder: null,
    } as any);

    await service.createOrder(
      { userId: null, role: 'production_lead' },
      {
        clientRequestId: '00000000-0000-4000-8000-000000000002',
        orderNumber: 'A-2',
        counterpartyId: 'cp1',
        requestType: 'client_order',
        onBehalfOfCommercial: true,
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '75',
            recipeParameters: [],
          },
        ],
      },
    );

    const createArg = prisma.commercialOrder.create.mock.calls[0][0].data;
    expect(createArg).toMatchObject({
      creatorRole: 'production_lead',
      recipeOwnerRole: 'commercial',
      delegationMarker: true,
      commercialConfirmationPolicy: 'bypassed_by_delegation',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:production_request_created_on_behalf_of_commercial',
      }),
      prisma,
    );
  });

  it('getOrder throws NotFound for missing order', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue(null);
    await expect(service.getOrder('commercial', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CommercialService.deleteOrder', () => {
  function harness({
    stage = 'incoming',
    cancellationStatus = 'active',
  }: { stage?: string; cancellationStatus?: string } = {}) {
    const tx = {
      warehouseRoll: { count: jest.fn().mockResolvedValue(0) },
      weightCapture: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([{ orderId: 'order-1' }])
        .mockResolvedValueOnce([{ id: 'order-1' }])
        .mockResolvedValueOnce([{ deleted: true }]),
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          orderNumber: 'З-1',
          commercialStage: stage,
          cancellationStatus,
        }),
      },
    };
    const audit = { record: jest.fn() };
    const coverageTransaction = {
      run: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    return {
      tx,
      audit,
      service: createCommercialService({} as PrismaService, audit, undefined, coverageTransaction),
    };
  }

  it('removes an untouched order aggregate and keeps an append-only deletion fact', async () => {
    const { service, tx, audit } = harness();

    await service.deleteOrder({ userId: 'commercial-1', role: 'commercial' }, 'order-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tx.$queryRaw.mock.calls[3]?.[0].strings.join('')).toContain(
      'hard_delete_commercial_order',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_order_deleted',
        objectId: 'order-1',
        actorRole: 'commercial',
        actorId: 'commercial-1',
      }),
      tx,
    );
  });

  it('deletes an order after finance and production handoff', async () => {
    const { service, tx } = harness({ stage: 'sent_to_finance' });

    await expect(
      service.deleteOrder({ userId: 'commercial-1', role: 'commercial' }, 'order-1'),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('deletes an order from a completed lifecycle stage', async () => {
    const { service, tx } = harness({ stage: 'ready_for_shipment' });

    await expect(
      service.deleteOrder({ userId: 'commercial-1', role: 'commercial' }, 'order-1'),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('preserves a cancelled order with finished rolls awaiting warehouse handover', async () => {
    const { service, tx, audit } = harness({ cancellationStatus: 'cancelled' });
    tx.weightCapture.count.mockResolvedValue(1);
    await expect(
      service.deleteOrder({ userId: 'commercial-1', role: 'commercial' }, 'order-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('CommercialService buckets and position edits', () => {
  it('returns a deterministic page for typed workspace queries', async () => {
    const prisma = {
      commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = createCommercialService(prisma);

    const result = await (service as any).listOrders('commercial', {
      bucket: 'incoming',
      mode: 'current',
      limit: 20,
    });

    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it('filters draft, incoming, and in_work buckets', async () => {
    const prisma = {
      commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = createCommercialService(prisma);

    await service.listOrders('commercial', 'drafts');
    expect(prisma.commercialOrder.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { commercialStage: 'draft' } }),
    );

    await service.listOrders('commercial', 'incoming');
    expect(prisma.commercialOrder.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          commercialStage: { in: ['incoming', 'sent_to_finance'] },
          paymentStatus: { notIn: ['partial', 'paid'] },
        },
      }),
    );

    await service.listOrders('commercial', 'in_work');
    expect(prisma.commercialOrder.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { commercialStage: 'in_work' } }),
    );
  });

  it('hides draft orders from non-commercial roles', async () => {
    const prisma = {
      commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = createCommercialService(prisma);

    await service.listOrders('finance', 'drafts');

    expect(prisma.commercialOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ commercialStage: 'draft' }, { commercialStage: { not: 'draft' } }],
        },
      }),
    );
  });

  it('updates editable position fields but ignores read-only warehouseCoverStatus', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });

    await service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
      expectedVersion: 1,
      rollCount: 3,
      rawMaterialId: 'rm-pvd-15803',
      warehouseCoverStatus: 'full_confirmed',
    } as any);

    expect(prisma.commercialOrderPosition.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'pos1', orderId: 'o1' }),
      data: expect.objectContaining({ rollCount: 3, rawMaterialId: 'rm-pvd-15803' }),
    });
    expect(prisma.commercialOrderPosition.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      'warehouseCoverStatus',
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.commercialOrderPosition.updateMany.mock.invocationCallOrder[0],
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.commercialOrderPosition.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('replaces the immutable recipe snapshot when an editable position selects another recipe', async () => {
    const { service, prisma, recipeCatalog } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });
    recipeCatalog.resolveSelections.mockResolvedValue([
      {
        baseRawMaterialDefinitionId: null,
        recipeDefinitionId: 'recipe-blue',
        recipeDefinitionVersionId: 'recipe-blue-v2',
        version: 2,
        name: 'Синяя рецептура',
        ingredients: [
          {
            rawMaterialDefinitionId: 'material-primary',
            name: 'Первичное',
            shareBasisPoints: 9_000,
          },
          {
            rawMaterialDefinitionId: 'material-blue',
            name: 'Синий краситель',
            shareBasisPoints: 1_000,
          },
        ],
      },
    ]);

    await service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
      expectedVersion: 1,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-blue-v2',
    } as never);

    expect(recipeCatalog.resolveSelections).toHaveBeenCalledWith(prisma, [
      { recipeDefinitionVersionId: 'recipe-blue-v2' },
    ]);
    expect(prisma.commercialOrderPosition.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'pos1', orderId: 'o1', version: 1 }),
      data: expect.objectContaining({
        rawMaterialId: null,
        baseRawMaterialDefinitionId: null,
        recipeDefinitionVersionId: 'recipe-blue-v2',
      }),
    });
    expect(prisma.recipeSnapshot.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ positionId: 'pos1', version: 'v1' }),
      data: expect.objectContaining({
        recipeDefinitionId: 'recipe-blue',
        recipeDefinitionVersionId: 'recipe-blue-v2',
        recipeVersionNumber: 2,
        recipeName: 'Синяя рецептура',
        version: 'v2',
      }),
    });
  });

  it('accepts warehouseCoverStatus-only compatibility patch without mutating position fields', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });

    await service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
      expectedVersion: 1,
      warehouseCoverStatus: 'full_confirmed',
    } as any);

    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(prisma.recipeSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
  });

  it('rejects position edit if guarded write sees the order locked at write time', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });
    prisma.commercialOrderPosition.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
        expectedVersion: 1,
        rollCount: 4,
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(prisma.recipeSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a stale position version before writing', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      id: 'pos1',
      orderId: 'o1',
      version: 3,
      order: {
        id: 'o1',
        paymentStatus: 'unpaid',
        commercialStage: 'incoming',
        commercialLockedAt: null,
      },
      recipe: { id: 'r1', parameters: [], version: 'v1' },
    });

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
        expectedVersion: 2,
        rollCount: 3,
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('rejects position edits after finance confirmation', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'partial',
      commercialStage: 'in_work',
      commercialLockedAt: new Date(),
    });

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
        expectedVersion: 1,
        rollCount: 3,
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
  });

  it('rejects position edits after handoff to finance', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'sent_to_finance',
      commercialLockedAt: null,
    });

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
        expectedVersion: 1,
        rollCount: 3,
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
  });

  it('returns the stable invoice lock without changing a legacy position', async () => {
    const { service, prisma, audit } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'sent_to_finance',
      commercialLockedAt: null,
    });
    prisma.financeOrder.findUnique.mockResolvedValue({
      id: 'finance-1',
      commercialOrderId: 'o1',
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: new Date('2026-08-06T08:00:00.000Z'),
      invoiceSyncState: 'posted',
    });

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
        expectedVersion: 1,
        rollCount: 3,
      } as never),
    ).rejects.toMatchObject({
      response: {
        code: 'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE',
      },
    });

    expect(prisma.commercialOrderPosition.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns canEditParameters false for an unpaid in_work order projection', async () => {
    const prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          paymentStatus: 'unpaid',
          commercialStage: 'in_work',
          commercialLockedAt: null,
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: null,
        }),
      },
    } as any;
    const service = createCommercialService(prisma);

    await expect(service.getOrder('commercial', 'o1')).resolves.toEqual(
      expect.objectContaining({ canEditParameters: false }),
    );
  });

  it('returns canEditParameters false after handoff to finance', async () => {
    const prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          paymentStatus: 'unpaid',
          commercialStage: 'sent_to_finance',
          commercialLockedAt: null,
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: null,
        }),
      },
    } as any;
    const service = createCommercialService(prisma);

    await expect(service.getOrder('commercial', 'o1')).resolves.toEqual(
      expect.objectContaining({ canEditParameters: false }),
    );
  });

  it.each(['partial', 'paid'])(
    'exposes explicit production handoff after %s payment for 50/50 terms',
    async (paymentStatus) => {
      const prisma = {
        commercialOrder: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'o1',
            paymentStatus,
            commercialStage: 'in_work',
            commercialLockedAt: new Date(),
            productionOrder: null,
            counterparty: {},
            positions: [],
            coverProposals: [],
            problems: [],
            financeOrder: {
              id: 'fo1',
              invoiceStatus: 'invoiced',
              paymentStatus,
              paymentTermsType: 'prepay_50_postpay_50_30d',
              schedules: [{ kind: 'invoice_prepayment', status: 'paid' }],
            },
          }),
        },
      } as any;
      const service = createCommercialService(prisma);

      await expect(service.getOrder('commercial', 'o1')).resolves.toEqual(
        expect.objectContaining({
          canSendToProduction: true,
          productionHandoffState: 'ready',
        }),
      );
    },
  );

  it('exposes production handoff for a canonical policy without prepayment', async () => {
    const prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          paymentStatus: 'unpaid',
          commercialStage: 'sent_to_finance',
          commercialLockedAt: new Date(),
          productionOrder: null,
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: {
            id: 'fo1',
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
          },
        }),
      },
    } as any;
    const service = createCommercialService(prisma);

    const result = await service.getOrder('commercial', 'o1');

    expect(result).toEqual(
      expect.objectContaining({ canSendToProduction: true, productionHandoffState: 'ready' }),
    );
    expect(result).not.toHaveProperty('financeOrder');
    expect(result.financeSummary).toEqual({
      id: 'fo1',
      invoiceStatus: 'invoiced',
      paymentStatus: 'unpaid',
    });
    expect(prisma.commercialOrder.findUnique).toHaveBeenCalledWith(
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
                where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
                select: { paymentPolicyStageId: true, kind: true, status: true },
              },
            }),
          },
        }),
      }),
    );
    expect(result.financeSummary).not.toHaveProperty('policy');
    expect(result.financeSummary).not.toHaveProperty('schedules');
  });

  it('keeps production handoff ready after the invoice projection is later corrected', async () => {
    const prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          paymentStatus: 'unpaid',
          commercialStage: 'sent_to_finance',
          commercialLockedAt: new Date(),
          productionOrder: null,
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: {
            id: 'fo1',
            productionClearedAt: new Date('2026-08-04T10:00:00.000Z'),
            invoiceStatus: 'not_invoiced',
            paymentStatus: 'unpaid',
            policy: null,
            paymentTermsType: null,
            schedules: [],
          },
        }),
      },
    } as any;
    const service = createCommercialService(prisma);

    await expect(service.getOrder('commercial', 'o1')).resolves.toEqual(
      expect.objectContaining({
        canSendToProduction: true,
        productionHandoffState: 'ready',
      }),
    );
    expect(prisma.commercialOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          financeOrder: {
            select: expect.objectContaining({ productionClearedAt: true }),
          },
        }),
      }),
    );
  });

  it('marks an existing production order as already sent', async () => {
    const prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          paymentStatus: 'paid',
          commercialStage: 'in_work',
          commercialLockedAt: new Date(),
          productionOrder: { id: 'po1' },
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: null,
        }),
      },
    } as any;
    const service = createCommercialService(prisma);

    await expect(service.getOrder('commercial', 'o1')).resolves.toEqual(
      expect.objectContaining({
        canSendToProduction: false,
        productionHandoffState: 'sent',
      }),
    );
  });

  it('does not expose draft order details to non-commercial roles', async () => {
    const prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          paymentStatus: 'unpaid',
          commercialStage: 'draft',
          commercialLockedAt: null,
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: null,
        }),
      },
    } as any;
    const service = createCommercialService(prisma);

    await expect(service.getOrder('finance', 'o1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('patching recipeParameters increments recipe version and audits correction old/new', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      id: 'pos1',
      orderId: 'o1',
      version: 1,
      order: {
        id: 'o1',
        paymentStatus: 'unpaid',
        commercialStage: 'incoming',
        commercialLockedAt: null,
      },
      recipe: {
        id: 'r1',
        positionId: 'pos1',
        parameters: [{ label: 'T', value: '1' }],
        version: 'v1',
      },
    });

    await service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
      expectedVersion: 1,
      recipeParameters: [{ label: 'T', value: '2' }],
      warehouseCoverStatus: 'full_confirmed',
    } as any);

    expect(prisma.recipeSnapshot.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ positionId: 'pos1' }),
      data: {
        parameters: [{ label: 'T', value: '2' }],
        version: 'v2',
      },
    });
    expect(prisma.domainEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        family: 'audit',
        type: 'audit:recipe_correction_applied',
        actorRole: 'commercial',
        actorId: 'u1',
        objectId: 'o1',
        oldValue: {
          parameters: [{ label: 'T', value: '1' }],
          version: 'v1',
        },
        newValue: {
          parameters: [{ label: 'T', value: '2' }],
          version: 'v2',
        },
      }),
    });
  });

  it('rejects recipe patch if the recipe version changed before write', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });
    prisma.recipeSnapshot.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o1', 'pos1', {
        expectedVersion: 1,
        recipeParameters: [{ label: 'T', value: '2' }],
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('throws NotFound for mismatched orderId and positionId without updating', async () => {
    const { service, prisma } = await buildCommercialPositionHarness({
      paymentStatus: 'unpaid',
      commercialStage: 'incoming',
      commercialLockedAt: null,
    });
    prisma.commercialOrderPosition.findFirst.mockResolvedValue(null);

    await expect(
      service.updatePosition({ userId: 'u1', role: 'commercial' }, 'o-mismatch', 'pos1', {
        expectedVersion: 1,
        rollCount: 3,
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.commercialOrderPosition.update).not.toHaveBeenCalled();
    expect(prisma.recipeSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });
});

describe('CommercialService cover decisions', () => {
  let service: CommercialService;
  let prisma: any;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          orderNumber: 'A-1',
          version: 7,
          warehouseCoverageWorkflowVersion: 1,
          commercialStage: 'incoming',
          shipmentStatus: 'not_shipped',
          warehouseCoverStatus: 'not_checked',
          counterparty: {},
          positions: [{ id: 'pos1' }],
          coverProposals: [],
          problems: [],
          financeOrder: null,
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderResolutionCase: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'case-1',
          orderId: 'o1',
          type: 'warehouse_cover_check',
          status: 'open',
          ownerRole: 'warehouse',
          openScopeKey: 'warehouse_cover:o1',
          affectedPositionIds: ['pos1'],
          createdAt: new Date('2026-07-15T08:00:00.000Z'),
          updatedAt: new Date('2026-07-15T08:00:00.000Z'),
          reason: 'internal-reason-must-not-leak',
          createdById: 'commercial-1',
        }),
      },
      warehouseCoverProposal: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      commercialOrderPosition: { findUnique: jest.fn(), update: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (work: (client: typeof prisma) => unknown) => work(prisma));
    audit = { record: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        CommercialService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RecipeCatalogService, useValue: { resolveSelections: jest.fn() } },
        { provide: RUNTIME_CONFIG, useValue: TEST_RUNTIME_CONFIG },
        {
          provide: WarehouseCoverageCalculationService,
          useValue: { initializeAtInvoiceHandoff: jest.fn() },
        },
        { provide: WarehouseCoverageTransaction, useValue: { run: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CommercialService);
  });

  it('confirmCover sets full_confirmed and audits confirmed', async () => {
    prisma.warehouseCoverProposal.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      coverType: 'full',
      status: 'full_proposed',
    });
    prisma.warehouseCoverProposal.update.mockResolvedValue({ id: 'p1', status: 'full_confirmed' });
    await service.confirmCover({ userId: null, role: 'commercial' }, 'o1', 'p1');
    expect(prisma.warehouseCoverProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1' }, data: { status: 'full_confirmed' } }),
    );
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        data: { warehouseCoverStatus: 'full_confirmed' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_cover_confirmed' }),
    );
  });

  it('requestCoverCheck atomically creates one warehouse-owned case, CASes cover, and audits', async () => {
    const result = await service.requestCoverCheck(
      { userId: 'commercial-1', role: 'commercial' },
      'o1',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.orderResolutionCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'o1',
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        openScopeKey: 'warehouse_cover:o1',
        affectedPositionIds: ['pos1'],
        createdByRole: 'commercial',
        createdById: 'commercial-1',
      }),
    });
    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'o1',
        version: 7,
        commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
        shipmentStatus: { not: 'shipped' },
        readyForShipmentAt: null,
        shipmentCompletedAt: null,
      }),
      data: {
        warehouseCoverStatus: 'recheck_requested',
        version: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_cover_recheck_requested',
        objectId: 'o1',
        detail: { orderId: 'o1', orderNumber: 'A-1', caseId: 'case-1' },
      }),
      prisma,
    );
    expect(result).toEqual({
      order: expect.objectContaining({
        id: 'o1',
        version: 8,
        warehouseCoverStatus: 'recheck_requested',
      }),
      case: expect.objectContaining({ id: 'case-1', state: 'open', ownerRole: 'warehouse' }),
    });
  });

  it('rejects the legacy order recheck route for V2 before creating a case or auditing', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      version: 7,
      warehouseCoverageWorkflowVersion: 2,
      commercialStage: 'incoming',
      shipmentStatus: 'not_shipped',
      warehouseCoverStatus: 'not_checked',
      counterparty: {},
      positions: [{ id: 'pos1' }],
      coverProposals: [],
      problems: [],
      financeOrder: null,
    });

    await expect(
      service.requestCoverCheck({ userId: 'commercial-1', role: 'commercial' }, 'o1'),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 1,
        actual: 2,
      },
    });
    expect(prisma.orderResolutionCase.create).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('requestCoverCheck returns the current order and open case on a compatible retry', async () => {
    const openCase = {
      id: 'case-existing',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['pos1'],
      createdAt: new Date('2026-07-15T08:00:00.000Z'),
      updatedAt: new Date('2026-07-15T08:00:00.000Z'),
    };
    prisma.orderResolutionCase.findUnique.mockResolvedValue(openCase);

    const result = await service.requestCoverCheck(
      { userId: 'commercial-1', role: 'commercial' },
      'o1',
    );

    expect(result).toEqual({
      order: expect.objectContaining({ id: 'o1', version: 7 }),
      case: {
        id: 'case-existing',
        orderId: 'o1',
        state: 'open',
        ownerRole: 'warehouse',
        affectedPositionIds: ['pos1'],
        requestedAt: '2026-07-15T08:00:00.000Z',
        updatedAt: '2026-07-15T08:00:00.000Z',
      },
    });
    expect(prisma.orderResolutionCase.create).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('requestCoverCheck maps its case to the safe shared command projection', async () => {
    const result = await service.requestCoverCheck(
      { userId: 'commercial-1', role: 'commercial' },
      'o1',
    );

    expect(result.case).toEqual({
      id: 'case-1',
      orderId: 'o1',
      state: 'open',
      ownerRole: 'warehouse',
      affectedPositionIds: ['pos1'],
      requestedAt: '2026-07-15T08:00:00.000Z',
      updatedAt: '2026-07-15T08:00:00.000Z',
    });
    expect(JSON.stringify(result.case)).not.toContain('openScopeKey');
    expect(JSON.stringify(result.case)).not.toContain('internal-reason-must-not-leak');
    expect(JSON.stringify(result.case)).not.toContain('createdById');
  });

  it('requestCoverCheck recovers a concurrent openScopeKey race by reading the winner', async () => {
    const winner = {
      id: 'case-winner',
      orderId: 'o1',
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey: 'warehouse_cover:o1',
      affectedPositionIds: ['pos1'],
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
    prisma.orderResolutionCase.findUnique.mockResolvedValueOnce(winner);

    const result = await service.requestCoverCheck(
      { userId: 'commercial-1', role: 'commercial' },
      'o1',
    );

    expect(result).toEqual({
      order: expect.objectContaining({ id: 'o1' }),
      case: {
        id: 'case-winner',
        orderId: 'o1',
        state: 'open',
        ownerRole: 'warehouse',
        affectedPositionIds: ['pos1'],
        requestedAt: '2026-07-15T08:00:00.000Z',
        updatedAt: '2026-07-15T08:00:00.000Z',
      },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [
      'draft',
      { commercialStage: 'draft', shipmentStatus: 'not_shipped', positions: [{ id: 'p1' }] },
    ],
    [
      'completed',
      {
        commercialStage: 'in_work',
        shipmentStatus: 'not_shipped',
        readyForShipmentAt: new Date('2026-07-15T09:00:00.000Z'),
        positions: [{ id: 'p1' }],
      },
    ],
    [
      'shipped',
      { commercialStage: 'in_work', shipmentStatus: 'shipped', positions: [{ id: 'p1' }] },
    ],
    [
      'without positions',
      { commercialStage: 'incoming', shipmentStatus: 'not_shipped', positions: [] },
    ],
  ])(
    'requestCoverCheck rejects a non-actionable %s order without side effects',
    async (_name, state) => {
      prisma.commercialOrder.findUnique.mockResolvedValue({
        id: 'o1',
        orderNumber: 'A-1',
        version: 7,
        warehouseCoverageWorkflowVersion: 1,
        warehouseCoverStatus: 'not_checked',
        counterparty: {},
        coverProposals: [],
        problems: [],
        financeOrder: null,
        ...state,
      });

      await expect(
        service.requestCoverCheck({ userId: 'commercial-1', role: 'commercial' }, 'o1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.orderResolutionCase.create).not.toHaveBeenCalled();
      expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('requestCoverCheck creates a new case after the prior open scope was cleared', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      version: 9,
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'in_work',
      shipmentStatus: 'not_shipped',
      warehouseCoverStatus: 'full_proposed',
      counterparty: {},
      positions: [{ id: 'pos1' }],
      coverProposals: [],
      problems: [],
      financeOrder: null,
    });

    await service.requestCoverCheck({ userId: 'commercial-1', role: 'commercial' }, 'o1');

    expect(prisma.orderResolutionCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openScopeKey: 'warehouse_cover:o1' }),
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejectCover requires reason and audits rejected', async () => {
    prisma.warehouseCoverProposal.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      status: 'full_proposed',
    });
    prisma.warehouseCoverProposal.update.mockResolvedValue({ id: 'p1', status: 'rejected' });
    await service.rejectCover({ userId: null, role: 'commercial' }, 'o1', 'p1', {
      reason: 'wrong rolls',
    });
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1' }, data: { warehouseCoverStatus: 'rejected' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_cover_rejected', reason: 'wrong rolls' }),
    );
  });

  it('selectWarehouseCoverRoute persists a commercial partial cover decision', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        warehouseCoverStatus: 'not_checked',
        productionIndicator: 'not_started',
        commercialStage: 'incoming',
        commercialLockedAt: null,
        positions: [
          {
            id: 'pos1',
            rollCount: 3,
            warehouseCoverStatus: 'not_checked',
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'o1',
        commercialStage: 'incoming',
        counterparty: {},
        positions: [{ id: 'pos1', rollCount: 3, warehouseCoverStatus: 'partial_proposed' }],
        coverProposals: [
          {
            id: 'wp1',
            positionId: 'pos1',
            coverType: 'partial',
            coverQty: 2,
            reserveQty: 2,
            productionQty: 1,
            status: 'partial_proposed',
            matchedRollIds: [],
            createdAt: new Date('2026-07-08T10:00:00.000Z'),
          },
        ],
        problems: [],
        financeOrder: null,
      });
    prisma.warehouseCoverProposal.findFirst.mockResolvedValue(null);
    prisma.warehouseCoverProposal.create.mockResolvedValue({ id: 'wp1' });

    await service.selectWarehouseCoverRoute({ userId: 'u1', role: 'commercial' }, 'o1', {
      positionId: 'pos1',
      status: 'partial_proposed',
      coverQty: 2,
      reason: 'Коммерция выбрала часть сырьем',
    });

    expect(prisma.warehouseCoverProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'o1',
        positionId: 'pos1',
        coverType: 'partial',
        coverQty: 2,
        reserveQty: 2,
        productionQty: 1,
        status: 'partial_proposed',
      }),
    });
    expect(prisma.commercialOrderPosition.update).toHaveBeenCalledWith({
      where: { id: 'pos1' },
      data: { warehouseCoverStatus: 'partial_proposed' },
    });
    expect(prisma.commercialOrder.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: {
        warehouseCoverStatus: 'partial_proposed',
        productionIndicator: 'needs_production',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_warehouse_cover_route_selected',
        actorRole: 'commercial',
        objectId: 'o1',
        reason: 'Коммерция выбрала часть сырьем',
        newValue: expect.objectContaining({
          positionId: 'pos1',
          status: 'partial_proposed',
          coverQty: 2,
          productionQty: 1,
        }),
      }),
    );
  });
});

describe('CommercialService.forceProduction', () => {
  let service: CommercialService;
  let prisma: any;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      commercialOrder: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    audit = { record: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        CommercialService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RecipeCatalogService, useValue: { resolveSelections: jest.fn() } },
        { provide: RUNTIME_CONFIG, useValue: TEST_RUNTIME_CONFIG },
        {
          provide: WarehouseCoverageCalculationService,
          useValue: { initializeAtInvoiceHandoff: jest.fn() },
        },
        { provide: WarehouseCoverageTransaction, useValue: { run: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CommercialService);
  });

  it('moves the whole order to production and audits old/new state', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        warehouseCoverageWorkflowVersion: 1,
        warehouseCoverStatus: 'full_confirmed',
        productionIndicator: 'not_started',
      })
      .mockResolvedValueOnce({
        id: 'o1',
        warehouseCoverStatus: 'needs_production',
        productionIndicator: 'needs_production',
        commercialStage: 'incoming',
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      });

    await service.forceProduction({ userId: 'u1', role: 'commercial' }, 'o1', {
      reason: 'клиент срочно',
    });

    expect(prisma.commercialOrder.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: {
        warehouseCoverStatus: 'needs_production',
        productionIndicator: 'needs_production',
      },
    });
    expect(audit.record).toHaveBeenCalledWith({
      type: 'audit:warehouse_cover_forced_production',
      actorRole: 'commercial',
      actorId: 'u1',
      objectId: 'o1',
      reason: 'клиент срочно',
      oldValue: {
        warehouseCoverStatus: 'full_confirmed',
        productionIndicator: 'not_started',
      },
      newValue: {
        warehouseCoverStatus: 'needs_production',
        productionIndicator: 'needs_production',
      },
    });
  });

  it('rejects an order that is already in production', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      warehouseCoverageWorkflowVersion: 1,
      warehouseCoverStatus: 'needs_production',
      productionIndicator: 'in_production',
    });

    await expect(
      service.forceProduction({ userId: 'u1', role: 'commercial' }, 'o1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
  });

  it('rejects the legacy force-production route for V2 before mutation', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      warehouseCoverageWorkflowVersion: 2,
      warehouseCoverStatus: 'full_confirmed',
      productionIndicator: 'not_started',
    });

    await expect(
      service.forceProduction({ userId: 'u1', role: 'commercial' }, 'o1', {
        reason: 'legacy override',
      }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 1,
        actual: 2,
      },
    });
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('throws NotFound for a missing order', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue(null);

    await expect(
      service.forceProduction({ userId: 'u1', role: 'commercial' }, 'missing', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CommercialService corrections & handoff', () => {
  let service: CommercialService;
  let prisma: any;
  let audit: { record: jest.Mock; forObject: jest.Mock };
  let coverageCalculation: { initializeAtInvoiceHandoff: jest.Mock };
  let coverageTransaction: { run: jest.Mock };

  beforeEach(async () => {
    prisma = {
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'o1',
          orderNumber: 'A-1',
          commercialStage: 'incoming',
          paymentStatus: 'unpaid',
          commercialLockedAt: null,
          counterparty: {},
          positions: [],
          coverProposals: [],
          problems: [],
          financeOrder: null,
        }),
      },
      commercialOrderPosition: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pos1',
          orderId: 'o1',
          order: { commercialStage: 'incoming', paymentStatus: 'unpaid', commercialLockedAt: null },
          recipe: {
            id: 'r1',
            positionId: 'pos1',
            parameters: [{ label: 'T', value: '1' }],
            version: 'v1',
          },
        }),
      },
      recipeSnapshot: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      domainEvent: { create: jest.fn().mockResolvedValue({ id: 'evt1' }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'o1' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    audit = { record: jest.fn(), forObject: jest.fn().mockResolvedValue([]) };
    coverageCalculation = { initializeAtInvoiceHandoff: jest.fn() };
    coverageTransaction = {
      run: jest.fn((work) => runCoverageSerializable(prisma, work)),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CommercialService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RecipeCatalogService, useValue: { resolveSelections: jest.fn() } },
        { provide: RUNTIME_CONFIG, useValue: TEST_RUNTIME_CONFIG },
        {
          provide: WarehouseCoverageCalculationService,
          useValue: coverageCalculation,
        },
        { provide: WarehouseCoverageTransaction, useValue: coverageTransaction },
      ],
    }).compile();
    service = mod.get(CommercialService);
  });

  it('passes the commercial audit audience explicitly', async () => {
    await service.getAudit('o1');

    expect(audit.forObject).toHaveBeenCalledWith('o1', 'commercial');
  });

  it.each([
    {
      route: 'POST /api/commercial/orders/:orderId/invoice-handoff',
      method: 'invoiceHandoff' as const,
    },
    {
      route: 'POST /api/commercial/orders/:orderId/submit-to-finance',
      method: 'submitToFinance' as const,
    },
  ])('keeps $route wired to the same completeness-gated service command', async ({ method }) => {
    const invoiceHandoff = jest.fn().mockResolvedValue({ id: 'o1' });
    const controller = new CommercialController(
      { invoiceHandoff } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const actor = {
      userId: 'u1',
      role: 'commercial' as const,
      capabilities: ['invoice:handoff' as const],
    };
    const dto = { amount: 1000 };

    await controller[method](actor, 'o1', dto);

    expect(invoiceHandoff).toHaveBeenCalledWith({ userId: 'u1', role: 'commercial' }, 'o1', dto);
  });

  it('applyCorrection audits recipe_correction_applied with old/new and notifies operator', async () => {
    await service.applyCorrection({ userId: null, role: 'commercial' }, 'o1', {
      positionId: 'pos1',
      reason: 'temp wrong',
      newParameters: [{ label: 'T', value: '2' }],
    });
    expect(prisma.recipeSnapshot.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ positionId: 'pos1', version: 'v1' }),
      data: {
        parameters: [{ label: 'T', value: '2' }],
        version: 'v2',
      },
    });
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'audit:recipe_correction_applied',
          objectId: 'o1',
          reason: 'temp wrong',
          oldValue: {
            parameters: [{ label: 'T', value: '1' }],
            version: 'v1',
          },
          newValue: {
            parameters: [{ label: 'T', value: '2' }],
            version: 'v2',
          },
        }),
      }),
    );
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'notification:operator_recipe_changed' }),
      }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.recipeSnapshot.updateMany.mock.invocationCallOrder[0],
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('applyCorrection rejects mismatched orderId and positionId without updating', async () => {
    prisma.commercialOrderPosition.findFirst.mockResolvedValue(null);

    await expect(
      service.applyCorrection({ userId: null, role: 'commercial' }, 'other-order', {
        positionId: 'pos1',
        reason: 'wrong order',
        newParameters: [{ label: 'T', value: '2' }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('applyCorrection rejects locked commercial orders without updating', async () => {
    prisma.commercialOrderPosition.findFirst.mockResolvedValue({
      id: 'pos1',
      orderId: 'o1',
      order: {
        commercialStage: 'in_work',
        paymentStatus: 'partial',
        commercialLockedAt: new Date(),
      },
      recipe: {
        id: 'r1',
        positionId: 'pos1',
        parameters: [{ label: 'T', value: '1' }],
        version: 'v1',
      },
    });

    await expect(
      service.applyCorrection({ userId: null, role: 'commercial' }, 'o1', {
        positionId: 'pos1',
        reason: 'locked',
        newParameters: [{ label: 'T', value: '2' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.recipeSnapshot.updateMany).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('invoiceHandoff sends the order to finance idempotently and audits it', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        commercialStage: 'incoming',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        financeOrder: null,
      })
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-1',
        commercialStage: 'sent_to_finance',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      });
    prisma.commercialOrder.update = jest.fn().mockResolvedValue({ id: 'o1' });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.financeOrder = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'fo1', commercialOrderId: 'o1' }),
      update: jest.fn(),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

    await service.invoiceHandoff({ userId: null, role: 'commercial' }, 'o1', { amount: 1000 });

    expect(prisma.financeOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ commercialOrderId: 'o1', amountValue: 1000 }),
    });
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'o1' }),
        data: expect.objectContaining({ commercialStage: 'sent_to_finance' }),
      }),
    );
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'audit:invoice_handoff_created' }),
      }),
    );
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'audit:finance_order_created' }),
      }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never creates a finance contour for stock production', async () => {
    prisma.financeOrder = {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'stock-order-1',
      orderNumber: 'S-1',
      requestType: 'stock_reserve',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'in_work',
      paymentStatus: 'not_applicable',
      commercialLockedAt: null,
      financeOrder: null,
      positions: [],
    });

    await expect(
      service.invoiceHandoff({ userId: 'commercial-1', role: 'commercial' }, 'stock-order-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('initializes V2 coverage before writing the finance lock in one Serializable transaction', async () => {
    const order = completeV2HandoffOrder();
    prisma.commercialOrder.findUnique.mockResolvedValueOnce(order).mockResolvedValueOnce({
      ...order,
      commercialStage: 'sent_to_finance',
      counterparty: {},
      coverProposals: [],
      problems: [],
    });
    const sequence: string[] = [];
    coverageCalculation.initializeAtInvoiceHandoff.mockImplementation(async () => {
      sequence.push('coverage');
      return { state: 'awaiting_finance' };
    });
    prisma.commercialOrder.updateMany = jest.fn().mockImplementation(async () => {
      sequence.push('commercial-stage');
      return { count: 1 };
    });
    prisma.financeOrder = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async () => {
        sequence.push('finance-order');
        return { id: 'fo-v2', commercialOrderId: 'o1' };
      }),
    };

    await service.invoiceHandoff({ userId: 'commercial-1', role: 'commercial' }, 'o1', {
      amount: 1000,
    });

    expect(coverageCalculation.initializeAtInvoiceHandoff).toHaveBeenCalledWith(prisma, 'o1');
    expect(coverageTransaction.run).toHaveBeenCalledTimes(1);
    expect(sequence.slice(0, 3)).toEqual(['coverage', 'commercial-stage', 'finance-order']);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('rolls back V2 handoff when the locked order specification became incomplete', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValueOnce(completeV2HandoffOrder());
    prisma.commercialOrder.updateMany = jest.fn();
    prisma.financeOrder = {
      findUnique: jest.fn(),
      create: jest.fn(),
    };
    coverageCalculation.initializeAtInvoiceHandoff.mockRejectedValue(
      new ConflictException({
        statusCode: 409,
        code: 'order_spec_incomplete',
        message: 'Заполните обязательные параметры заказа перед передачей в бухгалтерию.',
        missing: ['positions[0].birka'],
      }),
    );

    await expect(
      service.invoiceHandoff({ userId: 'commercial-1', role: 'commercial' }, 'o1', {
        amount: 1000,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'order_spec_incomplete',
        missing: ['positions[0].birka'],
      }),
    });

    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.financeOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('rejects incomplete V2 before the invoice lock or any finance/audit write', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue(incompleteV2HandoffOrder());
    prisma.commercialOrder.updateMany = jest.fn();
    prisma.financeOrder = { findUnique: jest.fn(), create: jest.fn() };

    await expect(
      service.invoiceHandoff({ userId: 'u1', role: 'commercial' }, 'o1', { amount: 1000 }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'order_spec_incomplete',
        message: 'Заполните обязательные параметры заказа перед передачей в бухгалтерию.',
        missing: ['positions[0].birka'],
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      route: 'POST /api/commercial/orders/:orderId/invoice-handoff',
      method: 'invoiceHandoff' as const,
    },
    {
      route: 'POST /api/commercial/orders/:orderId/submit-to-finance',
      method: 'submitToFinance' as const,
    },
  ])('applies the V2 completeness gate through actual $route', async ({ method }) => {
    prisma.commercialOrder.findUnique.mockResolvedValue(
      incompleteV2HandoffOrder('sent_to_finance'),
    );
    prisma.$transaction = jest.fn();
    const controller = new CommercialController(
      service,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller[method](
        {
          userId: 'u1',
          role: 'commercial',
          capabilities: ['invoice:handoff'],
        },
        'o1',
        { amount: 1000 },
      ),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'order_spec_incomplete',
        message: 'Заполните обязательные параметры заказа перед передачей в бухгалтерию.',
        missing: ['positions[0].birka'],
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('invoiceHandoff keeps an unknown amount nullable instead of writing zero', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        commercialStage: 'incoming',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        financeOrder: null,
      })
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-1',
        commercialStage: 'sent_to_finance',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.financeOrder = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'fo1', commercialOrderId: 'o1' }),
      update: jest.fn(),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

    await service.invoiceHandoff({ userId: 'u1', role: 'commercial' }, 'o1', {});

    expect(prisma.financeOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ commercialOrderId: 'o1', amountValue: null }),
    });
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'audit:invoice_handoff_created',
          detail: expect.objectContaining({ amount: null }),
        }),
      }),
    );
  });

  it('promoteDraft moves a D-order to incoming A-order without opening finance', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'D-7',
        commercialStage: 'draft',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        financeOrder: null,
      })
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-11',
        commercialStage: 'incoming',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      });
    prisma.commercialOrder.update = jest.fn().mockResolvedValue({ id: 'o1' });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.financeOrder = {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    jest.spyOn(service as any, 'generateOrderNumber').mockResolvedValue('A-11');

    await service.promoteDraft({ userId: 'u1', role: 'commercial' }, 'o1');

    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'o1',
        commercialStage: 'draft',
        orderNumber: 'D-7',
      }),
      data: expect.objectContaining({
        commercialStage: 'incoming',
        orderNumber: 'A-11',
      }),
    });
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'audit:commercial_draft_promoted',
          newValue: expect.objectContaining({
            commercialStage: 'incoming',
            orderNumber: 'A-11',
          }),
        }),
      }),
    );
  });

  it('promoteDraft moves stock into work with an S-number and stable stock batch', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'stock-order-1',
        orderNumber: 'D-9',
        requestType: 'stock_reserve',
        stockBatchCode: 'STOCK-D-9',
        commercialStage: 'draft',
        paymentStatus: 'not_applicable',
        commercialLockedAt: null,
        financeOrder: null,
      })
      .mockResolvedValueOnce({
        id: 'stock-order-1',
        orderNumber: 'S-12',
        requestType: 'stock_reserve',
        stockBatchCode: 'STOCK-S-12',
        commercialStage: 'in_work',
        paymentStatus: 'not_applicable',
        commercialLockedAt: null,
        counterparty: null,
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.financeOrder = {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    jest.spyOn(service as any, 'generateOrderNumber').mockResolvedValue('S-12');

    await service.promoteDraft({ userId: 'commercial-1', role: 'commercial' }, 'stock-order-1');

    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'stock-order-1',
        commercialStage: 'draft',
        orderNumber: 'D-9',
      }),
      data: expect.objectContaining({
        commercialStage: 'in_work',
        orderNumber: 'S-12',
        stockBatchCode: 'STOCK-S-12',
      }),
    });
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
  });

  it('promoteDraft returns an already promoted draft without another event', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-11',
        commercialStage: 'incoming',
        draftedAt: new Date('2026-07-14T08:00:00.000Z'),
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        financeOrder: null,
      })
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-11',
        commercialStage: 'incoming',
        draftedAt: new Date('2026-07-14T08:00:00.000Z'),
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: null,
      });
    prisma.$transaction = jest.fn();

    await expect(service.promoteDraft({ userId: 'u1', role: 'commercial' }, 'o1')).resolves.toEqual(
      expect.objectContaining({ id: 'o1', commercialStage: 'incoming' }),
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('promoteDraft rejects stale draft promotion instead of renumbering sent order', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'D-7',
      commercialStage: 'draft',
      paymentStatus: 'unpaid',
      commercialLockedAt: null,
      financeOrder: null,
    });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    prisma.financeOrder = {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    jest.spyOn(service as any, 'generateOrderNumber').mockResolvedValue('A-12');

    await expect(
      service.promoteDraft({ userId: 'u1', role: 'commercial' }, 'o1'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'o1',
        commercialStage: 'draft',
        orderNumber: 'D-7',
      }),
      data: expect.objectContaining({ commercialStage: 'incoming', orderNumber: 'A-12' }),
    });
    expect(prisma.financeOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'draft must be promoted first',
      order: { commercialStage: 'draft', paymentStatus: 'unpaid', commercialLockedAt: null },
    },
    {
      name: 'already in work',
      order: { commercialStage: 'in_work', paymentStatus: 'unpaid', commercialLockedAt: null },
    },
    {
      name: 'already sent to finance',
      order: {
        commercialStage: 'sent_to_finance',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
      },
    },
    {
      name: 'commercially locked',
      order: {
        commercialStage: 'sent_to_finance',
        paymentStatus: 'unpaid',
        commercialLockedAt: new Date(),
      },
    },
    {
      name: 'payment confirmed',
      order: {
        commercialStage: 'sent_to_finance',
        paymentStatus: 'paid',
        commercialLockedAt: null,
      },
    },
    {
      name: 'payment partially confirmed',
      order: {
        commercialStage: 'sent_to_finance',
        paymentStatus: 'partial',
        commercialLockedAt: null,
      },
    },
  ])('invoiceHandoff rejects invalid state: $name', async ({ order }) => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      warehouseCoverageWorkflowVersion: 1,
      financeOrder: null,
      ...order,
    });
    prisma.$transaction = jest.fn();

    await expect(
      service.invoiceHandoff({ userId: 'u1', role: 'commercial' }, 'o1', { amount: 1000 }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('invoiceHandoff reuses a compatible finance order without rewriting it', async () => {
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 1,
        commercialStage: 'incoming',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        financeOrder: null,
      })
      .mockResolvedValueOnce({
        id: 'o1',
        orderNumber: 'A-1',
        commercialStage: 'sent_to_finance',
        paymentStatus: 'unpaid',
        commercialLockedAt: null,
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: {
          id: 'fo1',
          invoiceStatus: 'not_invoiced',
          paymentStatus: 'unpaid',
          amountValue: 1000,
          amountLabel: null,
          schedules: [],
        },
      });
    prisma.commercialOrder.update = jest.fn().mockResolvedValue({ id: 'o1' });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.financeOrder = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'fo1',
        commercialOrderId: 'o1',
        amountValue: 1000,
        amountLabel: null,
      }),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'fo1', commercialOrderId: 'o1' }),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

    await service.invoiceHandoff({ userId: 'u1', role: 'commercial' }, 'o1', { amount: 1000 });

    expect(prisma.financeOrder.findUnique).toHaveBeenCalledWith({
      where: { commercialOrderId: 'o1' },
    });
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'audit:invoice_handoff_created' }),
      }),
    );
    expect(prisma.domainEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'audit:finance_order_created' }),
      }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('invoiceHandoff rejects a retry with a different payload', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'sent_to_finance',
      paymentStatus: 'unpaid',
      commercialLockedAt: null,
      financeOrder: { amountValue: 500, amountLabel: null },
    });
    prisma.$transaction = jest.fn();

    await expect(
      service.invoiceHandoff({ userId: 'u1', role: 'commercial' }, 'o1', { amount: 1000 }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('treats a compatible concurrent finance handoff winner as an idempotent replay', async () => {
    const initialOrder = {
      id: 'o1',
      orderNumber: 'A-1',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'incoming',
      paymentStatus: 'unpaid',
      commercialLockedAt: null,
      financeOrder: null,
    };
    prisma.commercialOrder.findUnique
      .mockResolvedValueOnce(initialOrder)
      .mockResolvedValueOnce({ commercialStage: 'sent_to_finance' })
      .mockResolvedValueOnce({
        ...initialOrder,
        commercialStage: 'sent_to_finance',
        counterparty: {},
        positions: [],
        coverProposals: [],
        problems: [],
        financeOrder: {
          id: 'fo-winner',
          amountValue: 1000,
          amountLabel: null,
          schedules: [],
        },
      });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    prisma.financeOrder = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'fo-winner',
        commercialOrderId: 'o1',
        amountValue: 1000,
        amountLabel: null,
      }),
      create: jest.fn(),
    };

    await expect(
      service.invoiceHandoff({ userId: 'commercial-1', role: 'commercial' }, 'o1', {
        amount: 1000,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'o1', commercialStage: 'sent_to_finance' }));

    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('writes one finance order and one audit pair after a Serializable retry', async () => {
    const order = completeV2HandoffOrder();
    prisma.commercialOrder.findUnique.mockResolvedValueOnce(order).mockResolvedValueOnce({
      ...order,
      commercialStage: 'sent_to_finance',
      counterparty: {},
      coverProposals: [],
      problems: [],
      financeOrder: {
        id: 'fo-after-retry',
        amountValue: 1000,
        amountLabel: null,
        schedules: [],
      },
    });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.financeOrder = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'fo-after-retry',
        commercialOrderId: 'o1',
      }),
    };
    let transactionAttempts = 0;
    prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => unknown) => {
      transactionAttempts += 1;
      if (transactionAttempts === 1) {
        throw { code: 'P2034' };
      }
      return work(prisma);
    });

    await service.invoiceHandoff({ userId: 'commercial-1', role: 'commercial' }, 'o1', {
      amount: 1000,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(coverageCalculation.initializeAtInvoiceHandoff).toHaveBeenCalledTimes(1);
    expect(prisma.financeOrder.create).toHaveBeenCalledTimes(1);
    const eventTypes = prisma.domainEvent.create.mock.calls.map(
      ([call]: [{ data: { type: string } }]) => call.data.type,
    );
    expect(
      eventTypes.filter((type: string) => type === 'audit:invoice_handoff_created'),
    ).toHaveLength(1);
    expect(
      eventTypes.filter((type: string) => type === 'audit:finance_order_created'),
    ).toHaveLength(1);
  });

  it('invoiceHandoff rejects if guarded order update sees finance-confirmed state', async () => {
    prisma.commercialOrder.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'A-1',
      warehouseCoverageWorkflowVersion: 1,
      commercialStage: 'incoming',
      paymentStatus: 'unpaid',
      commercialLockedAt: null,
      financeOrder: null,
    });
    prisma.commercialOrder.update = jest.fn().mockResolvedValue({ id: 'o1' });
    prisma.commercialOrder.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    prisma.financeOrder = {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));

    await expect(
      service.invoiceHandoff({ userId: 'u1', role: 'commercial' }, 'o1', { amount: 1000 }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(prisma.financeOrder.findUnique).toHaveBeenCalledWith({
      where: { commercialOrderId: 'o1' },
    });
    expect(prisma.financeOrder.create).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
