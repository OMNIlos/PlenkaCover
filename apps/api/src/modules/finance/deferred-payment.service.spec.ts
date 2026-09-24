import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PaymentPolicyInput } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeferredPaymentService } from './deferred-payment.service';

const actor = { userId: 'finance-user', role: 'finance' as const };
const invoiceIssuedAt = new Date('2026-07-11T08:00:00.000Z');
const invoiceExternalId = 'c9da7a3f-8ce4-4681-aab7-61f87fe12c48';
const scheduleConfirmationKey = '1fe03ca6-3244-4568-b01e-d4ff8d2724f5';
const customPolicy: PaymentPolicyInput = {
  installmentDays: 30,
  stages: [
    {
      sequence: 1,
      trigger: 'invoice_issued',
      percentageBasisPoints: 2000,
      offsetDays: 0,
    },
    {
      sequence: 2,
      trigger: 'full_shipment',
      percentageBasisPoints: 3000,
      offsetDays: 5,
    },
    {
      sequence: 3,
      trigger: 'full_shipment',
      percentageBasisPoints: 2500,
      offsetDays: 15,
    },
    {
      sequence: 4,
      trigger: 'full_shipment',
      percentageBasisPoints: 2500,
      offsetDays: 30,
    },
  ],
};
const previousPolicy = {
  id: 'policy-1',
  financeOrderId: 'fo1',
  installmentDays: 30,
  capturedProductionLeadDays: 2,
  revision: 1,
  stages: [
    {
      id: 'old-stage-1',
      paymentPolicyId: 'policy-1',
      sequence: 1,
      trigger: 'full_shipment',
      percentageBasisPoints: 10000,
      offsetDays: 30,
      label: null,
    },
  ],
};
const prepayPolicySnapshot = {
  id: 'policy-1',
  financeOrderId: 'fo1',
  installmentDays: 30,
  capturedProductionLeadDays: 2,
  revision: 1,
  stages: [
    {
      id: 'prepay-stage',
      paymentPolicyId: 'policy-1',
      sequence: 1,
      trigger: 'invoice_issued',
      percentageBasisPoints: 5000,
      offsetDays: 0,
      label: null,
    },
    {
      id: 'postpay-stage',
      paymentPolicyId: 'policy-1',
      sequence: 2,
      trigger: 'full_shipment',
      percentageBasisPoints: 5000,
      offsetDays: 30,
      label: null,
    },
  ],
};

