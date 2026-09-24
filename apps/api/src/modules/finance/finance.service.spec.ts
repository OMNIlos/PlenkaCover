import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { Role } from '@plenka/contracts';
import { FinanceService } from './finance.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ONEC_ADAPTER } from '../../integrations/onec/onec.adapter';
import { DeferredPaymentService } from './deferred-payment.service';
import { MAX_PAYMENT_OPERATION_AMOUNT } from './dto/payment-operation.dto';
import type { ManualPaymentUpdateStatus } from './dto/payment-update.dto';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import type { PaymentPolicyInput } from '@plenka/contracts';
import { WarehouseCoverageCalculationService } from '../warehouse-coverage/warehouse-coverage-calculation.service';

const PAYMENT_OPERATION_KEY = '5d974d96-c03d-4d3e-a690-60a65c031886';
const PAYMENT_UPDATE_KEY = '2c0190d9-4db0-49ff-8358-f6f0a393b44c';
const SOURCE_RETRY_KEY = '7fc1ff55-6c96-482d-a56e-3036ae0801ef';
const ONEC_INVOICE_ID = '33333333-3333-4333-8333-333333333333';

type PaymentUpdateClaimInput = {
  financeOrderId: string;
  operationKey: string;
  requestFingerprint: string;
  actorRole: Role;
};

const fo = {
  id: 'fo1',
  commercialOrderId: 'co1',
  externalId: ONEC_INVOICE_ID,
  sourceVersion: null,
  invoiceStatus: 'not_invoiced',
  invoiceSyncState: 'not_synced',
  invoiceNumber: null,
  invoiceCurrency: null,
  invoiceCandidates: [{ internal: true }],
  invoiceSourceCheckedAt: null,
  paymentStatus: 'unpaid',
  sourceStatus: 'ready',
  amountValue: 0,
  amountLabel: null,
  paymentTermsType: null,
  invoiceIssuedAt: null,
  productionClearedAt: null,
  createdAt: new Date('2026-08-01T08:00:00.000Z'),
  updatedAt: new Date('2026-08-01T09:00:00.000Z'),
  policy: null,
  commercialOrder: {
    id: 'co1',
    orderNumber: 'A-1024',
    creatorRole: 'commercial',
    counterpartyId: 'counterparty-1',
    requestType: 'client_order',
    productionIndicator: 'not_started',
    warehouseCoverStatus: 'not_checked',
    paymentStatus: 'unpaid',
    shipmentStatus: 'not_shipped',
    shipmentCompletedAt: null,
    warehouseCoverageWorkflowVersion: 1,
    createdAt: new Date('2026-08-01T08:00:00.000Z'),
    updatedAt: new Date('2026-08-01T09:00:00.000Z'),
    externalId: null,
    sourceVersion: null,
    commercialFinanceNote: null,
    comment: 'Доставка на склад клиента',
    clientRequestId: 'internal-client-request',
    requestFingerprint: 'internal-fingerprint',
    positions: [
      {
        id: 'position-1',
        rollCount: 4,
        filmType: 'ПВД',
        actualThickness: '80 мкм',
        accountingThickness: '75 мкм',
        spoolType: '76 мм',
        birka: 'Белая',
        plannedWeightKg: 25,
        widthMm: 1_200,
        plannedLengthM: 800,
        rawMaterialId: 'internal-material',
        recipe: { id: 'internal-recipe' },
      },
    ],
    counterparty: {
      id: 'counterparty-1',
      displayName: 'УралПак',
      legalName: 'ООО УралПак',
      inn: '6671000011',
      billingSource: 'manual_platform',
      syncStatus: 'ready',
      sourceCode: 'internal-source-code',
    },
  },
  schedules: [],
  operations: [],
  snapshots: [],
  paymentAllocations: [],
  paymentUpdateCommands: [],
  paymentCorrections: [],
};

