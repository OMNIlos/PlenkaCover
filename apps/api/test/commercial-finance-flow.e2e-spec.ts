import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';

describe('Commercial finance flow (e2e)', () => {
  let app: INestApplication;
  const asCommercial = { 'x-role': 'commercial' };
  const asFinance = { 'x-role': 'finance' };
  const asProduction = { 'x-role': 'production_lead' };
  const uniq = Date.now();

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'on';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps a confirmed prepayment order incoming until production handoff', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `Draft Buyer ${uniq}` })
      .expect(201);

    const draft = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'draft',
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
          },
        ],
      })
      .expect(201);

    expect(draft.body.commercialStage).toBe('draft');
    expect(draft.body.orderNumber).toMatch(/^D-/);
    const positionId = draft.body.positions[0].id as string;

    const draftOrder = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${draft.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(draftOrder.body.financeSummary).toBeNull();

    const financeOrdersBefore = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    expect(
      financeOrdersBefore.body.some(
        (o: { commercialOrder?: { id: string } }) => o.commercialOrder?.id === draft.body.id,
      ),
    ).toBe(false);

    const productionOrdersBefore = await request(app.getHttpServer())
      .get('/api/production/orders')
      .set(asProduction)
      .expect(200);
    expect(
      productionOrdersBefore.body.some(
        (o: { commercialOrder?: { id: string } }) => o.commercialOrder?.id === draft.body.id,
      ),
    ).toBe(false);

    await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${draft.body.id}/positions/${positionId}`)
      .set(asCommercial)
      .send({ expectedVersion: 1, rollCount: 2 })
      .expect(200);

    const updatedDraft = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${draft.body.id}`)
      .set(asCommercial)
      .expect(200);
    const updatedPosition = updatedDraft.body.positions.find(
      (position: { id: string }) => position.id === positionId,
    );
    expect(updatedPosition.rollCount).toBe(2);
    expect(updatedPosition.warehouseCoverStatus).toBe('not_checked');

    const promoted = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${draft.body.id}/promote-draft`)
      .set(asCommercial)
      .send({})
      .expect(201);
    expect(promoted.body.commercialStage).toBe('incoming');
    expect(promoted.body.orderNumber).toMatch(/^A-/);

    const sent = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${draft.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 100000, note: 'Счёт по черновику' })
      .expect(201);
    expect(sent.body.commercialStage).toBe('sent_to_finance');
    expect(sent.body.orderNumber).toBe(promoted.body.orderNumber);

    const incoming = await request(app.getHttpServer())
      .get('/api/commercial/orders?bucket=incoming')
      .set(asCommercial)
      .expect(200);
    expect(incoming.body.items.some((o: { id: string }) => o.id === draft.body.id)).toBe(true);

    const financeOrders = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    const financeOrder = financeOrders.body.find(
      (o: { commercialOrder?: { id: string } }) => o.commercialOrder?.id === draft.body.id,
    );
    expect(financeOrder).toBeTruthy();

    const invoiced = await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 100000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const prepayment = invoiced.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'invoice_prepayment',
    );
    expect(prepayment).toEqual(expect.objectContaining({ amount: 50000, status: 'unpaid' }));
    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/payment-schedules/${prepayment.id}/confirm`)
      .set(asFinance)
      .send({})
      .expect(201);

    const afterIncoming = await request(app.getHttpServer())
      .get('/api/commercial/orders?bucket=incoming')
      .set(asCommercial)
      .expect(200);
    expect(afterIncoming.body.items.some((o: { id: string }) => o.id === draft.body.id)).toBe(true);

    const preProduction = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${draft.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(preProduction.body.bucket).toBe('incoming');
    expect(preProduction.body.indicators.payment).toBe('partial');
    expect(preProduction.body.edit.parametersAllowed).toBe(false);

    const conflict = await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${draft.body.id}/positions/${positionId}`)
      .set(asCommercial)
      .send({ expectedVersion: 2, rollCount: 3 })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE',
      message: 'Параметры заказа закрыты после выставления счёта.',
    });
  });
});