function setup() {
  const order = {
    id: 'fo1',
    commercialOrderId: 'co1',
    invoiceStatus: 'invoiced',
    invoiceSyncState: 'posted',
    externalId: invoiceExternalId,
    sourceVersion: 'invoice-v2',
    invoiceCurrency: 'RUB',
    paymentStatus: 'unpaid',
    paymentTermsType: null,
    invoiceIssuedAt,
    amountValue: 1000.01,
    schedules: [],
    policy: null,
    commercialOrder: { orderNumber: 'A-1024', shipmentCompletedAt: null },
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'fo1' }]),
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentSchedule: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    paymentPolicy: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({
        id: 'policy-1',
        installmentDays: 30,
        capturedProductionLeadDays: 2,
        revision: 1,
      }),
    },
    paymentPolicyStage: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    paymentOperation: { create: jest.fn() },
    commercialOrder: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma: any = {
    paymentPolicy: tx.paymentPolicy,
    $transaction: jest
      .fn()
      .mockImplementation((operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  const audit = { record: jest.fn() };
  return { order, tx, prisma, audit };
}

async function build(prisma: any, audit: any) {
  const module = await Test.createTestingModule({
    providers: [
      DeferredPaymentService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  return module.get(DeferredPaymentService);
}

describe('DeferredPaymentService', () => {
  it('captures the exact posted 1С invoice on a new policy revision', async () => {
    const { prisma, audit, tx } = setup();
    const service = await build(prisma, audit);

    await service.setPolicy(actor, 'fo1', {
      expectedRevision: 0,
      paymentPolicy: customPolicy,
    });

    expect(tx.paymentPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          invoiceExternalId,
          invoiceSourceVersion: 'invoice-v2',
          capturedInvoiceAmount: 1000.01,
          capturedInvoiceCurrency: 'RUB',
        }),
      }),
    );
  });

  it('allows policy creation for a manually issued invoice without a 1С link', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      invoiceSyncState: 'not_synced',
      externalId: null,
      sourceVersion: null,
    });
    const service = await build(prisma, audit);

    await service.setPolicy(actor, 'fo1', {
      expectedRevision: 0,
      paymentPolicy: customPolicy,
    });

    expect(tx.paymentPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          invoiceExternalId: null,
          invoiceSourceVersion: null,
          capturedInvoiceAmount: 1000.01,
        }),
      }),
    );
  });

  it('persists a four-stage policy and one schedule snapshot per stage', async () => {
    const { prisma, audit, tx } = setup();
    const service = await build(prisma, audit);

    await service.replacePolicy(tx, {
      actor,
      orderId: 'fo1',
      amountValue: 1000.01,
      invoiceIssuedAt,
      shipmentCompletedAt: null,
      previousPolicy: null,
      paymentPolicy: customPolicy,
    });

    expect(tx.paymentPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { financeOrderId: 'fo1' },
        create: expect.objectContaining({
          installmentDays: 30,
          capturedProductionLeadDays: 2,
          revision: 1,
        }),
      }),
    );
    const stageRows = tx.paymentPolicyStage.createMany.mock.calls[0][0].data;
    const scheduleRows = tx.paymentSchedule.createMany.mock.calls[0][0].data;
    expect(stageRows).toHaveLength(4);
    expect(scheduleRows).toEqual([
      expect.objectContaining({
        kind: 'invoice_prepayment',
        amount: 200,
        dueDate: new Date('2026-07-11T00:00:00.000Z'),
      }),
      expect.objectContaining({ kind: 'post_delivery', amount: 300.01, dueDate: null }),
      expect.objectContaining({ kind: 'post_delivery', amount: 250, dueDate: null }),
      expect.objectContaining({ kind: 'post_delivery', amount: 250, dueDate: null }),
    ]);
    expect(
      scheduleRows.map((row: { paymentPolicyStageId: string }) => row.paymentPolicyStageId),
    ).toEqual(stageRows.map((row: { id: string }) => row.id));
    expect(scheduleRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ percentageBasisPoints: 2000, offsetDays: 0 }),
        expect.objectContaining({ percentageBasisPoints: 3000, offsetDays: 5 }),
        expect.objectContaining({ percentageBasisPoints: 2500, offsetDays: 15 }),
        expect.objectContaining({ percentageBasisPoints: 2500, offsetDays: 30 }),
      ]),
    );
    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { paymentTermsType: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:payment_policy_created',
        oldValue: { paymentPolicy: null },
        newValue: expect.objectContaining({
          paymentPolicy: expect.objectContaining({ revision: 1, stages: customPolicy.stages }),
          payments: expect.arrayContaining([
            expect.objectContaining({ sequence: 2, amount: 300.01, dueDate: null }),
          ]),
        }),
      }),
      tx,
    );
  });

  it('dates invoice and shipment schedules by the Moscow business day after UTC rollover', async () => {
    const { prisma, audit, tx } = setup();
    const service = await build(prisma, audit);
    const invoiceAfterMoscowMidnight = new Date('2026-08-13T21:15:00.000Z');
    const shipmentAfterMoscowMidnight = new Date('2026-08-20T21:15:00.000Z');

    await service.replacePolicy(tx, {
      actor,
      orderId: 'fo1',
      amountValue: 1000.01,
      invoiceIssuedAt: invoiceAfterMoscowMidnight,
      shipmentCompletedAt: shipmentAfterMoscowMidnight,
      previousPolicy: null,
      paymentPolicy: customPolicy,
    });

    expect(tx.paymentSchedule.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        startsAt: invoiceAfterMoscowMidnight,
        dueDate: new Date('2026-08-14T00:00:00.000Z'),
      }),
      expect.objectContaining({
        startsAt: shipmentAfterMoscowMidnight,
        dueDate: new Date('2026-08-26T00:00:00.000Z'),
      }),
      expect.objectContaining({ dueDate: new Date('2026-09-05T00:00:00.000Z') }),
      expect.objectContaining({ dueDate: new Date('2026-09-20T00:00:00.000Z') }),
    ]);
  });

  it('does not assign a legacy compatibility label to a labeled template', async () => {
    const { prisma, audit, tx } = setup();
    const service = await build(prisma, audit);
    const labeledTemplate: PaymentPolicyInput = {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          label: 'Аванс',
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 30,
        },
      ],
    };

    await service.replacePolicy(tx, {
      actor,
      orderId: 'fo1',
      amountValue: 1000.01,
      invoiceIssuedAt,
      shipmentCompletedAt: null,
      previousPolicy: null,
      paymentPolicy: labeledTemplate,
    });

    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { paymentTermsType: null },
    });
  });

  it('replaces stages after schedules, increments revision and dates every shipped stage', async () => {
    const { prisma, audit, tx } = setup();
    tx.paymentPolicy.upsert.mockResolvedValue({
      id: 'policy-1',
      installmentDays: 30,
      capturedProductionLeadDays: 2,
      revision: 2,
    });
    const service = await build(prisma, audit);
    const shipmentCompletedAt = new Date('2026-07-31T12:30:00.000Z');

    await service.replacePolicy(tx, {
      actor,
      orderId: 'fo1',
      amountValue: 1000.01,
      invoiceIssuedAt,
      shipmentCompletedAt,
      previousPolicy,
      paymentPolicy: customPolicy,
      reason: 'Новый график',
    });

    expect(tx.paymentSchedule.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.paymentPolicyStage.deleteMany.mock.invocationCallOrder[0],
    );
    expect(tx.paymentPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ revision: { increment: 1 } }),
      }),
    );
    expect(tx.paymentSchedule.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ dueDate: new Date('2026-07-11T00:00:00.000Z') }),
      expect.objectContaining({
        startsAt: shipmentCompletedAt,
        dueDate: new Date('2026-08-05T00:00:00.000Z'),
      }),
      expect.objectContaining({ dueDate: new Date('2026-08-15T00:00:00.000Z') }),
      expect.objectContaining({ dueDate: new Date('2026-08-30T00:00:00.000Z') }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:payment_policy_updated',
        oldValue: expect.objectContaining({
          paymentPolicy: expect.objectContaining({ revision: 1 }),
        }),
        newValue: expect.objectContaining({
          paymentPolicy: expect.objectContaining({ revision: 2 }),
        }),
        reason: 'Новый график',
      }),
      tx,
    );
  });

  it('rejects a stale policy revision before replacing rows', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({ ...order, policy: previousPolicy });
    const service = await build(prisma, audit);

    await expect(
      service.setPolicy(actor, 'fo1', {
        expectedRevision: 0,
        reason: 'Новый график',
        paymentPolicy: customPolicy,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_POLICY_REVISION_CONFLICT' }),
    });

    expect(tx.paymentSchedule.deleteMany).not.toHaveBeenCalled();
    expect(tx.paymentPolicyStage.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('requires a trimmed reason when replacing an existing policy', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({ ...order, policy: previousPolicy });
    const service = await build(prisma, audit);

    await expect(
      service.setPolicy(actor, 'fo1', {
        expectedRevision: 1,
        reason: '   ',
        paymentPolicy: customPolicy,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFERRED_PAYMENT_REASON_REQUIRED' }),
    });

    expect(tx.paymentPolicy.upsert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects policy replacement after any active schedule is paid', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      policy: previousPolicy,
      schedules: [{ id: 'paid-row', kind: 'post_delivery', status: 'paid' }],
    });
    const service = await build(prisma, audit);

    await expect(
      service.setPolicy(actor, 'fo1', {
        expectedRevision: 1,
        reason: 'Новый график',
        paymentPolicy: customPolicy,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFERRED_PAYMENT_ALREADY_STARTED' }),
    });

    expect(tx.paymentPolicy.upsert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects policy replacement after a schedule is partially paid from 1С', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      policy: previousPolicy,
      schedules: [{ id: 'partial-row', kind: 'invoice_prepayment', status: 'partial' }],
    });
    const service = await build(prisma, audit);

    await expect(
      service.setPolicy(actor, 'fo1', {
        expectedRevision: 1,
        reason: 'Новый график',
        paymentPolicy: customPolicy,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEFERRED_PAYMENT_ALREADY_STARTED' }),
    });

    expect(tx.paymentPolicy.upsert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('selects 50/50 terms and creates only fixed rows', async () => {
    const { prisma, audit, tx } = setup();
    const service = await build(prisma, audit);

    await service.setTerms(actor, 'fo1', {
      paymentTermsType: 'prepay_50_postpay_50_30d',
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.financeOrder.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.paymentSchedule.deleteMany).toHaveBeenCalledWith({
      where: {
        financeOrderId: 'fo1',
        kind: { in: ['invoice_prepayment', 'post_delivery'] },
      },
    });
    expect(tx.paymentSchedule.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: 'invoice_prepayment',
          amount: 500.01,
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          source: 'payment_policy',
        }),
        expect.objectContaining({
          kind: 'post_delivery',
          amount: 500,
          dueDate: null,
          source: 'payment_policy',
        }),
      ],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:payment_policy_created' }),
      tx,
    );
  });

  it('captures production clearance immediately for an invoiced all-postpay policy', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValueOnce(order).mockResolvedValueOnce({
      ...order,
      productionClearedAt: null,
      policy: {
        id: 'policy-postpay',
        stages: [{ id: 'postpay-stage', trigger: 'full_shipment' }],
      },
      schedules: [],
    });
    const service = await build(prisma, audit);

    await service.setTerms(actor, 'fo1', {
      paymentTermsType: 'postpay_100_30d',
    });

    expect(tx.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', productionClearedAt: null },
      data: { productionClearedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'fo1',
      }),
      tx,
    );
  });

  it('requires a reason when changing selected terms', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      paymentTermsType: 'postpay_100_30d',
      policy: previousPolicy,
    });
    tx.paymentPolicy.findUnique.mockResolvedValue({ revision: 1 });
    const service = await build(prisma, audit);

    await expect(
      service.setTerms(actor, 'fo1', {
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns an identical terms selection without replacing schedules or writing an event', async () => {
    const { order, prisma, audit, tx } = setup();
    const schedules = [
      {
        id: 'prepay',
        kind: 'invoice_prepayment',
        amount: 500,
        dueDate: new Date('2026-07-11T00:00:00.000Z'),
        status: 'unpaid',
      },
      { id: 'later', kind: 'post_delivery', amount: 500.01, dueDate: null, status: 'unpaid' },
    ];
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      policy: prepayPolicySnapshot,
      schedules,
    });
    tx.paymentPolicy.findUnique.mockResolvedValue({ revision: 1 });
    const service = await build(prisma, audit);

    await expect(
      service.setTerms(actor, 'fo1', {
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).resolves.toBeUndefined();

    expect(tx.paymentSchedule.deleteMany).not.toHaveBeenCalled();
    expect(tx.paymentSchedule.createMany).not.toHaveBeenCalled();
    expect(tx.financeOrder.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not change terms after a fixed payment is confirmed', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      schedules: [{ id: 'paid-row', kind: 'invoice_prepayment', status: 'paid' }],
    });
    const service = await build(prisma, audit);

    await expect(
      service.setTerms(actor, 'fo1', {
        paymentTermsType: 'postpay_100_30d',
        reason: 'Клиент изменил условия',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('confirms exactly one dated row and derives partial status', async () => {
    const { order, prisma, audit, tx } = setup();
    const lockedOrder = {
      ...order,
      paymentTermsType: 'prepay_50_postpay_50_30d',
      schedules: [
        {
          id: 'prepay',
          financeOrderId: 'fo1',
          kind: 'invoice_prepayment',
          amount: 500,
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'unpaid',
        },
        {
          id: 'later',
          financeOrderId: 'fo1',
          kind: 'post_delivery',
          amount: 500.01,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    };
    tx.financeOrder.findUnique.mockResolvedValueOnce(lockedOrder).mockResolvedValueOnce({
      ...lockedOrder,
      productionClearedAt: null,
      policy: {
        id: 'policy-1',
        stages: [{ id: 'prepay-stage', trigger: 'invoice_issued' }],
      },
      schedules: [
        {
          ...lockedOrder.schedules[0],
          paymentPolicyStageId: 'prepay-stage',
          status: 'paid',
        },
        lockedOrder.schedules[1],
      ],
    });
    const service = await build(prisma, audit);

    await service.confirmSchedule(actor, 'fo1', 'prepay', scheduleConfirmationKey.toUpperCase());

    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.financeOrder.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.paymentSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'prepay',
        financeOrderId: 'fo1',
        status: 'unpaid',
        dueDate: new Date('2026-07-11T00:00:00.000Z'),
      },
      data: { status: 'paid' },
    });
    expect(tx.paymentOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        financeOrderId: 'fo1',
        operationKey: scheduleConfirmationKey,
        operationType: 'invoice',
        amount: 500,
        reconciled: true,
      }),
    });
    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'fo1' },
      data: { paymentStatus: 'partial' },
    });
    expect(tx.commercialOrder.update).toHaveBeenCalledWith({
      where: { id: 'co1' },
      data: expect.objectContaining({ paymentStatus: 'partial' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:payment_schedule_item_confirmed',
        detail: {
          commercialOrderId: 'co1',
          financeOrderId: 'fo1',
          orderNumber: 'A-1024',
          scheduleId: 'prepay',
        },
      }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'fo1',
      }),
      tx,
    );
  });

  it('rejects confirmation of an undated post-delivery row', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      paymentTermsType: 'postpay_100_30d',
      schedules: [
        {
          id: 'later',
          financeOrderId: 'fo1',
          kind: 'post_delivery',
          amount: 1000.01,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit);

    await expect(service.confirmSchedule(actor, 'fo1', 'later')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('returns an already paid schedule without creating a second operation or event', async () => {
    const { order, prisma, audit, tx } = setup();
    tx.financeOrder.findUnique.mockResolvedValue({
      ...order,
      paymentStatus: 'partial',
      paymentTermsType: 'prepay_50_postpay_50_30d',
      schedules: [
        {
          id: 'prepay',
          financeOrderId: 'fo1',
          kind: 'invoice_prepayment',
          amount: 500,
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'paid',
        },
        {
          id: 'later',
          financeOrderId: 'fo1',
          kind: 'post_delivery',
          amount: 500.01,
          dueDate: null,
          status: 'unpaid',
        },
      ],
    });
    const service = await build(prisma, audit);

    await expect(service.confirmSchedule(actor, 'fo1', 'prepay')).resolves.toBeUndefined();

    expect(tx.paymentSchedule.updateMany).not.toHaveBeenCalled();
    expect(tx.paymentOperation.create).not.toHaveBeenCalled();
    expect(tx.financeOrder.update).not.toHaveBeenCalled();
    expect(tx.commercialOrder.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('activates every deferred stage from full shipment using its own offset', async () => {
    const { prisma, audit, tx } = setup();
    tx.commercialOrder.findMany.mockResolvedValue([
      {
        id: 'co1',
        orderNumber: 'A-1024',
        shipmentCompletedAt: null,
        financeOrder: {
          id: 'fo1',
        },
      },
    ]);
    tx.paymentSchedule.findMany.mockResolvedValue([
      { id: 'stage-30', offsetDays: 30, status: 'unpaid', dueDate: null },
      { id: 'stage-00', offsetDays: 0, status: 'unpaid', dueDate: null },
      { id: 'stage-15', offsetDays: 15, status: 'unpaid', dueDate: null },
    ]);
    const service = await build(prisma, audit);
    const shipmentCompletedAt = new Date('2026-07-31T12:30:00.000Z');

    await service.activatePostDeliveryPayments({
      actor: { userId: 'warehouse-user', role: 'warehouse' },
      orderNumbers: ['A-1024'],
      shipmentCompletedAt,
      warehouseTaskId: 'delivery-1',
    });

    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.commercialOrder.updateMany.mock.invocationCallOrder[0],
    );
    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'co1', shipmentCompletedAt: null },
      data: { shipmentStatus: 'shipped', shipmentCompletedAt },
    });
    expect(tx.paymentSchedule.findMany).toHaveBeenCalledWith({
      where: {
        financeOrderId: 'fo1',
        kind: 'post_delivery',
        dueDate: null,
        status: 'unpaid',
      },
      select: { id: true, offsetDays: true },
    });
    expect(tx.paymentSchedule.updateMany).toHaveBeenCalledTimes(3);
    expect(tx.paymentSchedule.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'stage-00',
        financeOrderId: 'fo1',
        kind: 'post_delivery',
        dueDate: null,
        status: 'unpaid',
      },
      data: {
        startsAt: shipmentCompletedAt,
        dueDate: new Date('2026-07-31T00:00:00.000Z'),
      },
    });
    expect(tx.paymentSchedule.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'stage-15',
        financeOrderId: 'fo1',
        kind: 'post_delivery',
        dueDate: null,
        status: 'unpaid',
      },
      data: {
        startsAt: shipmentCompletedAt,
        dueDate: new Date('2026-08-15T00:00:00.000Z'),
      },
    });
    expect(tx.paymentSchedule.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: 'stage-30',
        financeOrderId: 'fo1',
        kind: 'post_delivery',
        dueDate: null,
        status: 'unpaid',
      },
      data: {
        startsAt: shipmentCompletedAt,
        dueDate: new Date('2026-08-30T00:00:00.000Z'),
      },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:deferred_payment_due_scheduled',
        objectId: 'fo1',
        newValue: expect.objectContaining({
          payments: [
            { scheduleId: 'stage-00', offsetDays: 0, dueDate: '2026-07-31' },
            { scheduleId: 'stage-15', offsetDays: 15, dueDate: '2026-08-15' },
            { scheduleId: 'stage-30', offsetDays: 30, dueDate: '2026-08-30' },
          ],
        }),
        detail: {
          commercialOrderId: 'co1',
          financeOrderId: 'fo1',
          orderNumber: 'A-1024',
          warehouseTaskId: 'delivery-1',
        },
      }),
      tx,
    );
  });
});
