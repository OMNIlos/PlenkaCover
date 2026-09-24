import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';

/**
 * DB-backed proof that commercial writes behave like prod on real data:
 * POST persists to Postgres and the value comes back on a fresh GET.
 * Requires Postgres up + migrated: `npm run db:up && npm run db:migrate`.
 * Uses the dev x-role mock actor (AUTH_DEV_XROLE=on) to act as commercial.
 */
describe('Commercial write (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const asCommercial = { 'x-role': 'commercial' };
  const asProductionLead = { 'x-role': 'production_lead' };
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
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a counterparty and lists it back', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Контрагент ${uniq}`, inn: String(uniq) })
      .expect(201);
    expect(create.body.id).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get('/api/commercial/counterparties')
      .set(asCommercial)
      .expect(200);
    expect(list.body.some((c: { id: string }) => c.id === create.body.id)).toBe(true);
  });

  it('creates one counterparty and one audit under a concurrent normalized-INN race', async () => {
    const canonicalInn = `R${String(uniq).slice(-10)}X`;
    const splitAt = 5;
    const spacedLowercaseInn =
      ` ${canonicalInn.slice(0, splitAt).toLowerCase()} ` +
      `${canonicalInn.slice(splitAt).toLowerCase()} `;
    const body = { displayName: `E2E INN race ${uniq}` };

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/commercial/counterparties')
        .set(asCommercial)
        .send({ ...body, inn: spacedLowercaseInn }),
      request(app.getHttpServer())
        .post('/api/commercial/counterparties')
        .set(asCommercial)
        .send({ ...body, inn: canonicalInn }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[0]?.body.id).toBe(responses[1]?.body.id);
    expect(responses.map(({ body: responseBody }) => responseBody.inn)).toEqual([
      canonicalInn,
      canonicalInn,
    ]);

    const counterpartyId = responses[0]?.body.id as string;
    const [counterparties, createFacts] = await Promise.all([
      prisma.counterparty.count({ where: { inn: canonicalInn } }),
      prisma.domainEvent.count({
        where: {
          objectId: counterpartyId,
          type: 'audit:commercial_counterparty_created',
        },
      }),
    ]);
    expect(counterparties).toBe(1);
    expect(createFacts).toBe(1);
  });

  it('persists a new order (server-generated number) and returns it on GET', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Заказчик ${uniq}` })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 2,
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
    expect(created.body.orderNumber).toMatch(/^A-/);

    const orders = await request(app.getHttpServer())
      .get('/api/commercial/orders')
      .set(asCommercial)
      .expect(200);
    expect(
      orders.body.items.some(
        (o: { orderNumber: string }) => o.orderNumber === created.body.orderNumber,
      ),
    ).toBe(true);
  });

  it('saves one reusable multi-position template from checked commercial intake', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Шаблон Заказчик ${uniq}` })
      .expect(201);
    const clientRequestId = randomUUID();
    const body = {
      clientRequestId,
      counterpartyId: cp.body.id,
      requestType: 'client_order',
      saveAsTemplate: true,
      positions: [
        {
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          ...PRIMARY_BASE_MATERIAL_SELECTION,
          ...STANDARD_ROLL_DIMENSIONS,
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
        },
        {
          rollCount: 4,
          filmType: 'Полотно',
          actualThickness: '60 мкм',
          accountingThickness: '58 мкм',
          ...PRIMARY_BASE_MATERIAL_SELECTION,
          widthMm: 1400,
          plannedLengthM: 350,
          plannedWeightKg: 34.5,
          spoolType: 'Толстая',
          birka: 'i',
          manualBirka: 'Маркировка клиента',
          comment: 'Не объединять с первой позицией',
          recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
        },
      ],
    };

    const first = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    const templates = await request(app.getHttpServer())
      .get(`/api/commercial/counterparties/${cp.body.id}/templates`)
      .set(asProductionLead)
      .expect(200);
    const saved = templates.body.find(
      (template: { name: string }) => template.name === `Заявка ${first.body.orderNumber}`,
    );
    expect(saved).toMatchObject({
      counterpartyId: cp.body.id,
      ownerRole: 'production_lead',
      status: 'active',
      version: 1,
      positions: [
        expect.objectContaining({
          rollCount: 2,
          filmType: 'Рукав',
          spoolType: 'Тонкая',
        }),
        expect.objectContaining({
          rollCount: 4,
          filmType: 'Полотно',
          plannedWeightKg: 34.5,
          spoolType: 'Толстая',
          manualBirka: 'Маркировка клиента',
          comment: 'Не объединять с первой позицией',
        }),
      ],
      versions: [expect.objectContaining({ version: 1 })],
    });

    const recreated = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        templateId: saved.id,
      })
      .expect(201);
    expect(recreated.body.positions).toEqual([
      expect.objectContaining({
        rollCount: 2,
        filmType: 'Рукав',
        spoolType: 'Тонкая',
      }),
      expect.objectContaining({
        rollCount: 4,
        filmType: 'Полотно',
        plannedWeightKg: 34.5,
        spoolType: 'Толстая',
        manualBirka: 'Маркировка клиента',
        comment: 'Не объединять с первой позицией',
      }),
    ]);

    await expect(
      prisma.counterpartyOrderTemplate.count({
        where: { counterpartyId: cp.body.id, name: `Заявка ${first.body.orderNumber}` },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: saved.id, type: 'audit:counterparty_template_created' },
      }),
    ).resolves.toBe(1);
  });

  it('rolls back order creation when checked template values are outside the bounded catalog', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Invalid template value ${uniq}` })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        saveAsTemplate: true,
        positions: [
          {
            rollCount: 1,
            filmType: 'Пятый тип',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            spoolType: 'Тонкая',
            birka: 'ГОСТ',
          },
        ],
      })
      .expect(400);
    expect(response.body.code).toBe('INVALID_COUNTERPARTY_TEMPLATE_POSITION');
    await expect(
      prisma.commercialOrder.count({ where: { counterpartyId: cp.body.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.counterpartyOrderTemplate.count({ where: { counterpartyId: cp.body.id } }),
    ).resolves.toBe(0);
  });

  it('validates manual template material selectors and returns its immutable version id', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Manual template ${uniq}` })
      .expect(201);
    const position = {
      rollCount: 2,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      ...STANDARD_ROLL_DIMENSIONS,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
    };

    const unavailable = await request(app.getHttpServer())
      .post(`/api/commercial/counterparties/${cp.body.id}/templates`)
      .set(asProductionLead)
      .send({
        name: 'Недоступное сырьё',
        positions: [{ ...position, baseRawMaterialDefinitionId: randomUUID() }],
      })
      .expect(409);
    expect(unavailable.body.code).toBe('RAW_MATERIAL_DEFINITION_UNAVAILABLE');

    const created = await request(app.getHttpServer())
      .post(`/api/commercial/counterparties/${cp.body.id}/templates`)
      .set(asProductionLead)
      .send({
        name: 'Проверенный шаблон',
        positions: [{ ...position, ...PRIMARY_BASE_MATERIAL_SELECTION }],
      })
      .expect(201);
    expect(created.body.versions).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        templateId: created.body.id,
        version: 1,
      }),
    ]);
    expect(created.body.positions[0].recipeParameters).toContainEqual({
      label: 'Сырьё',
      value: expect.any(String),
    });
    await expect(
      prisma.counterpartyOrderTemplate.count({ where: { counterpartyId: cp.body.id } }),
    ).resolves.toBe(1);
  });

  it('creates, reads, edits, clears, validates, and audits an order comment', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Comment Заказчик ${uniq}` })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        comment: '  Позвонить клиенту  ',
        positions: [
          {
            rollCount: 2,
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

    const detail = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${created.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(detail.body).toMatchObject({
      comment: 'Позвонить клиенту',
      commentVersion: 1,
    });

    const initial = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { version: true },
    });

    await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${created.body.id}/comment`)
      .set(asCommercial)
      .send({ expectedVersion: 1, comment: 'Новая договорённость' })
      .expect(200)
      .expect({ comment: 'Новая договорённость', commentVersion: 2 });

    const afterEdit = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { version: true },
    });
    expect(afterEdit.version).toBe(initial.version);

    await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${created.body.id}/comment`)
      .set(asCommercial)
      .send({ expectedVersion: 1, comment: 'Устаревшая правка' })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${created.body.id}/comment`)
      .set(asCommercial)
      .send({ expectedVersion: 2, comment: 'x'.repeat(1001) })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${created.body.id}/comment`)
      .set(asCommercial)
      .send({ expectedVersion: 2, comment: '   ' })
      .expect(200)
      .expect({ comment: null, commentVersion: 3 });

    const afterClear = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { version: true },
    });
    expect(afterClear.version).toBe(initial.version);

    const position = detail.body.positions[0] as { id: string; version: number };
    await request(app.getHttpServer())
      .patch(`/api/commercial/orders/${created.body.id}/positions/${position.id}`)
      .set(asCommercial)
      .send({ expectedVersion: position.version, comment: '  Доставить до 12:00  ' })
      .expect(200);

    const updatedDetail = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${created.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(updatedDetail.body.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: position.id, comment: 'Доставить до 12:00' }),
      ]),
    );

    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:commercial_order_comment_updated',
          objectId: created.body.id,
        },
      }),
    ).resolves.toBe(2);
  });

  it('rejects an order for a non-existent counterparty (404)', async () => {
    await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: 'does-not-exist',
        requestType: 'client_order',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '78',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            recipeParameters: [],
          },
        ],
      })
      .expect(404);
  });

  it('replays only an identical create-order request', async () => {
    const cp = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `E2E Replay Заказчик ${uniq}` })
      .expect(201);
    const clientRequestId = randomUUID();
    const body = {
      clientRequestId,
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
    };

    const first = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send(body)
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: first.body.id,
          type: 'audit:commercial_recipe_snapshot_set',
        },
      }),
    ).resolves.toBe(1);

    const conflict = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({ ...body, title: 'Другой заказ' })
      .expect(409);
    expect(conflict.body.code).toBe('COMMERCIAL_REQUEST_ID_CONFLICT');
  });
});