function setup() {
  let paymentUpdateClaim: (PaymentUpdateClaimInput & { id: string; createdAt: Date }) | null = null;
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'fo1' }]),
    financeOrder: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([fo]),
      findUnique: jest.fn().mockResolvedValue(fo),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    commercialOrder: { count: jest.fn().mockResolvedValue(0), update: jest.fn() },
    commercialOrderPosition: { count: jest.fn().mockResolvedValue(1) },
    paymentPolicy: { count: jest.fn().mockResolvedValue(0) },
    paymentPolicyStage: { count: jest.fn().mockResolvedValue(0) },
    domainEvent: { create: jest.fn().mockResolvedValue({ id: 'evt1' }) },
    paymentSchedule: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
    paymentOperation: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'op1' }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'op1',
        financeOrderId: 'fo1',
        operationKey: PAYMENT_OPERATION_KEY,
        operationType: 'cash',
        amount: 5000,
        source: 'manual_platform',
        createdByRole: 'finance',
      }),
    },
    financePaymentUpdateCommand: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest
        .fn()
        .mockImplementation(async ({ data }: { data: PaymentUpdateClaimInput[] }) => {
          if (paymentUpdateClaim) return { count: 0 };
          paymentUpdateClaim = {
            id: 'payment-update-1',
            ...data[0],
            createdAt: new Date('2026-07-21T12:00:00.000Z'),
          };
          return { count: 1 };
        }),
      findUnique: jest.fn().mockImplementation(async () => paymentUpdateClaim),
    },
    syncJournal: {
      create: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue({
        id: 'retry-1',
        financeOrderId: 'fo1',
        operationKey: SOURCE_RETRY_KEY,
        activeScopeKey: 'finance-source-retry:fo1',
        status: 'retry_requested',
        retries: 1,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productionProblem: { create: jest.fn() },
    directorDecision: { create: jest.fn() },
    sourceSnapshot: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({ id: 's1', parsed: { ok: true } }),
      create: jest.fn().mockResolvedValue({ id: 'snapshot-retry-1' }),
    },
    financePaymentAllocation: { count: jest.fn().mockResolvedValue(0) },
    financePaymentCorrectionCommand: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const audit = { record: jest.fn(), forObject: jest.fn().mockResolvedValue([]) };
  const deferred = {
    replacePolicy: jest.fn(),
    replaceTerms: jest.fn(),
    setPolicy: jest.fn(),
    setTerms: jest.fn(),
    confirmSchedule: jest.fn(),
  };
  return { prisma, audit, deferred };
}

const onec = {
  pullInvoice: jest.fn().mockResolvedValue({
    sourceKind: 'mock_1C',
    subjectType: 'invoice',
    externalId: 'mock-invoice-co1',
    sourceVersion: 'v1',
    parsed: {
      invoiceNo: 'СЧ-co1',
      date: null,
      total: 150000,
      currency: 'RUB',
      counterpartyExternalId: 'mock-counterparty-uralpak',
      posted: false,
    },
    staleness: 'fresh',
    capturedAt: new Date().toISOString(),
    rawPayload: { _raw: 'x' },
  }),
};

async function build(
  prisma: any,
  audit: any,
  deferred?: any,
  coverage = {
    readForFinance: jest.fn().mockResolvedValue({
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 2,
      generation: 1,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T08:00:00.000Z',
      stale: false,
      financeRolls: [
        { rollCode: 'ROLL-1', positionId: 'position-1' },
        { rollCode: 'ROLL-2', positionId: 'position-1' },
      ],
    }),
  },
): Promise<FinanceService> {
  const mod = await Test.createTestingModule({
    providers: [
      FinanceService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      {
        provide: DeferredPaymentService,
        useValue:
          deferred ??
          ({
            replacePolicy: jest.fn(),
            replaceTerms: jest.fn(),
            setPolicy: jest.fn(),
            setTerms: jest.fn(),
            confirmSchedule: jest.fn(),
          } as const),
      },
      { provide: ONEC_ADAPTER, useValue: onec },
      {
        provide: RUNTIME_CONFIG,
        useValue: { onecTimeoutMs: 120_000 },
      },
      {
        provide: WarehouseCoverageCalculationService,
        useValue: coverage,
      },
    ],
  }).compile();
  return mod.get(FinanceService);
}

const actor = { userId: 'u1', role: 'finance' as const };
const paymentPolicy: PaymentPolicyInput = {
  installmentDays: 30,
  stages: [
    {
      sequence: 1,
      trigger: 'invoice_issued',
      percentageBasisPoints: 5000,
      offsetDays: 0,
    },
    {
      sequence: 2,
      trigger: 'full_shipment',
      percentageBasisPoints: 5000,
      offsetDays: 30,
    },
  ],
};
const persistedPaymentPolicy = {
  id: 'policy-1',
  financeOrderId: 'fo1',
  installmentDays: 30,
  capturedProductionLeadDays: 2,
  revision: 1,
  stages: paymentPolicy.stages.map((stage) => ({
    ...stage,
    id: `stage-${stage.sequence}`,
    paymentPolicyId: 'policy-1',
    label: null,
  })),
};
const labeledPaymentPolicy: PaymentPolicyInput = {
  ...paymentPolicy,
  stages: paymentPolicy.stages.map((stage) =>
    stage.sequence === 1 ? { ...stage, label: 'Аванс' } : stage,
  ),
};
const persistedLabeledPaymentPolicy = {
  ...persistedPaymentPolicy,
  stages: persistedPaymentPolicy.stages.map((stage) =>
    stage.sequence === 1 ? { ...stage, label: 'Аванс' } : stage,
  ),
};

type PreviewCapableFinanceService = FinanceService & {
  previewPaymentPolicy: (
    previewActor: typeof actor,
    orderId: string,
    dto: { amount: number; paymentPolicy: PaymentPolicyInput },
  ) => Promise<unknown>;
};

function paymentUpdateDto(paymentStatus: ManualPaymentUpdateStatus) {
  return {
    operationKey: PAYMENT_UPDATE_KEY,
    paymentStatus,
  };
}

function financeOrderWithIndependentPaid(amount: number, invoiceAmount = 100000) {
  return {
    ...fo,
    invoiceStatus: 'invoiced',
    amountValue: new Prisma.Decimal(invoiceAmount),
    operations: [
      {
        id: 'manual-payment-operation',
        operationType: 'manual_adjustment',
        amount: new Prisma.Decimal(amount),
        source: 'manual_platform',
        createdAt: new Date('2026-07-21T11:55:00.000Z'),
        paymentAllocationId: null,
        paymentScheduleId: null,
        reversesOperationId: null,
      },
    ],
    paymentAllocations: [],
  };
}

describe('FinanceService', () => {
  beforeEach(() => onec.pullInvoice.mockClear());

  it('adds the protected V2 coverage projection to finance aggregates only', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      commercialOrder: {
        ...fo.commercialOrder,
        id: 'co1',
        warehouseCoverageWorkflowVersion: 2,
      },
    });
    const coverage = {
      readForFinance: jest.fn().mockResolvedValue({
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 2,
        generation: 1,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        nextOwner: 'finance',
        availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
        requiredRollCount: 2,
        matchedRollCount: 2,
        uncertainRollCount: 0,
        calculatedAt: '2026-07-24T08:00:00.000Z',
        stale: false,
        financeRolls: [
          { rollCode: 'ROLL-1', positionId: 'position-1' },
          { rollCode: 'ROLL-2', positionId: 'position-1' },
        ],
      }),
    };
    const service = await build(prisma, audit, undefined, coverage);

    const projected = (await service.getOrder('finance', 'fo1')) as any;

    expect(coverage.readForFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'finance',
        capabilities: expect.arrayContaining(['finance_order:read']),
      }),
      'fo1',
    );
    expect(projected.coverage.financeRolls).toEqual([
      { rollCode: 'ROLL-1', positionId: 'position-1' },
      { rollCode: 'ROLL-2', positionId: 'position-1' },
    ]);
  });

  it('uses the real finance session capabilities for V2 available actions', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      commercialOrder: {
        ...fo.commercialOrder,
        id: 'co1',
        warehouseCoverageWorkflowVersion: 2,
      },
    });
    const coverage = { readForFinance: jest.fn().mockResolvedValue({ workflowVersion: 2 }) };
    const service = await build(prisma, audit, undefined, coverage);
    const restrictedActor = {
      userId: 'finance-restricted',
      role: 'finance' as const,
      capabilities: ['finance_order:read' as const],
    };

    await service.getOrder(restrictedActor, 'fo1');

    expect(coverage.readForFinance).toHaveBeenCalledWith(restrictedActor, 'fo1');
  });

  it('keeps the V1 finance aggregate unchanged and skips V2 coverage reads', async () => {
    const { prisma, audit } = setup();
    const coverage = { readForFinance: jest.fn() };
    const service = await build(prisma, audit, undefined, coverage);

    const projected = (await service.getOrder('finance', 'fo1')) as any;

    expect(coverage.readForFinance).not.toHaveBeenCalled();
    expect(projected).not.toHaveProperty('coverage');
  });

  it('normalizes a blank counterparty INN in the finance list contract', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        ...fo,
        commercialOrder: {
          ...fo.commercialOrder,
          counterparty: { ...fo.commercialOrder.counterparty, inn: '' },
        },
      },
    ]);
    const service = await build(prisma, audit);

    const [projected] = await service.listOrders('finance');

    expect(projected.commercialOrder.counterparty?.inn).toBeNull();
  });

  it('omits exhausted positions from the active finance order composition', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        ...fo,
        commercialOrder: {
          ...fo.commercialOrder,
          positions: [
            { ...fo.commercialOrder.positions[0], id: 'exhausted-position', rollCount: 0 },
            { ...fo.commercialOrder.positions[0], id: 'active-position', rollCount: 53 },
          ],
        },
      },
    ]);
    const service = await build(prisma, audit);

    const [projected] = await service.listOrders('finance');

    expect(projected.commercialOrder.positions).toEqual([
      {
        id: 'active-position',
        rollCount: 53,
        filmType: 'ПВД',
        actualThickness: '80 мкм',
        accountingThickness: '75 мкм',
        spoolType: '76 мм',
        birka: 'Белая',
        plannedWeightKg: 25,
        widthMm: 1_200,
        plannedLengthM: 800,
      },
    ]);
  });

  it('projects the exact rolling-safe finance shape without Prisma or idempotency fields', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      schedules: [
        {
          id: 'schedule-1',
          financeOrderId: 'fo1',
          paymentPolicyStageId: null,
          percentageBasisPoints: null,
          offsetDays: null,
          kind: 'invoice_prepayment',
          startsAt: null,
          terms: 'internal legacy copy',
          dueDate: null,
          amount: new Prisma.Decimal('10.25'),
          status: 'unpaid',
          source: 'manual_platform',
          createdAt: new Date('2026-08-01T10:00:00.000Z'),
        },
      ],
      operations: [
        {
          id: 'operation-1',
          financeOrderId: 'fo1',
          operationKey: PAYMENT_OPERATION_KEY,
          operationType: 'cash',
          amount: new Prisma.Decimal('10.25'),
          source: 'manual_platform',
          createdByRole: 'finance',
          reconciled: false,
          createdAt: new Date('2026-08-01T10:00:00.000Z'),
          externalId: null,
          sourceVersion: null,
          paymentAllocationId: null,
          paymentScheduleId: null,
          reversesOperationId: null,
        },
      ],
    });
    const service = await build(prisma, audit);

    const projected = (await service.getOrder('finance', 'fo1')) as any;

    const projectionQuery = prisma.financeOrder.findUnique.mock.calls.at(-1)?.[0];
    expect(projectionQuery).not.toHaveProperty('include');
    expect(projectionQuery.select).not.toHaveProperty('invoiceCandidates');
    expect(projectionQuery.select.commercialOrder.select.positions).toEqual({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        rollCount: true,
        filmType: true,
        actualThickness: true,
        accountingThickness: true,
        spoolType: true,
        birka: true,
        plannedWeightKg: true,
        widthMm: true,
        plannedLengthM: true,
      },
    });
    expect(projectionQuery.select.operations.select).not.toHaveProperty('operationKey');
    expect(Object.keys(projected).sort()).toEqual(
      [
        'amountLabel',
        'amountValue',
        'businessPayment',
        'commercialOrder',
        'commercialOrderId',
        'correctablePayments',
        'createdAt',
        'externalId',
        'id',
        'invoice',
        'invoiceCurrency',
        'invoiceIssuedAt',
        'invoiceNumber',
        'invoiceSourceCheckedAt',
        'invoiceStatus',
        'invoiceSyncState',
        'operations',
        'paymentPolicy',
        'paymentCorrections',
        'paymentStatus',
        'paymentSummary',
        'paymentTermsType',
        'paymentTimeline',
        'productionClearedAt',
        'schedules',
        'sourceStatus',
        'sourceVersion',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(projected.commercialOrder).sort()).toEqual(
      [
        'commercialFinanceNote',
        'comment',
        'counterparty',
        'counterpartyId',
        'createdAt',
        'creatorRole',
        'externalId',
        'id',
        'orderNumber',
        'paymentStatus',
        'positions',
        'productionIndicator',
        'requestType',
        'shipmentCompletedAt',
        'shipmentStatus',
        'sourceVersion',
        'updatedAt',
        'warehouseCoverStatus',
        'warehouseCoverageWorkflowVersion',
      ].sort(),
    );
    expect(projected.commercialOrder.positions).toEqual([
      {
        id: 'position-1',
        rollCount: 4,
        filmType: 'ПВД',
        actualThickness: '80 мкм',
        accountingThickness: '75 мкм',
        spoolType: '76 мм',
        birka: 'Белая',
        plannedWeightKg: 25,
        widthMm: 1_200,
        plannedLengthM: 800,
      },
    ]);
    expect(projected.commercialOrder.positions[0]).not.toHaveProperty('rawMaterialId');
    expect(projected.commercialOrder.positions[0]).not.toHaveProperty('recipe');
    expect(projected.schedules[0]).toEqual({
      id: 'schedule-1',
      kind: 'invoice_prepayment',
      sequence: null,
      trigger: null,
      percentageBasisPoints: null,
      offsetDays: null,
      startsAt: null,
      dueDate: null,
      dateKind: 'unavailable',
      amount: 10.25,
      status: 'unpaid',
      source: 'manual_platform',
      paidAmount: '0.00',
      remainingAmount: '10.25',
      isOverdue: false,
    });
    expect(projected.operations[0]).toEqual({
      id: 'operation-1',
      operationType: 'cash',
      amount: '10.25',
      source: 'manual_platform',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      paymentAllocationId: null,
    });
  });

  it.each(['list', 'detail', 'overview'] as const)(
    'never leaks persistence-only finance fields through %s',
    async (projection) => {
      const { prisma, audit } = setup();
      const service = await build(prisma, audit);

      const result =
        projection === 'list'
          ? (await service.listOrders('finance'))[0]
          : projection === 'detail'
            ? await service.getOrder('finance', 'fo1')
            : (await service.getOverview('finance')).buckets.actual[0];

      expect(result).not.toHaveProperty('invoiceCandidates');
      const [position] = (
        result.commercialOrder as typeof result.commercialOrder & {
          positions: Array<Record<string, unknown>>;
        }
      ).positions;
      expect(position).not.toHaveProperty('rawMaterialId');
      expect(position).not.toHaveProperty('recipe');
      expect(result.commercialOrder).not.toHaveProperty('clientRequestId');
      expect(result.commercialOrder).not.toHaveProperty('requestFingerprint');
    },
  );

  it.each(['list', 'detail', 'overview'] as const)(
    'checks the aggregate budget before loading the full finance %s projection',
    async (projection) => {
      const { prisma, audit } = setup();
      const service = await build(prisma, audit);

      await (projection === 'list'
        ? service.listOrders('finance')
        : projection === 'detail'
          ? service.getOrder('finance', 'fo1')
          : service.getOverview('finance'));

      const loader =
        projection === 'detail' ? prisma.financeOrder.findUnique : prisma.financeOrder.findMany;
      expect(prisma.financeOrder.count.mock.invocationCallOrder[0]).toBeLessThan(
        loader.mock.invocationCallOrder[0],
      );
      expect(loader.mock.calls[0][0]).not.toHaveProperty('take');
      expect(prisma.paymentOperation.count).toHaveBeenCalledWith({
        where: { financeOrder: projection === 'detail' ? { id: 'fo1' } : {} },
      });
      expect(prisma.commercialOrderPosition.count).toHaveBeenCalledWith({
        where: { order: { financeOrder: projection === 'detail' ? { id: 'fo1' } : {} } },
      });
    },
  );

  it('projects schedule money as the numeric HTTP contract instead of Prisma Decimal JSON', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      schedules: [
        {
          id: 'schedule-decimal',
          amount: new Prisma.Decimal('50000.25'),
          dueDate: new Date('2026-08-04T00:00:00.000Z'),
          paymentPolicyStageId: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit);

    const projected = (await service.getOrder('finance', 'fo1')) as any;

    expect(projected.schedules[0]).toEqual(
      expect.objectContaining({ amount: 50_000.25, dueDate: '2026-08-04' }),
    );
  });

  it('projects only 1С invoice identity and exact manual paid/remaining/overpaid totals', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceSyncState: 'posted',
      invoiceNumber: 'СЧ-0042',
      invoiceCurrency: 'RUB',
      sourceVersion: 'invoice-v2',
      amountValue: new Prisma.Decimal(1200),
      snapshots: [
        {
          id: 'snapshot-invoice',
          externalId: ONEC_INVOICE_ID,
          sourceVersion: 'invoice-v2',
          sourceKind: '1C',
          capturedAt: new Date('2026-08-02T09:00:00.000Z'),
          importedAt: new Date('2026-08-02T09:01:00.000Z'),
          checkedAt: new Date('2026-08-02T09:01:00.000Z'),
          staleness: 'fresh',
          parsed: {
            invoiceNo: 'СЧ-0042',
            date: '2026-08-02T08:00:00.000Z',
            total: 1200,
            subtotal: 1000,
            taxTotal: 200,
            currency: 'RUB',
            posted: true,
            counterpartyExternalId: 'counterparty-1',
            lines: [
              {
                lineNumber: 1,
                nomenclatureExternalId: 'item-1',
                name: 'Плёнка',
                quantity: 20,
                price: 60,
                amount: 1200,
                unitExternalId: 'unit-1',
              },
            ],
            rawPayload: 'must-not-leak',
          },
          rawPayload: { secret: 'must-not-leak' },
        },
      ],
      paymentAllocations: [
        {
          id: 'allocation-1',
          amount: new Prisma.Decimal(1300),
          status: 'applied',
          matchKind: 'invoice_ref',
          scheduleId: null,
          reversesId: null,
          createdAt: new Date('2026-08-03T10:00:00.000Z'),
          receipt: {
            id: 'receipt-1',
            externalId: 'payment-1',
            number: 'ПП-0042',
            receivedAt: new Date('2026-08-03T09:00:00.000Z'),
            amount: new Prisma.Decimal(1300),
            currency: 'RUB',
            sourceStatus: 'fresh',
          },
        },
      ],
      paymentCorrections: [
        {
          id: 'correction-1',
          targetKind: 'payment_operation',
          targetId: 'operation-1',
          reason: 'Дублирующее поступление',
          actorRole: 'finance',
          createdAt: new Date('2026-08-04T10:00:00.000Z'),
          result: { paymentStatus: 'paid', requestFingerprint: 'must-not-leak' },
        },
      ],
    });
    const service = await build(prisma, audit);

    const projected = (await service.getOrder('finance', 'fo1')) as any;

    expect(projected.invoice).toMatchObject({
      externalId: ONEC_INVOICE_ID,
      sourceVersion: 'invoice-v2',
      invoiceNumber: 'СЧ-0042',
    });
    expect(projected.invoice).not.toHaveProperty('amount');
    expect(projected.invoice).not.toHaveProperty('subtotal');
    expect(projected.invoice).not.toHaveProperty('taxTotal');
    expect(projected.invoice).not.toHaveProperty('lines');
    expect(projected.paymentSummary).toEqual({
      invoiceAmount: '1200.00',
      paidAmount: '1300.00',
      remainingAmount: '0.00',
      overpaidAmount: '100.00',
    });
    expect(projected.paymentTimeline).toEqual([
      expect.objectContaining({
        receiptNumber: 'ПП-0042',
        amount: '1300.00',
        matchKind: 'invoice_ref',
      }),
    ]);
    expect(projected.businessPayment).toMatchObject({
      status: 'paid',
      isOverdue: false,
      paidAmount: '1300.00',
      remainingAmount: '0.00',
    });
    expect(projected.paymentCorrections).toEqual([
      {
        id: 'correction-1',
        targetKind: 'payment_operation',
        reason: 'Дублирующее поступление',
        actorRole: 'Бухгалтерия',
        resultingStatus: 'paid',
        createdAt: '2026-08-04T10:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain('must-not-leak');
    expect(projected).not.toHaveProperty('snapshots');
    expect(projected).not.toHaveProperty('paymentAllocations');
  });

  it('projects only addressable safe payment-correction targets and blocks 1C facts', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      paymentStatus: 'paid',
      paymentUpdateCommands: [
        {
          id: 'update-1',
          requestedStatus: 'paid',
          previousStatus: 'partial',
          amountPaid: new Prisma.Decimal(500),
          createdAt: new Date('2026-08-04T08:00:00.000Z'),
        },
      ],
      paymentCorrections: [],
      schedules: [
        {
          id: 'schedule-1',
          financeOrderId: 'fo1',
          paymentPolicyStageId: null,
          kind: 'invoice_prepayment',
          terms: '50% предоплата',
          amount: new Prisma.Decimal(500),
          status: 'paid',
          source: 'manual_platform',
          dueDate: new Date('2026-08-04T00:00:00.000Z'),
          createdAt: new Date('2026-08-04T08:00:00.000Z'),
        },
      ],
      operations: [
        {
          id: 'schedule-operation',
          amount: new Prisma.Decimal(500),
          source: 'manual_platform',
          paymentScheduleId: 'schedule-1',
          reversesOperationId: null,
        },
        {
          id: 'onec-operation',
          amount: new Prisma.Decimal(200),
          source: '1C',
          paymentScheduleId: null,
          reversesOperationId: null,
        },
      ],
      paymentAllocations: [],
    });
    const service = await build(prisma, audit);

    const projected = (await service.getOrder('finance', 'fo1')) as any;

    expect(projected.correctablePayments).toEqual([
      expect.objectContaining({
        target: { kind: 'payment_update', id: 'update-1' },
        amount: '500.00',
        source: 'manual_platform',
        canCorrect: true,
      }),
      expect.objectContaining({
        target: { kind: 'schedule_confirmation', id: 'schedule-1' },
        amount: '500.00',
        source: 'manual_platform',
        canCorrect: true,
      }),
      expect.objectContaining({
        target: { kind: 'payment_operation', id: 'onec-operation' },
        source: '1C',
        canCorrect: false,
        blockedReason: 'Исправьте платёж в 1С',
      }),
    ]);
    expect(projected).not.toHaveProperty('paymentUpdateCommands');
    expect(projected.paymentCorrections).toEqual([]);
  });

  it('loads a safe contextual history by canonical finance and commercial identities', async () => {
    const { prisma, audit } = setup();
    prisma.domainEvent.findMany = jest.fn().mockResolvedValue([
      {
        id: 'event-1',
        objectId: 'co1',
        type: 'audit:commercial_order_comment_updated',
        actorRole: 'commercial',
        actorId: 'user-commercial',
        actor: { displayName: 'Олег Петров' },
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        reason: 'Клиент уточнил доставку',
        oldValue: { comment: 'Самовывоз' },
        newValue: { comment: 'Доставка' },
        detail: { requestFingerprint: 'must-not-leak' },
      },
    ]);
    const service = await build(prisma, audit);

    const history = await service.getAudit('fo1');

    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { family: 'audit', objectId: { in: ['fo1', 'co1'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(history).toEqual([
      expect.objectContaining({
        id: 'event-1',
        action: 'Комментарий коммерции изменён',
        previousValue: 'Самовывоз',
        currentValue: 'Доставка',
      }),
    ]);
    expect(JSON.stringify(history)).not.toContain('requestFingerprint');
    expect(audit.forObject).not.toHaveBeenCalled();
  });

  it('overview groups accountant workbench buckets and selected-day agenda', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    const { prisma, audit } = setup();
    const orders = [
      {
        ...fo,
        id: 'fo-new',
        invoiceStatus: 'not_invoiced',
        paymentStatus: 'unpaid',
        amountValue: 100000,
        schedules: [],
        operations: [],
      },
      {
        ...fo,
        id: 'fo-check',
        invoiceStatus: 'invoiced',
        paymentStatus: 'unpaid',
        amountValue: 100000,
        schedules: [],
        operations: [],
      },
      {
        ...fo,
        id: 'fo-installment',
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        amountValue: 100000,
        schedules: [
          {
            id: 'sch1',
            amount: 50_000,
            dueDate: new Date('2026-07-10T00:00:00.000Z'),
            status: 'unpaid',
          },
          {
            id: 'sch1-next',
            amount: 50_000,
            dueDate: new Date('2026-08-10T00:00:00.000Z'),
            status: 'unpaid',
          },
        ],
        operations: [{ id: 'op1', amount: 30000 }],
      },
      {
        ...fo,
        id: 'fo-overdue',
        invoiceStatus: 'invoiced',
        paymentStatus: 'overdue',
        amountValue: 100000,
        schedules: [
          {
            id: 'sch2',
            amount: 100_000,
            dueDate: new Date('2026-07-10T00:00:00.000Z'),
            status: 'overdue',
          },
        ],
        operations: [],
      },
      {
        ...fo,
        id: 'fo-paid',
        invoiceStatus: 'invoiced',
        paymentStatus: 'paid',
        amountValue: 100000,
        schedules: [
          {
            id: 'sch-paid',
            amount: 100_000,
            dueDate: new Date('2026-06-10T00:00:00.000Z'),
            status: 'paid',
          },
        ],
        operations: [],
      },
    ];
    prisma.financeOrder.findMany.mockResolvedValueOnce(orders);
    const service = await build(prisma, audit);

    const overview = await service.getOverview('finance', '2026-07-10');

    expect(overview.summary).toEqual({
      awaitingInvoice: 1,
      dueToday: 2,
      overdue: 0,
      installment: 2,
    });
    expect(overview.buckets.actual.map((o) => o.id)).toEqual(['fo-new']);
    expect(overview.buckets.actions.map((o) => o.id)).toEqual([
      'fo-check',
      'fo-installment',
      'fo-overdue',
    ]);
    expect(overview.buckets.problems).toEqual([]);
    expect(overview.buckets.completed.map((o) => o.id)).toEqual(['fo-paid']);
    expect(overview.buckets.completed[0].remainingAmount).toBe(0);
    expect(overview.agenda.map((o) => o.id)).toEqual(['fo-installment', 'fo-overdue']);
    expect(overview.calendar).toContainEqual({
      date: '2026-07-10',
      actionCount: 2,
      overdueCount: 0,
    });
    expect(overview.calendar).toContainEqual({
      date: '2026-08-10',
      actionCount: 1,
      overdueCount: 0,
    });
    expect(overview.calendar).toContainEqual({
      date: '2026-06-10',
      actionCount: 0,
      overdueCount: 0,
    });
    jest.useRealTimers();
  });

  it('projects a deferred stage as a non-calendar condition before full shipment', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    try {
      const { prisma, audit } = setup();
      const order = {
        ...fo,
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        amountValue: 100,
        paymentTermsType: null,
        invoiceIssuedAt: new Date('2026-07-10T09:00:00.000Z'),
        policy: {
          ...persistedPaymentPolicy,
          stages: [...persistedPaymentPolicy.stages].reverse(),
        },
        commercialOrder: {
          ...fo.commercialOrder,
          readyForShipmentAt: null,
          shipmentCompletedAt: null,
        },
        schedules: [
          {
            id: 'schedule-prepayment',
            paymentPolicyStageId: 'stage-1',
            kind: 'invoice_prepayment',
            percentageBasisPoints: 5000,
            offsetDays: 0,
            amount: 50,
            dueDate: new Date('2026-07-10T00:00:00.000Z'),
            status: 'paid',
          },
          {
            id: 'schedule-deferred',
            paymentPolicyStageId: 'stage-2',
            kind: 'post_delivery',
            percentageBasisPoints: 5000,
            offsetDays: 30,
            amount: 50,
            dueDate: null,
            status: 'unpaid',
          },
        ],
        operations: [],
      };
      prisma.financeOrder.findMany.mockResolvedValueOnce([order]);
      const service = await build(prisma, audit);

      const overview = await service.getOverview('finance', '2026-08-11');
      const result = overview.buckets.actions[0];

      expect(result.paymentPolicy).toMatchObject({
        installmentDays: 30,
        capturedProductionLeadDays: 2,
        revision: 1,
      });
      expect(result.paymentPolicy?.stages.map((stage) => stage.sequence)).toEqual([1, 2]);
      expect(result.schedules[0]).toMatchObject({
        dueDate: '2026-07-10',
        dateKind: 'actual',
      });
      expect(result.schedules[1]).toMatchObject({
        dueDate: null,
        dateKind: 'condition',
        percentageBasisPoints: 5000,
        offsetDays: 30,
      });
      expect(result.paidAmount).toBe(50);
      expect(result.remainingAmount).toBe(50);
      expect(result.action).toEqual({
        kind: 'wait_for_full_shipment',
        label: 'Ожидать полной отгрузки',
        dueDate: null,
      });
      expect(overview.agenda).toEqual([]);
      expect(overview.calendar).toEqual([{ date: '2026-07-10', actionCount: 0, overdueCount: 0 }]);
      expect(order.schedules[1].dueDate).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('projects a shipment-backed deferred date as actual', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValueOnce({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 100,
      invoiceIssuedAt: new Date('2026-07-10T09:00:00.000Z'),
      policy: persistedPaymentPolicy,
      commercialOrder: {
        ...fo.commercialOrder,
        readyForShipmentAt: new Date('2026-07-14T10:00:00.000Z'),
        shipmentCompletedAt: new Date('2026-07-15T18:00:00.000Z'),
      },
      schedules: [
        {
          id: 'schedule-prepayment',
          paymentPolicyStageId: 'stage-1',
          kind: 'invoice_prepayment',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          amount: 50,
          dueDate: new Date('2026-07-10T00:00:00.000Z'),
          status: 'paid',
        },
        {
          id: 'schedule-deferred',
          paymentPolicyStageId: 'stage-2',
          kind: 'post_delivery',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          amount: 50,
          dueDate: new Date('2026-08-14T00:00:00.000Z'),
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit);

    const result = await service.getOrder('finance', 'fo1');

    expect(result.schedules[1]).toMatchObject({
      dueDate: '2026-08-14',
      dateKind: 'actual',
    });
  });

  it('listOrders supports accountant UI bucket names', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.listOrders('finance', 'actual');
    expect(prisma.financeOrder.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { invoiceStatus: 'not_invoiced' } }),
    );

    await service.listOrders('finance', 'problems');
    expect(prisma.financeOrder.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { paymentStatus: { in: ['overdue', 'sync_error'] } } }),
    );
  });

  it('derives the overdue list from Moscow due dates and confirmed payments', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T21:00:01.000Z'));
    try {
      const { prisma, audit } = setup();
      const dueDate = new Date('2026-08-09T00:00:00.000Z');
      const schedule = {
        id: 'schedule-overdue',
        paymentPolicyStageId: null,
        kind: 'invoice_full_payment',
        percentageBasisPoints: 10_000,
        offsetDays: 0,
        amount: 100,
        dueDate,
        status: 'unpaid',
      };
      prisma.financeOrder.findMany.mockResolvedValueOnce([
        {
          ...fo,
          id: 'finance-open',
          invoiceStatus: 'invoiced',
          amountValue: 100,
          schedules: [schedule],
        },
        {
          ...fo,
          id: 'finance-paid',
          invoiceStatus: 'invoiced',
          paymentStatus: 'overdue',
          amountValue: 100,
          schedules: [schedule],
          operations: [
            {
              id: 'payment-1',
              operationType: 'cash',
              amount: 100,
              source: 'manual_platform',
              createdAt: new Date('2026-08-10T20:00:00.000Z'),
            },
          ],
        },
      ]);
      const service = await build(prisma, audit);

      const result = await service.listOrders('finance', 'overdue');

      expect(prisma.financeOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
      expect(result.map(({ id }) => id)).toEqual(['finance-open']);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['orders bucket', 'overview date'] as const)(
    'rejects an unsupported finance %s before querying orders',
    async (invalidInput) => {
      const { prisma, audit } = setup();
      const service = await build(prisma, audit);
      const request =
        invalidInput === 'orders bucket'
          ? service.listOrders('finance', 'everything')
          : service.getOverview('finance', '2026-02-30');

      await expect(request).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.financeOrder.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(['list', 'overview'] as const)(
    'fails closed instead of truncating an oversized finance %s projection',
    async (projection) => {
      const { prisma, audit } = setup();
      prisma.financeOrder.count.mockResolvedValueOnce(2001);
      const service = await build(prisma, audit);

      const request =
        projection === 'list' ? service.listOrders('finance') : service.getOverview('finance');
      await expect(request).rejects.toMatchObject({
        response: { code: 'FINANCE_ORDER_CATALOG_TOO_LARGE' },
      });
      expect(prisma.financeOrder.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(['list', 'detail', 'overview'] as const)(
    'fails closed before loading an oversized nested finance %s projection',
    async (projection) => {
      const { prisma, audit } = setup();
      prisma.paymentOperation.count.mockResolvedValue(20_001);
      const service = await build(prisma, audit);

      const request =
        projection === 'list'
          ? service.listOrders('finance')
          : projection === 'detail'
            ? service.getOrder('finance', 'fo1')
            : service.getOverview('finance');
      await expect(request).rejects.toMatchObject({
        response: { code: 'FINANCE_PROJECTION_TOO_LARGE' },
      });
      expect(prisma.financeOrder.findMany).not.toHaveBeenCalled();
      if (projection === 'detail') expect(prisma.financeOrder.findUnique).not.toHaveBeenCalled();
    },
  );

  it('fails closed before starting an oversized V2 coverage fan-out', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.count.mockResolvedValueOnce(100).mockResolvedValueOnce(101);
    const service = await build(prisma, audit);

    await expect(service.listOrders('finance')).rejects.toMatchObject({
      response: { code: 'FINANCE_COVERAGE_PROJECTION_TOO_LARGE' },
    });
    expect(prisma.financeOrder.findMany).not.toHaveBeenCalled();
  });

  it('bounds V2 coverage projection concurrency while preserving finance order order', async () => {
    const { prisma, audit } = setup();
    const rows = Array.from({ length: 17 }, (_, index) => ({
      ...fo,
      id: `fo-${index}`,
      commercialOrderId: `co-${index}`,
      commercialOrder: {
        ...fo.commercialOrder,
        id: `co-${index}`,
        warehouseCoverageWorkflowVersion: 2,
      },
    }));
    prisma.financeOrder.count.mockResolvedValueOnce(rows.length).mockResolvedValueOnce(rows.length);
    prisma.financeOrder.findMany.mockResolvedValue(rows);
    let active = 0;
    let maximumActive = 0;
    const coverage = {
      readForFinance: jest.fn().mockImplementation(async (_actor, orderId: string) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return { workflowVersion: 2, orderId };
      }),
    };
    const service = await build(prisma, audit, undefined, coverage);

    const result = await service.listOrders('finance');

    expect(result.map((order) => order.id)).toEqual(rows.map((order) => order.id));
    expect(maximumActive).toBeLessThanOrEqual(8);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it('previews a custom payment policy with the draft invoice amount before invoicing', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      amountValue: null,
      invoiceStatus: 'not_invoiced',
      invoiceIssuedAt: null,
      commercialOrder: {
        shipmentCompletedAt: null,
      },
    });
    const service = (await build(prisma, audit)) as PreviewCapableFinanceService;

    const result = await service.previewPaymentPolicy(actor, 'fo1', {
      amount: 1200.01,
      paymentPolicy,
    });

    expect(result).toEqual({
      rows: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          amount: 600.01,
          date: null,
          dateKind: 'condition',
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          amount: 600,
          date: null,
          dateKind: 'condition',
        },
      ],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.financeOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps every preview stage conditional until its trigger is persisted', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    try {
      const { prisma, audit } = setup();
      prisma.financeOrder.findUnique.mockResolvedValue({
        amountValue: 1000.01,
        invoiceStatus: 'invoiced',
        invoiceIssuedAt: null,
        commercialOrder: {
          createdAt: new Date('2026-07-10T08:00:00.000Z'),
          readyForShipmentAt: new Date('2026-07-15T10:00:00.000Z'),
          shipmentCompletedAt: null,
        },
      });
      const service = (await build(prisma, audit)) as PreviewCapableFinanceService;

      const result = await service.previewPaymentPolicy(actor, 'fo1', {
        amount: 1000.01,
        paymentPolicy,
      });

      expect(prisma.financeOrder.findUnique).toHaveBeenCalledWith({
        where: { id: 'fo1' },
        select: {
          amountValue: true,
          invoiceStatus: true,
          invoiceIssuedAt: true,
          commercialOrder: {
            select: {
              shipmentCompletedAt: true,
            },
          },
        },
      });
      expect(result).toEqual({
        rows: [
          {
            sequence: 1,
            trigger: 'invoice_issued',
            percentageBasisPoints: 5000,
            offsetDays: 0,
            amount: 500.01,
            date: null,
            dateKind: 'condition',
          },
          {
            sequence: 2,
            trigger: 'full_shipment',
            percentageBasisPoints: 5000,
            offsetDays: 30,
            amount: 500,
            date: null,
            dateKind: 'condition',
          },
        ],
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.financeOrder.update).not.toHaveBeenCalled();
      expect(prisma.financeOrder.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses existing invoice and shipment dates for an actual preview projection', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      amountValue: 1200,
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      commercialOrder: {
        createdAt: new Date('2026-07-10T08:00:00.000Z'),
        readyForShipmentAt: new Date('2026-07-15T10:00:00.000Z'),
        shipmentCompletedAt: new Date('2026-07-31T12:30:00.000Z'),
      },
    });
    const service = (await build(prisma, audit)) as PreviewCapableFinanceService;

    const result = await service.previewPaymentPolicy(actor, 'fo1', {
      amount: 1000,
      paymentPolicy,
    });

    expect(result).toEqual({
      rows: [
        expect.objectContaining({
          sequence: 1,
          amount: 600,
          date: '2026-07-11',
          dateKind: 'actual',
        }),
        expect.objectContaining({
          sequence: 2,
          amount: 600,
          date: '2026-08-30',
          dateKind: 'actual',
        }),
      ],
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('previews persisted triggers by their Moscow business dates after UTC rollover', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      amountValue: 1200,
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: new Date('2026-08-13T21:15:00.000Z'),
      commercialOrder: {
        shipmentCompletedAt: new Date('2026-08-20T21:15:00.000Z'),
      },
    });
    const service = (await build(prisma, audit)) as PreviewCapableFinanceService;

    const result = await service.previewPaymentPolicy(actor, 'fo1', {
      amount: 1000,
      paymentPolicy,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ date: '2026-08-14', dateKind: 'actual' }),
      expect.objectContaining({ date: '2026-09-20', dateKind: 'actual' }),
    ]);
  });

  it('reports semantic calculator validation as a bad request without mutations', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      amountValue: 1000,
      invoiceStatus: 'invoiced',
      invoiceIssuedAt: null,
      commercialOrder: {
        createdAt: new Date('2026-07-10T08:00:00.000Z'),
        readyForShipmentAt: null,
        shipmentCompletedAt: null,
      },
    });
    const service = (await build(prisma, audit)) as PreviewCapableFinanceService;

    await expect(
      service.previewPaymentPolicy(actor, 'fo1', {
        amount: 1000,
        paymentPolicy: {
          installmentDays: 30,
          stages: [
            {
              sequence: 1,
              trigger: 'full_shipment',
              percentageBasisPoints: 9999,
              offsetDays: 30,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['neither payment input', { amount: 1000 }],
    ['null canonical payment input', { amount: 1000, paymentPolicy: null }],
    ['null legacy payment input', { amount: 1000, paymentTermsType: null }],
    [
      'both payment inputs',
      {
        amount: 1000,
        paymentTermsType: 'prepay_50_postpay_50_30d',
        paymentPolicy,
      },
    ],
  ])('createInvoice rejects %s before opening a transaction', async (_case, dto) => {
    const { prisma, audit, deferred } = setup();
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(
        actor,
        'fo1',
        dto as unknown as Parameters<FinanceService['createInvoice']>[2],
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_PAYMENT_INPUT_SELECTION_INVALID' }),
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(deferred.replaceTerms).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('createInvoice materializes a canonical policy inside the invoice transaction', async () => {
    const { prisma, audit, deferred } = setup();
    const service = await build(prisma, audit, deferred);

    await service.createInvoice(actor, 'fo1', {
      amount: 1000,
      paymentPolicy,
    });

    expect(deferred.replacePolicy).toHaveBeenCalledWith(prisma, {
      actor,
      orderId: 'fo1',
      amountValue: 1000,
      invoiceIssuedAt: expect.any(Date),
      shipmentCompletedAt: null,
      previousPolicy: null,
      paymentPolicy,
    });
    expect(deferred.replacePolicy.mock.invocationCallOrder[0]).toBeLessThan(
      audit.record.mock.invocationCallOrder[0],
    );
  });

  it('createInvoice atomically selects fixed 50/50 terms', async () => {
    const { prisma, audit, deferred } = setup();
    const service = await build(prisma, audit, deferred);
    await service.createInvoice(actor, 'fo1', {
      amount: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.financeOrder.updateMany.mock.invocationCallOrder[0],
    );
    expect(prisma.financeOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceStatus: 'invoiced',
          amountValue: 1000.01,
          invoiceIssuedAt: expect.any(Date),
        }),
      }),
    );
    expect(deferred.replacePolicy).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        orderId: 'fo1',
        amountValue: 1000.01,
        paymentPolicy,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:invoice_status_updated',
        detail: {
          commercialOrderId: 'co1',
          financeOrderId: 'fo1',
          orderNumber: 'A-1024',
        },
      }),
      prisma,
    );
  });

  it('preserves the first 1C invoice timestamp when finalizing payment terms', async () => {
    const { prisma, audit, deferred } = setup();
    const firstIssuedAt = new Date('2026-07-09T08:30:00.000Z');
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceIssuedAt: firstIssuedAt,
      invoiceStatus: 'not_invoiced',
      invoiceSyncState: 'posted',
    });
    const service = await build(prisma, audit, deferred);

    await service.createInvoice(actor, 'fo1', {
      amount: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
    });

    expect(prisma.financeOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceStatus: 'invoiced',
          invoiceIssuedAt: firstIssuedAt,
        }),
      }),
    );
    expect(deferred.replacePolicy).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ invoiceIssuedAt: firstIssuedAt }),
    );
  });

  it('createInvoice returns an identical existing invoice without rewriting schedules or events', async () => {
    const { prisma, audit, deferred } = setup();
    const existing = {
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      schedules: [
        {
          kind: 'invoice_prepayment',
          amount: 500,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          kind: 'post_delivery',
          amount: 500.01,
          startsAt: null,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    };
    prisma.financeOrder.findUnique.mockResolvedValue(existing);
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', {
        amount: 1000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'fo1', invoiceStatus: 'invoiced' }));

    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(deferred.replacePolicy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays an invoice created after Moscow midnight without shifting its due day', async () => {
    const { prisma, audit, deferred } = setup();
    const invoiceIssuedAt = new Date('2026-08-13T21:15:00.000Z');
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt,
      schedules: [
        {
          kind: 'invoice_prepayment',
          amount: 500,
          startsAt: invoiceIssuedAt,
          dueDate: new Date('2026-08-14T00:00:00.000Z'),
          status: 'paid',
        },
        {
          kind: 'post_delivery',
          amount: 500.01,
          startsAt: null,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await service.createInvoice(actor, 'fo1', {
      amount: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
    });

    expect(deferred.replacePolicy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('createInvoice replays an identical canonical payload without another policy or audit', async () => {
    const { prisma, audit, deferred } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedPaymentPolicy,
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500.01,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500,
          startsAt: null,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', { amount: 1000.01, paymentPolicy }),
    ).resolves.toEqual(expect.objectContaining({ id: 'fo1', invoiceStatus: 'invoiced' }));

    expect(prisma.financeOrder.updateMany).not.toHaveBeenCalled();
    expect(deferred.replacePolicy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays a shipped historical residual split with the actual shipment due date', async () => {
    const { prisma, audit, deferred } = setup();
    const shipmentCompletedAt = new Date('2026-07-31T12:30:00.000Z');
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedPaymentPolicy,
      commercialOrder: { ...fo.commercialOrder, shipmentCompletedAt },
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500.01,
          startsAt: shipmentCompletedAt,
          dueDate: new Date('2026-08-30T00:00:00.000Z'),
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', {
        amount: 1000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'fo1', invoiceStatus: 'invoiced' }));

    expect(deferred.replacePolicy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a shipped historical retry whose post-delivery due date is still null', async () => {
    const { prisma, audit, deferred } = setup();
    const shipmentCompletedAt = new Date('2026-07-31T12:30:00.000Z');
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedPaymentPolicy,
      commercialOrder: { ...fo.commercialOrder, shipmentCompletedAt },
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500.01,
          startsAt: shipmentCompletedAt,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', {
        amount: 1000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
    });
  });

  it('rejects a canonical retry with a missing invoice startsAt anchor', async () => {
    const { prisma, audit, deferred } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedPaymentPolicy,
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500.01,
          startsAt: null,
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500,
          startsAt: null,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', { amount: 1000.01, paymentPolicy }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
    });
  });

  it('rejects a shipped canonical retry with the wrong post-delivery startsAt anchor', async () => {
    const { prisma, audit, deferred } = setup();
    const shipmentCompletedAt = new Date('2026-07-31T12:30:00.000Z');
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedPaymentPolicy,
      commercialOrder: { ...fo.commercialOrder, shipmentCompletedAt },
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500.01,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500,
          startsAt: new Date('2026-07-30T12:30:00.000Z'),
          dueDate: new Date('2026-08-30T00:00:00.000Z'),
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', { amount: 1000.01, paymentPolicy }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
    });
  });

  it('rejects legacy fallback when orphan schedule snapshots disagree with the template', async () => {
    const { prisma, audit, deferred } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: null,
      schedules: [
        {
          paymentPolicyStageId: null,
          percentageBasisPoints: 4000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: null,
          percentageBasisPoints: 6000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500.01,
          startsAt: null,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', {
        amount: 1000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
    });
  });

  it('does not use the historical residual fallback for a labeled template policy', async () => {
    const { prisma, audit, deferred } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedLabeledPaymentPolicy,
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500,
          startsAt: new Date('2026-07-11T08:00:00.000Z'),
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500.01,
          startsAt: null,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);

    await expect(
      service.createInvoice(actor, 'fo1', {
        amount: 1000.01,
        paymentPolicy: labeledPaymentPolicy,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
    });
  });

  it('createInvoice rejects a retry whose canonical policy differs', async () => {
    const { prisma, audit, deferred } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({
      ...fo,
      invoiceStatus: 'invoiced',
      amountValue: 1000.01,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      policy: persistedPaymentPolicy,
      schedules: [
        {
          paymentPolicyStageId: 'stage-1',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          kind: 'invoice_prepayment',
          amount: 500.01,
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'unpaid',
        },
        {
          paymentPolicyStageId: 'stage-2',
          percentageBasisPoints: 5000,
          offsetDays: 30,
          kind: 'post_delivery',
          amount: 500,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit, deferred);
    const differentPolicy: PaymentPolicyInput = {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 4000,
          offsetDays: 0,
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 6000,
          offsetDays: 30,
        },
      ],
    };

    await expect(
      service.createInvoice(actor, 'fo1', { amount: 1000.01, paymentPolicy: differentPolicy }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
    });

    expect(prisma.financeOrder.updateMany).not.toHaveBeenCalled();
    expect(deferred.replacePolicy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', 999.99, 'prepay_50_postpay_50_30d'],
    ['terms', 1000.01, 'postpay_100_30d'],
  ] as const)(
    'createInvoice rejects an incompatible %s retry with a stable conflict code',
    async (_field, amount, paymentTermsType) => {
      const { prisma, audit, deferred } = setup();
      prisma.financeOrder.findUnique.mockResolvedValue({
        ...fo,
        invoiceStatus: 'invoiced',
        amountValue: 1000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d',
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
        schedules: [
          {
            kind: 'invoice_prepayment',
            amount: 500,
            dueDate: new Date('2026-07-11T00:00:00.000Z'),
            status: 'unpaid',
          },
          { kind: 'post_delivery', amount: 500.01, dueDate: null, status: 'unpaid' },
        ],
      });
      const service = await build(prisma, audit, deferred);

      const error = await service
        .createInvoice(actor, 'fo1', { amount, paymentTermsType })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
      );
      expect(prisma.financeOrder.update).not.toHaveBeenCalled();
      expect(deferred.replacePolicy).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('delegates canonical and legacy policy selection plus targeted confirmation', async () => {
    const { prisma, audit, deferred } = setup();
    const service = await build(prisma, audit, deferred);

    await service.setPaymentPolicy(actor, 'fo1', {
      expectedRevision: 1,
      reason: 'Новый график',
      paymentPolicy,
    });
    await service.setPaymentTerms(actor, 'fo1', {
      paymentTermsType: 'postpay_100_30d',
    });
    await service.confirmSchedule(actor, 'fo1', 'schedule-1');

    expect(deferred.setPolicy).toHaveBeenCalledWith(actor, 'fo1', {
      expectedRevision: 1,
      reason: 'Новый график',
      paymentPolicy,
    });
    expect(deferred.setTerms).toHaveBeenCalledWith(actor, 'fo1', {
      paymentTermsType: 'postpay_100_30d',
    });
    expect(deferred.confirmSchedule).toHaveBeenCalledWith(actor, 'fo1', 'schedule-1', undefined);
  });

  it('returns an exact claimed payment update without rewriting the aggregate or audit', async () => {
    const { prisma, audit } = setup();
    const dto = {
      operationKey: PAYMENT_UPDATE_KEY,
      paymentStatus: 'partial' as const,
    };
    prisma.financePaymentUpdateCommand.createMany.mockResolvedValue({ count: 0 });
    prisma.financePaymentUpdateCommand.findUnique.mockResolvedValue({
      id: 'payment-update-existing',
      financeOrderId: 'fo1',
      operationKey: PAYMENT_UPDATE_KEY,
      requestFingerprint: requestFingerprint({
        actorRole: 'finance',
        paymentStatus: 'partial',
      }),
      actorRole: 'finance',
      createdAt: new Date('2026-07-21T12:00:00.000Z'),
    });
    const service = await build(prisma, audit);

    await service.updatePayment(actor, 'fo1', dto);

    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ['paid without a payment fact', 'paid' as const, []],
    [
      'partial after facts cover the invoice',
      'partial' as const,
      [{ amount: new Prisma.Decimal(1000), paymentAllocationId: null }],
    ],
  ])(
    'rejects %s before mutating payment, production or audit state',
    async (_case, status, ops) => {
      const { prisma, audit } = setup();
      prisma.financeOrder.findUnique
        .mockResolvedValueOnce({
          ...fo,
          invoiceStatus: 'invoiced',
          amountValue: new Prisma.Decimal(1000),
          operations: ops,
          paymentAllocations: [],
          schedules: [{ id: 'schedule-1', status: 'unpaid' }],
        })
        .mockResolvedValue(fo);
      const service = await build(prisma, audit);

      await expect(
        service.updatePayment(actor, 'fo1', {
          operationKey: PAYMENT_UPDATE_KEY,
          paymentStatus: status,
        }),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_PAYMENT_STATUS_FACT_CONFLICT' },
      });

      expect(prisma.financeOrder.update).not.toHaveBeenCalled();
      expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
      expect(prisma.paymentSchedule.updateMany).not.toHaveBeenCalled();
      expect(prisma.domainEvent.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'actor role',
      { userId: 'admin-1', role: 'admin' as const },
      { operationKey: PAYMENT_UPDATE_KEY, paymentStatus: 'partial' as const },
    ],
    ['payment status', actor, { operationKey: PAYMENT_UPDATE_KEY, paymentStatus: 'paid' as const }],
  ])('rejects changed %s for a claimed payment update key', async (_field, nextActor, dto) => {
    const { prisma, audit } = setup();
    prisma.financePaymentUpdateCommand.createMany.mockResolvedValue({ count: 0 });
    prisma.financePaymentUpdateCommand.findUnique.mockResolvedValue({
      id: 'payment-update-existing',
      financeOrderId: 'fo1',
      operationKey: PAYMENT_UPDATE_KEY,
      requestFingerprint: requestFingerprint({
        actorRole: 'finance',
        paymentStatus: 'partial',
      }),
      actorRole: 'finance',
      createdAt: new Date('2026-07-21T12:00:00.000Z'),
    });
    const service = await build(prisma, audit);

    await expect(service.updatePayment(nextActor, 'fo1', dto)).rejects.toMatchObject({
      response: { code: 'FINANCE_PAYMENT_UPDATE_KEY_CONFLICT' },
    });
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.create).not.toHaveBeenCalled();
  });

  it('executes the aggregate mutation once for concurrent exact payment update retries', async () => {
    const { prisma, audit } = setup();
    const dto = {
      operationKey: PAYMENT_UPDATE_KEY,
      paymentStatus: 'partial' as const,
    };
    prisma.financeOrder.findUnique.mockResolvedValue(financeOrderWithIndependentPaid(600, 1000));
    const service = await build(prisma, audit);

    await Promise.all([
      service.updatePayment(actor, 'fo1', dto),
      service.updatePayment(actor, 'fo1', dto),
    ]);

    expect(prisma.financePaymentUpdateCommand.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.financeOrder.update).toHaveBeenCalledTimes(1);
    expect(prisma.commercialOrder.update).toHaveBeenCalledTimes(1);
    expect(prisma.domainEvent.create).toHaveBeenCalledTimes(2);
  });

  it.each(['unpaid', 'overdue', 'sync_error'] as const)(
    'rejects manual %s before opening a transaction or writing state',
    async (paymentStatus) => {
      const { prisma, audit } = setup();
      const service = await build(prisma, audit);

      await expect(
        service.updatePayment(actor, 'fo1', {
          operationKey: PAYMENT_UPDATE_KEY,
          paymentStatus,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.financePaymentUpdateCommand.createMany).not.toHaveBeenCalled();
      expect(prisma.financeOrder.update).not.toHaveBeenCalled();
      expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
      expect(prisma.paymentSchedule.updateMany).not.toHaveBeenCalled();
      expect(prisma.domainEvent.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('rejects the server-derived stock payment status before opening a transaction', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.updatePayment(actor, 'fo1', {
        operationKey: PAYMENT_UPDATE_KEY,
        paymentStatus: 'not_applicable',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
  });

  it('updatePayment partial moves commercial order to in_work and locks edits', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue(financeOrderWithIndependentPaid(5000));
    const service = await build(prisma, audit);
    await service.updatePayment(actor, 'fo1', paymentUpdateDto('partial'));

    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'co1' },
        data: expect.objectContaining({
          paymentStatus: 'partial',
          commercialStage: 'in_work',
          financeConfirmedAt: expect.any(Date),
          commercialLockedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'audit:commercial_order_locked_by_payment',
          objectId: 'co1',
          detail: {
            commercialOrderId: 'co1',
            financeOrderId: 'fo1',
            orderNumber: 'A-1024',
          },
        }),
      }),
    );
  });

  it('updatePayment paid moves commercial order to in_work and locks edits', async () => {
    const { prisma } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue(financeOrderWithIndependentPaid(100000));
    const service = await build(prisma, { record: jest.fn(), forObject: jest.fn() });
    await service.updatePayment(actor, 'fo1', paymentUpdateDto('paid'));

    expect(prisma.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentStatus: 'paid',
          commercialStage: 'in_work',
          financeConfirmedAt: expect.any(Date),
          commercialLockedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('captures production clearance when a manual payment first satisfies prepayment', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique
      .mockResolvedValueOnce({
        ...financeOrderWithIndependentPaid(100000),
        invoiceStatus: 'invoiced',
        paymentTermsType: null,
      })
      .mockResolvedValueOnce({
        ...fo,
        invoiceStatus: 'invoiced',
        productionClearedAt: null,
        paymentTermsType: null,
        policy: {
          id: 'policy-1',
          stages: [{ id: 'prepay-stage', trigger: 'invoice_issued' }],
        },
        schedules: [
          {
            paymentPolicyStageId: 'prepay-stage',
            kind: 'invoice_prepayment',
            status: 'paid',
          },
        ],
      });
    const service = await build(prisma, audit);

    await service.updatePayment(actor, 'fo1', paymentUpdateDto('paid'));

    expect(prisma.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', productionClearedAt: null },
      data: { productionClearedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'fo1',
      }),
      prisma,
    );
  });

  it('updatePayment writes finance, commercial, and audit facts inside the same transaction', async () => {
    const { prisma, audit } = setup();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'fo1' }]),
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue(financeOrderWithIndependentPaid(100000)),
        update: jest.fn(),
      },
      commercialOrder: { update: jest.fn() },
      domainEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-tx' }) },
      paymentSchedule: { create: jest.fn(), updateMany: jest.fn() },
      financePaymentUpdateCommand: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            id: 'payment-update-tx',
            financeOrderId: 'fo1',
            operationKey: PAYMENT_UPDATE_KEY,
            requestFingerprint: requestFingerprint({
              actorRole: 'finance',
              paymentStatus: 'paid',
            }),
            actorRole: 'finance',
            createdAt: new Date('2026-07-21T12:00:00.000Z'),
          }),
      },
    };
    prisma.$transaction
      .mockImplementationOnce(async (fn: any) => fn(tx))
      .mockImplementationOnce(async (fn: any) => fn(prisma));
    const service = await build(prisma, audit);

    await service.updatePayment(actor, 'fo1', paymentUpdateDto('paid'));

    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.financeOrder.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { paymentStatus: 'paid' },
    });
    expect(tx.commercialOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'co1' },
        data: expect.objectContaining({ paymentStatus: 'paid', commercialStage: 'in_work' }),
      }),
    );
    expect(tx.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'audit:payment_status_updated' }),
      }),
    );
    expect(tx.domainEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'audit:commercial_order_locked_by_payment',
          objectId: 'co1',
        }),
      }),
    );
    expect(prisma.financeOrder.update).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('updatePayment partial does not create arbitrary payment schedule rows', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue(financeOrderWithIndependentPaid(30000));
    const service = await build(prisma, audit);

    await service.updatePayment(actor, 'fo1', paymentUpdateDto('partial'));

    expect(prisma.paymentSchedule.create).not.toHaveBeenCalled();
  });

  it('updatePayment paid closes open installment schedules', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue(financeOrderWithIndependentPaid(100000));
    const service = await build(prisma, audit);

    await service.updatePayment(actor, 'fo1', paymentUpdateDto('paid'));

    expect(prisma.paymentSchedule.updateMany).toHaveBeenCalledWith({
      where: { financeOrderId: 'fo1', status: { not: 'paid' } },
      data: { status: 'paid' },
    });
  });

  it('captures an addressable payment fact and every schedule transition before mutation', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValueOnce({
      ...financeOrderWithIndependentPaid(100000),
      paymentStatus: 'partial',
      schedules: [
        { id: 'paid-stage', status: 'paid' },
        { id: 'open-stage', status: 'unpaid' },
        { id: 'overdue-stage', status: 'overdue' },
      ],
    });
    const service = await build(prisma, audit);

    await service.updatePayment(actor, 'fo1', paymentUpdateDto('paid'));

    expect(prisma.financePaymentUpdateCommand.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          financeOrderId: 'fo1',
          operationKey: PAYMENT_UPDATE_KEY,
          requestedStatus: 'paid',
          previousStatus: 'partial',
          result: {
            paymentStatus: 'paid',
            previousStatus: 'partial',
            scheduleTransitions: [
              {
                scheduleId: 'open-stage',
                previousStatus: 'unpaid',
                requestedStatus: 'paid',
              },
              {
                scheduleId: 'overdue-stage',
                previousStatus: 'overdue',
                requestedStatus: 'paid',
              },
            ],
          },
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('cash operation audits cash_operation_recorded', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.recordOperation(actor, 'fo1', {
      operationKey: PAYMENT_OPERATION_KEY,
      operationType: 'cash',
      amount: 5000,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:cash_operation_recorded' }),
      prisma,
    );
  });

  it('records a payment operation and its audit through the same transaction client', async () => {
    const { prisma, audit } = setup();
    const tx = {
      financeOrder: { findUnique: jest.fn().mockResolvedValue(fo) },
      paymentOperation: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'op-tx',
          financeOrderId: 'fo1',
          operationKey: PAYMENT_OPERATION_KEY,
          operationType: 'cash',
          amount: 5000.25,
          source: 'manual_platform',
          createdByRole: 'finance',
        }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await service.recordOperation(actor, 'fo1', {
      operationKey: PAYMENT_OPERATION_KEY,
      operationType: 'cash',
      amount: 5000.25,
    });

    expect(tx.paymentOperation.createMany).toHaveBeenCalledWith({
      data: [
        {
          financeOrderId: 'fo1',
          operationKey: PAYMENT_OPERATION_KEY,
          operationType: 'cash',
          amount: 5000.25,
          source: 'manual_platform',
          createdByRole: 'finance',
        },
      ],
      skipDuplicates: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:cash_operation_recorded',
        detail: expect.objectContaining({
          operationKey: PAYMENT_OPERATION_KEY,
          source: 'manual_platform',
        }),
      }),
      tx,
    );
    expect(prisma.paymentOperation.create).not.toHaveBeenCalled();
  });

  it('replays the same keyed payment operation without duplicate money or audit', async () => {
    const { prisma, audit } = setup();
    prisma.paymentOperation.createMany.mockResolvedValue({ count: 0 });
    const service = await build(prisma, audit);

    const result = await service.recordOperation(actor, 'fo1', {
      operationKey: PAYMENT_OPERATION_KEY,
      operationType: 'cash',
      amount: 5000,
    });

    expect(result).toMatchObject({ id: 'op1', operationKey: PAYMENT_OPERATION_KEY });
    expect(prisma.paymentOperation.createMany).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('canonicalizes an uppercase payment key before every claim and lookup', async () => {
    const { prisma, audit } = setup();
    prisma.paymentOperation.createMany.mockResolvedValue({ count: 0 });
    prisma.paymentOperation.findUnique.mockImplementation(
      ({ where }: { where: { financeOrderId_operationKey: { operationKey: string } } }) =>
        where.financeOrderId_operationKey.operationKey === PAYMENT_OPERATION_KEY
          ? {
              id: 'op1',
              financeOrderId: 'fo1',
              operationKey: PAYMENT_OPERATION_KEY,
              operationType: 'cash',
              amount: 5000,
              source: 'manual_platform',
              createdByRole: 'finance',
            }
          : null,
    );
    const service = await build(prisma, audit);

    const result = await service.recordOperation(actor, 'fo1', {
      operationKey: PAYMENT_OPERATION_KEY.toUpperCase(),
      operationType: 'cash',
      amount: 5000,
    });

    expect(result).toMatchObject({ id: 'op1', operationKey: PAYMENT_OPERATION_KEY });
    expect(prisma.paymentOperation.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ operationKey: PAYMENT_OPERATION_KEY })],
      skipDuplicates: true,
    });
    expect(prisma.paymentOperation.findUnique).toHaveBeenCalledWith({
      where: {
        financeOrderId_operationKey: {
          financeOrderId: 'fo1',
          operationKey: PAYMENT_OPERATION_KEY,
        },
      },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects reusing a payment operation key with different money', async () => {
    const { prisma, audit } = setup();
    prisma.paymentOperation.createMany.mockResolvedValue({ count: 0 });
    const service = await build(prisma, audit);

    await expect(
      service.recordOperation(actor, 'fo1', {
        operationKey: PAYMENT_OPERATION_KEY,
        operationType: 'cash',
        amount: 5000.01,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_OPERATION_KEY_CONFLICT' }),
    });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a non-v4 payment operation key before a durable write', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.recordOperation(actor, 'fo1', {
        operationKey: 'not-a-v4-uuid',
        operationType: 'cash',
        amount: 5000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.001,
    MAX_PAYMENT_OPERATION_AMOUNT + 0.01,
  ])('rejects invalid payment operation amount %p before a durable write', async (amount) => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.recordOperation(actor, 'fo1', {
        operationKey: PAYMENT_OPERATION_KEY,
        operationType: 'cash',
        amount,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.paymentOperation.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('non-cash (invoice) operation audits payment_status_imported', async () => {
    const { prisma, audit } = setup();
    prisma.paymentOperation.findUnique.mockResolvedValue({
      id: 'op-invoice',
      financeOrderId: 'fo1',
      operationKey: PAYMENT_OPERATION_KEY,
      operationType: 'invoice',
      amount: 5000,
      source: 'manual_platform',
      createdByRole: 'finance',
    });
    const service = await build(prisma, audit);
    await service.recordOperation(actor, 'fo1', {
      operationKey: PAYMENT_OPERATION_KEY,
      operationType: 'invoice',
      amount: 5000,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:payment_status_imported' }),
      prisma,
    );
  });

  it('sourceRetry rejects an unlinked finance order before any 1С network call', async () => {
    const { prisma, audit } = setup();
    prisma.financeOrder.findUnique.mockResolvedValue({ ...fo, externalId: null });
    const service = await build(prisma, audit);

    await expect(
      service.sourceRetry(actor, 'fo1', { operationKey: SOURCE_RETRY_KEY }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_ONEC_INVOICE_NOT_LINKED' }),
    });
    expect(onec.pullInvoice).not.toHaveBeenCalled();
    expect(prisma.syncJournal.createMany).not.toHaveBeenCalled();
  });

  it('sourceRetry pulls via 1С, stores a snapshot, and audits sync_retry_requested', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.sourceRetry(actor, 'fo1', { operationKey: SOURCE_RETRY_KEY });
    expect(onec.pullInvoice).toHaveBeenCalledWith(ONEC_INVOICE_ID);
    expect(prisma.sourceSnapshot.create).toHaveBeenCalled();
    const snapData = prisma.sourceSnapshot.create.mock.calls[0][0].data;
    expect(snapData.subjectType).toBe('invoice');
    expect(snapData.externalId).toBe('mock-invoice-co1');
    expect(snapData.sourceVersion).toBe('v1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:sync_retry_requested' }),
      prisma,
    );
  });

  it('atomically claims source retry state and its request audit before the external pull', async () => {
    const { prisma, audit } = setup();
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue({
          ...fo,
          sourceStatus: 'error',
        }),
        update: jest.fn(),
      },
      syncJournal: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue({
          id: 'retry-1',
          financeOrderId: 'fo1',
          operationKey: SOURCE_RETRY_KEY,
          activeScopeKey: 'finance-source-retry:fo1',
          status: 'retry_requested',
          retries: 1,
          leaseExpiresAt: expect.any(Date),
        }),
      },
    };
    prisma.$transaction
      .mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback(tx))
      .mockRejectedValueOnce(new Error('stop after claim'));
    const service = await build(prisma, audit);

    await expect(
      service.sourceRetry(actor, 'fo1', { operationKey: SOURCE_RETRY_KEY }),
    ).rejects.toThrow('stop after claim');

    expect(tx.syncJournal.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          financeOrderId: 'fo1',
          operationKey: SOURCE_RETRY_KEY,
          activeScopeKey: 'finance-source-retry:fo1',
          status: 'retry_requested',
          retries: 1,
          leaseExpiresAt: expect.any(Date),
        }),
      ],
      skipDuplicates: true,
    });
    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { sourceStatus: 'retry_requested' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:sync_retry_requested',
        oldValue: { sourceStatus: 'error' },
        newValue: { sourceStatus: 'retry_requested' },
        detail: expect.objectContaining({ operationKey: SOURCE_RETRY_KEY, attempt: 1 }),
      }),
      tx,
    );
  });

  it('keeps the retry lease beyond the maximum configured 1C timeout', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
    try {
      const { prisma, audit } = setup();
      const tx = {
        financeOrder: { findUnique: jest.fn().mockResolvedValue(fo), update: jest.fn() },
        syncJournal: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(0),
          findUnique: jest.fn().mockResolvedValue({
            id: 'retry-long-lease',
            financeOrderId: 'fo1',
            operationKey: SOURCE_RETRY_KEY,
            activeScopeKey: 'finance-source-retry:fo1',
            status: 'retry_requested',
            retries: 1,
          }),
        },
      };
      prisma.$transaction
        .mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback(tx))
        .mockRejectedValueOnce(new Error('stop after long lease claim'));
      const service = await build(prisma, audit);

      await expect(
        service.sourceRetry(actor, 'fo1', { operationKey: SOURCE_RETRY_KEY }),
      ).rejects.toThrow('stop after long lease claim');

      const claim = tx.syncJournal.createMany.mock.calls[0][0].data[0];
      expect(claim.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(120_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('commits a claimed snapshot, ready state, journal result, and safe import event together', async () => {
    const { prisma, audit } = setup();
    const claimTx = {
      financeOrder: { findUnique: jest.fn().mockResolvedValue(fo), update: jest.fn() },
      syncJournal: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue({
          id: 'retry-1',
          financeOrderId: 'fo1',
          operationKey: SOURCE_RETRY_KEY,
          activeScopeKey: 'finance-source-retry:fo1',
          status: 'retry_requested',
          retries: 1,
        }),
      },
    };
    const finalizeTx = {
      sourceSnapshot: { create: jest.fn().mockResolvedValue({ id: 'snapshot-retry-1' }) },
      financeOrder: { update: jest.fn() },
      syncJournal: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma.$transaction
      .mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback(claimTx))
      .mockImplementationOnce(async (callback: (client: unknown) => unknown) =>
        callback(finalizeTx),
      );
    const service = await build(prisma, audit);

    await service.sourceRetry(actor, 'fo1', { operationKey: SOURCE_RETRY_KEY });

    expect(onec.pullInvoice).toHaveBeenCalledWith(ONEC_INVOICE_ID);
    expect(finalizeTx.sourceSnapshot.create).toHaveBeenCalledTimes(1);
    expect(finalizeTx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { sourceStatus: 'ready' },
    });
    expect(finalizeTx.syncJournal.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'retry-1',
        operationKey: SOURCE_RETRY_KEY,
        status: 'retry_requested',
        activeScopeKey: 'finance-source-retry:fo1',
      },
      data: {
        status: 'ready',
        activeScopeKey: null,
        leaseExpiresAt: null,
        sourceSnapshotId: 'snapshot-retry-1',
        completedAt: expect.any(Date),
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.onec_imported',
        sourceSnapshotId: 'snapshot-retry-1',
        detail: expect.objectContaining({ operationKey: SOURCE_RETRY_KEY }),
      }),
      finalizeTx,
    );
  });

  it('replays a completed source retry key without another pull, snapshot, or audit', async () => {
    const { prisma, audit } = setup();
    prisma.syncJournal.createMany.mockResolvedValue({ count: 0 });
    prisma.syncJournal.findUnique.mockResolvedValue({
      id: 'retry-1',
      financeOrderId: 'fo1',
      operationKey: SOURCE_RETRY_KEY,
      activeScopeKey: null,
      sourceSnapshotId: 'snapshot-retry-1',
      status: 'ready',
      retries: 1,
    });
    const service = await build(prisma, audit);

    await service.sourceRetry(actor, 'fo1', { operationKey: SOURCE_RETRY_KEY });

    expect(onec.pullInvoice).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('canonicalizes an uppercase source retry key before every claim and lookup', async () => {
    const { prisma, audit } = setup();
    prisma.syncJournal.createMany.mockResolvedValue({ count: 0 });
    prisma.syncJournal.findUnique.mockImplementation(
      ({ where }: { where: { operationKey?: string; activeScopeKey?: string } }) => {
        if (where.operationKey !== SOURCE_RETRY_KEY) return null;
        return {
          id: 'retry-1',
          financeOrderId: 'fo1',
          operationKey: SOURCE_RETRY_KEY,
          activeScopeKey: null,
          sourceSnapshotId: 'snapshot-retry-1',
          status: 'ready',
          retries: 1,
        };
      },
    );
    const service = await build(prisma, audit);

    await service.sourceRetry(actor, 'fo1', {
      operationKey: SOURCE_RETRY_KEY.toUpperCase(),
    });

    expect(prisma.syncJournal.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ operationKey: SOURCE_RETRY_KEY })],
      skipDuplicates: true,
    });
    expect(prisma.syncJournal.findUnique).toHaveBeenCalledWith({
      where: { operationKey: SOURCE_RETRY_KEY },
    });
    expect(onec.pullInvoice).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a different source retry key while the order has an active claim', async () => {
    const { prisma, audit } = setup();
    const otherKey = '4f0be48e-4b43-4f8e-8c1c-54cab5ea0b90';
    prisma.syncJournal.createMany.mockResolvedValue({ count: 0 });
    prisma.syncJournal.findUnique.mockImplementation(
      ({ where }: { where: { operationKey?: string; activeScopeKey?: string } }) => {
        if (where.operationKey) return null;
        return {
          id: 'retry-active',
          financeOrderId: 'fo1',
          operationKey: SOURCE_RETRY_KEY,
          activeScopeKey: 'finance-source-retry:fo1',
          status: 'retry_requested',
        };
      },
    );
    const service = await build(prisma, audit);

    await expect(
      service.sourceRetry(actor, 'fo1', { operationKey: otherKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_SOURCE_RETRY_ACTIVE_CONFLICT' }),
    });

    expect(onec.pullInvoice).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('expires a stale source retry claim before accepting a new operation key', async () => {
    const { prisma, audit } = setup();
    const newKey = '4f0be48e-4b43-4f8e-8c1c-54cab5ea0b90';
    const activeScopeKey = 'finance-source-retry:fo1';
    const tx = {
      financeOrder: { findUnique: jest.fn().mockResolvedValue(fo), update: jest.fn() },
      syncJournal: {
        count: jest.fn().mockResolvedValue(1),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(
          ({ where }: { where: { operationKey?: string; activeScopeKey?: string } }) =>
            where.activeScopeKey
              ? {
                  id: 'retry-stale',
                  financeOrderId: 'fo1',
                  operationKey: SOURCE_RETRY_KEY,
                  activeScopeKey,
                  status: 'retry_requested',
                  leaseExpiresAt: new Date('2026-07-17T00:00:00.000Z'),
                }
              : {
                  id: 'retry-new',
                  financeOrderId: 'fo1',
                  operationKey: newKey,
                  activeScopeKey,
                  status: 'retry_requested',
                  retries: 2,
                },
        ),
      },
    };
    prisma.$transaction
      .mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback(tx))
      .mockRejectedValueOnce(new Error('stop after reclaimed claim'));
    const service = await build(prisma, audit);

    await expect(service.sourceRetry(actor, 'fo1', { operationKey: newKey })).rejects.toThrow(
      'stop after reclaimed claim',
    );

    expect(tx.syncJournal.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'retry-stale',
        operationKey: SOURCE_RETRY_KEY,
        activeScopeKey,
        status: 'retry_requested',
        leaseExpiresAt: { lte: expect.any(Date) },
      },
      data: {
        status: 'error',
        activeScopeKey: null,
        leaseExpiresAt: null,
        recovery: 'Source retry lease expired before completion.',
        completedAt: expect.any(Date),
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.onec_import_failed',
        detail: {
          operationKey: SOURCE_RETRY_KEY,
          code: 'SOURCE_RETRY_LEASE_EXPIRED',
        },
      }),
      tx,
    );
    expect(tx.syncJournal.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ operationKey: newKey, retries: 2 })],
      }),
    );
  });

  it('stops when expiry CAS loses to a completed owner instead of starting another pull', async () => {
    const { prisma, audit } = setup();
    const newKey = '4f0be48e-4b43-4f8e-8c1c-54cab5ea0b90';
    const activeScopeKey = 'finance-source-retry:fo1';
    const expired = {
      id: 'retry-expiry-race',
      financeOrderId: 'fo1',
      operationKey: SOURCE_RETRY_KEY,
      activeScopeKey,
      status: 'retry_requested',
      sourceSnapshotId: null,
      leaseExpiresAt: new Date('2026-07-17T00:00:00.000Z'),
    };
    const winner = {
      ...expired,
      activeScopeKey: null,
      status: 'ready',
      sourceSnapshotId: 'snapshot-winner',
      leaseExpiresAt: null,
    };
    const tx = {
      financeOrder: { findUnique: jest.fn().mockResolvedValue(fo), update: jest.fn() },
      sourceSnapshot: {
        create: jest.fn().mockResolvedValue({ id: 'snapshot-new-claim' }),
      },
      syncJournal: {
        count: jest.fn().mockResolvedValue(1),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
        findUnique: jest.fn(
          ({
            where,
          }: {
            where: { id?: string; activeScopeKey?: string; operationKey?: string };
          }) =>
            where.id
              ? winner
              : where.operationKey === newKey
                ? {
                    ...expired,
                    id: 'retry-new-after-lost-cas',
                    operationKey: newKey,
                  }
                : expired,
        ),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await expect(service.sourceRetry(actor, 'fo1', { operationKey: newKey })).rejects.toMatchObject(
      {
        response: expect.objectContaining({ code: 'FINANCE_SOURCE_RETRY_STATE_CHANGED' }),
      },
    );

    expect(tx.syncJournal.createMany).not.toHaveBeenCalled();
    expect(onec.pullInvoice).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a non-v4 source retry key before claim or adapter access', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await expect(
      service.sourceRetry(actor, 'fo1', { operationKey: 'not-a-v4-uuid' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onec.pullInvoice).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reportProblem sends an overdue finance problem to the director queue', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.reportProblem(actor, 'fo1', {
      kind: 'overdue',
      reason: 'Payment is overdue by contract',
      evidence: '1C invoice СЧ-1024',
    });

    expect(prisma.directorDecision.create).toHaveBeenCalledWith({
      data: {
        scope: 'finance',
        objectId: 'fo1',
        evidence: '1C invoice СЧ-1024',
        severity: 'critical',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:payment_overdue' }),
      prisma,
    );
  });

  it('commits a finance problem, director decision, and audit in one transaction', async () => {
    const { prisma, audit } = setup();
    const tx = {
      financeOrder: { findUnique: jest.fn().mockResolvedValue(fo) },
      productionProblem: { create: jest.fn() },
      directorDecision: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    );
    const service = await build(prisma, audit);

    await service.reportProblem(actor, 'fo1', {
      kind: 'overdue',
      reason: 'Payment is overdue by contract',
      evidence: 'Signed reconciliation statement',
    });

    expect(tx.productionProblem.create).toHaveBeenCalledTimes(1);
    expect(tx.directorDecision.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:payment_overdue' }),
      tx,
    );
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(prisma.directorDecision.create).not.toHaveBeenCalled();
  });

  it('reportProblem forwards sync issues to director with reason as fallback evidence', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);

    await service.reportProblem(actor, 'fo1', {
      kind: 'sync',
      reason: 'Source drift',
    });

    expect(prisma.directorDecision.create).toHaveBeenCalledWith({
      data: {
        scope: 'finance',
        objectId: 'fo1',
        evidence: 'Source drift',
        severity: 'warning',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:payment_sync_error' }),
      prisma,
    );
  });

  it('getSourceSnapshot never selects rawPayload (ТЗ §8)', async () => {
    const { prisma, audit } = setup();
    const service = await build(prisma, audit);
    await service.getSourceSnapshot('s1');
    const arg = prisma.sourceSnapshot.findUnique.mock.calls[0][0];
    expect(arg.select.parsed).toBe(true);
    expect(arg.select.rawPayload).toBeUndefined();
  });
});
