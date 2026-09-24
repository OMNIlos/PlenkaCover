import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  approveProductionOnlyCover,
  PRIMARY_BASE_MATERIAL_SELECTION,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Headers = Record<string, string>;

describe('Safe action cancellations (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let savedAuthDevXRole: string | undefined;

  const http = () => request(app.getHttpServer());

  async function bearerFor(account: Parameters<typeof e2eSeedLogin>[0]): Promise<Headers> {
    const response = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin(account), password: e2eSeedPassword() })
      .expect(201);
    return { Authorization: `Bearer ${response.body.token as string}` };
  }

  beforeAll(async () => {
    savedAuthDevXRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    // App configuration is evaluated during import; the test must exercise real identity.
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
  });

  afterAll(async () => {
    await app?.close();
    if (savedAuthDevXRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = savedAuthDevXRole;
  });

  it('locks paid dimensions, cancels only untouched work, and preserves production clearance', async () => {
    const suffix = randomUUID().slice(0, 8);
    const [asCommercial, asProduction, asFinance, asOperator, asWarehouse, asDirector] =
      await Promise.all([
        bearerFor('commercial'),
        bearerFor('production'),
        bearerFor('finance'),
        bearerFor('operator'),
        bearerFor('warehouse'),
        bearerFor('director'),
      ]);
    const seededOperator = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const operator = await prisma.user.create({
      data: {
        externalId: `e2e:action-cancellations:${suffix}`,
        login: `action-cancellations-${suffix}`,
        passwordHash: seededOperator.passwordHash,
        displayName: `Action cancellations ${suffix}`,
        role: 'operator',
      },
    });

    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `Cancellation E2E ${suffix}` })
      .expect(201);
    const created = await http()
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        counterpartyId: counterparty.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 2,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            widthMm: 1700,
            plannedLengthM: 500,
            recipeParameters: [
              { label: 'План. вес, кг', value: '41.2' },
              { label: 'Метраж, м', value: '500' },
            ],
          },
        ],
      })
      .expect(201);
    await approveProductionOnlyCover(app, prisma, asCommercial, created.body);

    await http()
      .post(`/api/commercial/orders/${created.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 100_000, note: 'Safe cancellation E2E' })
      .expect(201);
    const financeOrders = await http().get('/api/finance/orders').set(asFinance).expect(200);
    const financeOrder = financeOrders.body.find(
      (candidate: { commercialOrder?: { id: string } }) =>
        candidate.commercialOrder?.id === created.body.id,
    );
    expect(financeOrder).toBeTruthy();
    const invoiced = await http()
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 100_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const prepayment = invoiced.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'invoice_prepayment',
    );
    expect(prepayment).toBeTruthy();
    await http()
      .post(
        `/api/finance/orders/${financeOrder.id}/payment-schedules/${prepayment.id}/confirm`,
      )
      .set(asFinance)
      .send({ operationKey: randomUUID() })
      .expect(201);

    const paidOrder = await http()
      .get(`/api/commercial/orders/${created.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(paidOrder.body.nextAction).toEqual(
      expect.objectContaining({ code: 'send_to_production', allowed: true }),
    );
    const amendmentBody = {
      kind: 'update_position',
      operationKey: randomUUID(),
      expectedOrderVersion: paidOrder.body.version,
      expectedPositionVersion: paidOrder.body.positions[0].version,
      reason: 'Клиент уточнил ширину и метраж после счёта',
      positionId: paidOrder.body.positions[0].id,
      changes: { widthMm: 1800, plannedLengthM: 600 },
    };
    await http()
      .post(`/api/commercial/orders/${created.body.id}/amendments`)
      .set(asCommercial)
      .send(amendmentBody)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE');
      });

    const productionOrder = await http()
      .post(`/api/commercial/orders/${created.body.id}/send-to-production`)
      .set(asCommercial)
      .expect(201);
    expect(productionOrder.body.dispatchItems).toHaveLength(2);
    expect(productionOrder.body.dispatchItems[0]).toEqual(
      expect.objectContaining({ widthMm: 1700, plannedLengthM: 500 }),
    );

    const shift = await prisma.shift.create({
      data: {
        label: `Cancellation E2E ${suffix}`,
        plannedStartAt: new Date(Date.now() + 60 * 60 * 1000),
        plannedEndAt: new Date(Date.now() + 9 * 60 * 60 * 1000),
      },
    });
    const [postA, postB, postC] = await Promise.all(
      ['A', 'B', 'C'].map((label) =>
        prisma.post.create({
          data: {
            code: `CANCEL-${label}-${suffix}`,
            name: `Cancellation ${label} ${suffix}`,
            status: 'active',
          },
        }),
      ),
    );
    const firstAssignment = await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: operator.id,
        postId: postA.id,
        status: 'planned',
      },
    });
    const firstDispatch = productionOrder.body.dispatchItems[0] as { id: string };
    await prisma.rollDispatchItem.update({
      where: { id: firstDispatch.id },
      data: {
        assignedOperatorId: operator.id,
        plannedShiftId: shift.id,
        postId: postA.id,
        machineId: postA.code,
        workplaceId: postA.id,
        status: 'assigned',
      },
    });

    const assignmentCancellationBody = {
      operationKey: randomUUID(),
      reason: 'Ошибочно назначили не тот станок',
    };
    for (const forbidden of [asCommercial, asFinance, asOperator, asWarehouse, asDirector]) {
      await http()
        .post(
          `/api/production/shifts/${shift.id}/assignments/${firstAssignment.id}/cancel`,
        )
        .set(forbidden)
        .send(assignmentCancellationBody)
        .expect(403);
    }
    const cancelledAssignment = await http()
      .post(`/api/production/shifts/${shift.id}/assignments/${firstAssignment.id}/cancel`)
      .set(asProduction)
      .send(assignmentCancellationBody)
      .expect(201);
    const assignmentReplay = await http()
      .post(`/api/production/shifts/${shift.id}/assignments/${firstAssignment.id}/cancel`)
      .set(asProduction)
      .send(assignmentCancellationBody)
      .expect(201);
    expect(assignmentReplay.body).toEqual(cancelledAssignment.body);
    expect(cancelledAssignment.body).toEqual(
      expect.objectContaining({
        assignmentId: firstAssignment.id,
        status: 'cancelled',
        releasedDispatchItemIds: [firstDispatch.id],
        shiftClosed: false,
      }),
    );
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: firstDispatch.id } }),
    ).resolves.toEqual(
      expect.objectContaining({
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        status: 'new',
      }),
    );

    const replacementAssignment = await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: operator.id,
        postId: postB.id,
        status: 'planned',
      },
    });
    await prisma.rollDispatchItem.update({
      where: { id: firstDispatch.id },
      data: {
        assignedOperatorId: operator.id,
        plannedShiftId: shift.id,
        postId: postB.id,
        machineId: postB.code,
        workplaceId: postB.id,
        status: 'assigned',
      },
    });
    await prisma.operatorPostSession.create({
      data: {
        operatorId: operator.id,
        postId: postB.id,
        shiftId: shift.id,
        status: 'active',
      },
    });
    await http()
      .post(
        `/api/production/shifts/${shift.id}/assignments/${replacementAssignment.id}/cancel`,
      )
      .set(asProduction)
      .send({ operationKey: randomUUID(), reason: 'Попытка отменить начатую работу' })
      .expect(409);

    const machineChange = await prisma.operatorMachineChange.create({
      data: {
        assignmentId: replacementAssignment.id,
        shiftId: shift.id,
        operatorId: operator.id,
        fromPostId: postB.id,
        toPostId: postC.id,
        reason: 'Ошибочно выбран целевой станок',
        status: 'requested',
        operationKey: randomUUID(),
      },
    });
    const machineChangeCancellationBody = {
      operationKey: randomUUID(),
      reason: 'Перенос больше не требуется',
    };
    const cancelledChange = await http()
      .post(`/api/production/machine-changes/${machineChange.id}/cancel`)
      .set(asProduction)
      .send(machineChangeCancellationBody)
      .expect(201);
    const cancelledChangeReplay = await http()
      .post(`/api/production/machine-changes/${machineChange.id}/cancel`)
      .set(asProduction)
      .send(machineChangeCancellationBody)
      .expect(201);
    expect(cancelledChangeReplay.body).toEqual(cancelledChange.body);
    expect(cancelledChange.body).toEqual(
      expect.objectContaining({ changeId: machineChange.id, status: 'cancelled' }),
    );
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: replacementAssignment.id },
      }),
    ).resolves.toEqual(expect.objectContaining({ postId: postB.id, status: 'planned' }));

    const financeBeforeCorrection = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrder.id },
      select: { paymentStatus: true, productionClearedAt: true },
    });
    expect(financeBeforeCorrection.productionClearedAt).not.toBeNull();
    const correctionBody = {
      operationKey: randomUUID(),
      target: { kind: 'schedule_confirmation', id: prepayment.id },
      expectedPaymentStatus: financeBeforeCorrection.paymentStatus,
      reason: 'Оплата была отмечена по ошибке',
    };
    const corrected = await http()
      .post(`/api/finance/orders/${financeOrder.id}/payment-corrections`)
      .set(asFinance)
      .send(correctionBody)
      .expect(201);
    const correctionReplay = await http()
      .post(`/api/finance/orders/${financeOrder.id}/payment-corrections`)
      .set(asFinance)
      .send(correctionBody)
      .expect(201);
    expect(correctionReplay.body).toEqual(corrected.body);
    expect(corrected.body.productionClearedAt).toBe(
      financeBeforeCorrection.productionClearedAt?.toISOString(),
    );
    const financeAfterCorrection = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrder.id },
      select: { invoiceStatus: true, productionClearedAt: true },
    });
    expect(financeAfterCorrection).toEqual({
      invoiceStatus: 'invoiced',
      productionClearedAt: financeBeforeCorrection.productionClearedAt,
    });

    const operatorNotification = await prisma.domainEvent.findFirstOrThrow({
      where: {
        type: 'notification:operator_machine_change_cancelled',
        objectId: replacementAssignment.id,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const operatorPayload = JSON.stringify(operatorNotification.detail);
    expect(operatorPayload).not.toContain(counterparty.body.displayName);
    expect(operatorPayload).not.toMatch(/counterparty|client|rawPayload|payload|token/iu);
  });
});
