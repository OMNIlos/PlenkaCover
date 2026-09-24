import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Auth = { Authorization: string };

describe('fixes 1433 finance acceptance (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let commercial: Auth;
  let finance: Auth;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const password = e2eSeedPassword();
    const [commercialSession, financeSession] = await Promise.all(
      (['commercial', 'finance'] as const).map((account) =>
        http()
          .post('/api/auth/login')
          .send({ login: e2eSeedLogin(account), password })
          .expect(201),
      ),
    );
    commercial = { Authorization: `Bearer ${commercialSession.body.token as string}` };
    finance = { Authorization: `Bearer ${financeSession.body.token as string}` };
  });

  afterAll(async () => {
    await app?.close();
  });

  it('carries commercial changes through invoice, partial, overdue and paid with exact BigBag values', async () => {
    const suffix = randomUUID();
    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(commercial)
      .send({ displayName: `Finance acceptance ${suffix}` })
      .expect(201);
    const order = await http()
      .post('/api/commercial/orders')
      .set(commercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        counterpartyId: counterparty.body.id,
        requestType: 'client_order',
        comment: 'Первичная договорённость',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            plannedWeightKg: 41.2,
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
          },
        ],
      })
      .expect(201);
    const position = order.body.positions[0] as { id: string; version: number };

    await http()
      .patch(`/api/commercial/orders/${order.body.id as string}/comment`)
      .set(commercial)
      .send({ expectedVersion: 1, comment: 'Оплата двумя частями по согласованию' })
      .expect(200);
    await http()
      .patch(`/api/commercial/orders/${order.body.id as string}/positions/${position.id}`)
      .set(commercial)
      .send({ expectedVersion: position.version, plannedWeightKg: 42.125 })
      .expect(200);
    await http()
      .post(`/api/commercial/orders/${order.body.id as string}/invoice-handoff`)
      .set(commercial)
      .send({})
      .expect(201);

    const financeOrders = await http().get('/api/finance/orders').set(finance).expect(200);
    const financeOrder = (
      financeOrders.body as Array<{ id: string; commercialOrder?: { id: string } }>
    ).find((candidate) => candidate.commercialOrder?.id === order.body.id);
    expect(financeOrder).toBeTruthy();
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/invoices`)
      .set(finance)
      .send({ amount: 1_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);

    const financeDetail = await http()
      .get(`/api/finance/orders/${financeOrder!.id}`)
      .set(finance)
      .expect(200);
    expect(financeDetail.body.commercialOrder).toEqual(
      expect.objectContaining({ comment: 'Оплата двумя частями по согласованию' }),
    );
    const initialHistory = await http()
      .get(`/api/finance/orders/${financeOrder!.id}/audit`)
      .set(finance)
      .expect(200);
    expect(initialHistory.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'Комментарий коммерции изменён',
          currentValue: 'Оплата двумя частями по согласованию',
        }),
        expect.objectContaining({
          action: 'Параметры заказа изменены',
          field: 'Плановый вес',
          currentValue: '42.125',
        }),
      ]),
    );

    const receivedAt = new Date('2026-08-11T00:15:00.000Z');
    const measuredAt = new Date('2026-08-11T00:45:00.000Z');
    const bag = await prisma.bigBagUnit.create({
      data: {
        code: `FINANCE-BAG-${suffix}`,
        material: 'ПВД 15803-020',
        supplierName: 'ООО Поставщик',
        batchCode: `BATCH-${suffix}`,
        receivedAt,
        initialKg: 100,
        currentKg: 40,
        lastWarehouseMeasuredKg: 40,
        lastWarehouseMeasuredAt: measuredAt,
        priceKopecksPerKg: 2_500,
        priceSource: 'manual_warehouse',
        priceEffectiveAt: receivedAt,
        status: 'available',
        registrationStatus: 'registered',
        location: 'warehouse',
        createdByRole: 'warehouse',
      },
      select: { id: true },
    });
    const rawMaterials = await http().get('/api/finance/raw-materials').set(finance).expect(200);
    expect(rawMaterials.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bag.id,
          supplier: 'ООО Поставщик',
          receivedAt: receivedAt.toISOString(),
          initialWeightKg: '100.000',
          purchasePricePerKg: '25.00',
          initialValue: '2500.00',
          currentWeightKg: '40.000',
          measuredAt: measuredAt.toISOString(),
          currentValue: '1000.00',
          consumedWeightKg: '60.000',
          consumedValue: '1500.00',
        }),
      ]),
    );

    const beforeUnsupportedPaid = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrder!.id },
      select: {
        paymentStatus: true,
        productionClearedAt: true,
        commercialOrder: {
          select: {
            paymentStatus: true,
            commercialStage: true,
            financeConfirmedAt: true,
            commercialLockedAt: true,
          },
        },
        schedules: {
          select: { id: true, status: true },
          orderBy: { id: 'asc' },
        },
      },
    });
    const beforeUnsupportedPaidEvents = await prisma.domainEvent.count({
      where: {
        OR: [{ objectId: financeOrder!.id }, { objectId: order.body.id as string }],
      },
    });
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
      .set(finance)
      .send({ operationKey: randomUUID(), paymentStatus: 'unpaid', amountPaid: 400 })
      .expect(400);
    const unsupportedPaidKey = randomUUID();
    const unsupportedPaid = await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
      .set(finance)
      .send({ operationKey: unsupportedPaidKey, paymentStatus: 'paid' })
      .expect(409);
    expect(unsupportedPaid.body).toEqual(
      expect.objectContaining({ code: 'FINANCE_PAYMENT_STATUS_FACT_CONFLICT' }),
    );
    await expect(
      prisma.financePaymentUpdateCommand.count({
        where: { financeOrderId: financeOrder!.id, operationKey: unsupportedPaidKey },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.financeOrder.findUniqueOrThrow({
        where: { id: financeOrder!.id },
        select: {
          paymentStatus: true,
          productionClearedAt: true,
          commercialOrder: {
            select: {
              paymentStatus: true,
              commercialStage: true,
              financeConfirmedAt: true,
              commercialLockedAt: true,
            },
          },
          schedules: {
            select: { id: true, status: true },
            orderBy: { id: 'asc' },
          },
        },
      }),
    ).resolves.toEqual(beforeUnsupportedPaid);
    await expect(
      prisma.domainEvent.count({
        where: {
          OR: [{ objectId: financeOrder!.id }, { objectId: order.body.id as string }],
        },
      }),
    ).resolves.toBe(beforeUnsupportedPaidEvents);

    const partialOperationKey = randomUUID();
    const partialOperation = await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-operations`)
      .set(finance)
      .send({ operationKey: partialOperationKey, operationType: 'manual_adjustment', amount: 400 })
      .expect(201);
    expect(partialOperation.body).toEqual(
      expect.objectContaining({
        id: financeOrder!.id,
        paymentSummary: expect.objectContaining({
          paidAmount: '400.00',
          remainingAmount: '600.00',
        }),
      }),
    );
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
      .set(finance)
      .send({ operationKey: partialOperationKey, paymentStatus: 'partial' })
      .expect(201);
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
      .set(finance)
      .send({ operationKey: partialOperationKey, paymentStatus: 'partial' })
      .expect(201);
    const partial = await http()
      .get(`/api/finance/orders/${financeOrder!.id}`)
      .set(finance)
      .expect(200);
    expect(partial.body).toEqual(
      expect.objectContaining({
        paymentStatus: 'partial',
        paymentSummary: expect.objectContaining({
          paidAmount: '400.00',
          remainingAmount: '600.00',
        }),
        businessPayment: expect.objectContaining({
          status: 'partial',
          paidAmount: '400.00',
          remainingAmount: '600.00',
          isOverdue: false,
        }),
      }),
    );

    const partialReplay = await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-operations`)
      .set(finance)
      .send({ operationKey: partialOperationKey, operationType: 'manual_adjustment', amount: 400 })
      .expect(201);
    expect(partialReplay.body).toEqual(
      expect.objectContaining({
        id: financeOrder!.id,
        paymentSummary: expect.objectContaining({ paidAmount: '400.00' }),
      }),
    );
    await expect(
      prisma.paymentOperation.count({ where: { financeOrderId: financeOrder!.id } }),
    ).resolves.toBe(1);

    const serverDerivedKeys = ['unpaid', 'overdue', 'sync_error'].map((paymentStatus) => ({
      operationKey: randomUUID(),
      paymentStatus,
    }));
    const beforeServerDerivedAttempt = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrder!.id },
      select: {
        paymentStatus: true,
        productionClearedAt: true,
        commercialOrder: {
          select: {
            paymentStatus: true,
            commercialStage: true,
            financeConfirmedAt: true,
            commercialLockedAt: true,
          },
        },
        schedules: {
          select: { id: true, status: true, dueDate: true },
          orderBy: { id: 'asc' },
        },
      },
    });
    const eventsBeforeServerDerivedAttempt = await prisma.domainEvent.count({
      where: {
        OR: [{ objectId: financeOrder!.id }, { objectId: order.body.id as string }],
      },
    });
    for (const command of serverDerivedKeys) {
      await http()
        .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
        .set(finance)
        .send(command)
        .expect(400);
    }
    await expect(
      prisma.financePaymentUpdateCommand.count({
        where: { operationKey: { in: serverDerivedKeys.map(({ operationKey }) => operationKey) } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.financeOrder.findUniqueOrThrow({
        where: { id: financeOrder!.id },
        select: {
          paymentStatus: true,
          productionClearedAt: true,
          commercialOrder: {
            select: {
              paymentStatus: true,
              commercialStage: true,
              financeConfirmedAt: true,
              commercialLockedAt: true,
            },
          },
          schedules: {
            select: { id: true, status: true, dueDate: true },
            orderBy: { id: 'asc' },
          },
        },
      }),
    ).resolves.toEqual(beforeServerDerivedAttempt);
    await expect(
      prisma.domainEvent.count({
        where: {
          OR: [{ objectId: financeOrder!.id }, { objectId: order.body.id as string }],
        },
      }),
    ).resolves.toBe(eventsBeforeServerDerivedAttempt);

    // Isolate the business-clock boundary without changing production code or the process clock.
    await prisma.paymentSchedule.updateMany({
      where: { financeOrderId: financeOrder!.id },
      data: { dueDate: new Date(Date.now() - 24 * 60 * 60 * 1_000) },
    });
    const overdueDetail = await http()
      .get(`/api/finance/orders/${financeOrder!.id}`)
      .set(finance)
      .expect(200);
    expect(overdueDetail.body.businessPayment).toEqual(
      expect.objectContaining({
        status: 'overdue',
        isOverdue: true,
        paidAmount: '400.00',
        remainingAmount: '600.00',
        overdueAmount: '600.00',
      }),
    );
    const overdue = await http().get('/api/finance/orders?bucket=overdue').set(finance).expect(200);
    expect(overdue.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: financeOrder!.id,
          businessPayment: expect.objectContaining({ overdueAmount: '600.00' }),
        }),
      ]),
    );

    const finalOperationKey = randomUUID();
    const finalOperation = await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-operations`)
      .set(finance)
      .send({ operationKey: finalOperationKey, operationType: 'manual_adjustment', amount: 600 })
      .expect(201);
    expect(finalOperation.body).toEqual(
      expect.objectContaining({
        id: financeOrder!.id,
        paymentSummary: expect.objectContaining({
          paidAmount: '1000.00',
          remainingAmount: '0.00',
        }),
      }),
    );
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
      .set(finance)
      .send({ operationKey: finalOperationKey, paymentStatus: 'paid' })
      .expect(201);
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-operations`)
      .set(finance)
      .send({ operationKey: finalOperationKey, operationType: 'manual_adjustment', amount: 600 })
      .expect(201);
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/payment-updates`)
      .set(finance)
      .send({ operationKey: finalOperationKey, paymentStatus: 'paid' })
      .expect(201);
    const paid = await http()
      .get(`/api/finance/orders/${financeOrder!.id}`)
      .set(finance)
      .expect(200);
    expect(paid.body).toEqual(
      expect.objectContaining({
        paymentStatus: 'paid',
        paymentSummary: expect.objectContaining({
          paidAmount: '1000.00',
          remainingAmount: '0.00',
        }),
        businessPayment: expect.objectContaining({
          status: 'paid',
          paidAmount: '1000.00',
          remainingAmount: '0.00',
          overdueAmount: '0.00',
          isOverdue: false,
        }),
        schedules: expect.arrayContaining([
          expect.objectContaining({ status: 'paid', remainingAmount: '0.00' }),
        ]),
      }),
    );
    const cleared = await http().get('/api/finance/orders?bucket=overdue').set(finance).expect(200);
    expect(cleared.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: financeOrder!.id })]),
    );
    const operations = await prisma.paymentOperation.findMany({
      where: { financeOrderId: financeOrder!.id },
      select: { operationKey: true, amount: true, paymentAllocationId: true },
      orderBy: [{ amount: 'asc' }, { operationKey: 'asc' }],
    });
    expect(
      operations.map((operation) => ({
        operationKey: operation.operationKey,
        amount: operation.amount.toFixed(2),
        paymentAllocationId: operation.paymentAllocationId,
      })),
    ).toEqual([
      { operationKey: partialOperationKey, amount: '400.00', paymentAllocationId: null },
      { operationKey: finalOperationKey, amount: '600.00', paymentAllocationId: null },
    ]);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: financeOrder!.id, type: 'audit:payment_status_updated' },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: financeOrder!.id, type: 'audit:payment_status_imported' },
      }),
    ).resolves.toBe(2);
    const finalHistory = await http()
      .get(`/api/finance/orders/${financeOrder!.id}/audit`)
      .set(finance)
      .expect(200);
    expect(
      JSON.stringify({
        financeDetail: paid.body,
        rawMaterials: rawMaterials.body,
        history: finalHistory.body,
      }),
    ).not.toMatch(/rawPayload|positionSnapshot|requestFingerprint|sourceSnapshot/u);
  });
});
