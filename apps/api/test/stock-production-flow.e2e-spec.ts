import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RollTokenService } from '../src/common/roll-token/roll-token.service';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('stock production flow (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: RollTokenService;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(RollTokenService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('produces a counterparty-free stock order and exposes the accepted roll as available stock', async () => {
    const http = () => request(app.getHttpServer());
    const password = e2eSeedPassword();
    const [commercialLogin, productionLogin, warehouseLogin] = await Promise.all(
      (['commercial', 'production', 'warehouse'] as const).map((account) =>
        http()
          .post('/api/auth/login')
          .send({ login: e2eSeedLogin(account), password })
          .expect(201),
      ),
    );
    const asCommercial = {
      Authorization: `Bearer ${commercialLogin.body.token as string}`,
    };
    const asProduction = {
      Authorization: `Bearer ${productionLogin.body.token as string}`,
    };
    const asWarehouse = {
      Authorization: `Bearer ${warehouseLogin.body.token as string}`,
    };

    const suffix = randomUUID().slice(0, 8);
    const passwordSource = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const operator = await prisma.user.create({
      data: {
        login: `stock-flow-${suffix}`,
        passwordHash: passwordSource.passwordHash,
        displayName: `Stock flow operator ${suffix}`,
        role: 'operator',
      },
    });
    const operatorLogin = await http()
      .post('/api/auth/login')
      .send({ login: operator.login, password })
      .expect(201);
    const asOperator = {
      Authorization: `Bearer ${operatorLogin.body.token as string}`,
    };
    const post = await prisma.post.create({
      data: {
        code: `STOCK-POST-${suffix}`,
        name: `Stock production post ${suffix}`,
        status: 'active',
      },
    });
    const now = new Date();
    const shift = await prisma.shift.create({
      data: {
        label: `Stock production shift ${suffix}`,
        plannedStartAt: new Date(now.getTime() - 60_000),
        plannedEndAt: new Date(now.getTime() + 60 * 60_000),
        startedAt: now,
        status: 'open',
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: operator.id,
        postId: post.id,
        status: 'locked',
        lockedAt: now,
      },
    });

    const stockOrder = await http()
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        requestType: 'stock_reserve',
        title: `Партия на запас ${suffix}`,
        positions: [
          {
            rollCount: 1,
            filmType: 'Полотно',
            actualThickness: '80 мкм',
            accountingThickness: '80 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            spoolType: '76 мм',
            birka: `Запас ${suffix}`,
            plannedWeightKg: 40,
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
          },
        ],
      })
      .expect(201);

    expect(stockOrder.body).toMatchObject({
      requestType: 'stock_reserve',
      counterparty: null,
      paymentStatus: 'not_applicable',
      shipmentStatus: 'not_applicable',
      stockBatchCode: expect.stringMatching(/^STOCK-S-/u),
    });
    await expect(
      prisma.financeOrder.findUnique({ where: { commercialOrderId: stockOrder.body.id } }),
    ).resolves.toBeNull();

    const production = await http()
      .post(`/api/commercial/orders/${stockOrder.body.id}/send-to-production`)
      .set(asCommercial)
      .send({})
      .expect(201);
    const rollCode = production.body.dispatchItems[0].rollCode as string;

    await http()
      .post(`/api/production/roll-dispatch/${rollCode}/assign`)
      .set(asProduction)
      .send({
        operatorId: operator.id,
      })
      .expect(201);
    await http()
      .post(`/api/production/orders/${production.body.id}/approve`)
      .set(asProduction)
      .expect(201);

    const postSession = await prisma.operatorPostSession.create({
      data: {
        operatorId: operator.id,
        postId: post.id,
        shiftId: shift.id,
        status: 'active',
      },
    });
    const bag = await prisma.bigBagUnit.create({
      data: {
        code: `STOCK-BAG-${suffix}`,
        material: 'ПВД 15803-020',
        status: 'in_use',
        initialKg: 100,
        currentKg: 100,
        lastMeasuredKg: 100,
        lastActorRole: 'operator',
        lastMeasuredAt: now,
        machineId: post.code,
        createdByRole: 'warehouse',
      },
    });
    await prisma.shiftBagUsage.create({
      data: {
        sessionId: postSession.id,
        bigBagId: bag.id,
        startKg: 100,
      },
    });
    const line = await prisma.operatorRollLine.findFirstOrThrow({
      where: { rollDispatchItem: { rollCode } },
      select: { id: true },
    });
    await prisma.operatorRollLine.update({
      where: { id: line.id },
      data: {
        step: 'handover',
        labelState: 'verified',
        warehouseState: 'not_ready',
        spoolKg: 2,
        grossKg: 42,
        netKg: 40,
        toleranceOk: true,
      },
    });
    await prisma.weightCapture.create({
      data: {
        operatorRollLineId: line.id,
        kind: 'roll',
        deviceStatus: 'ready',
        stable: true,
        grossKg: 42,
        spoolKg: 2,
        netKg: 40,
        toleranceOk: true,
        actorRole: 'operator',
        actorId: operator.id,
        postId: post.id,
        postSessionId: postSession.id,
      },
    });

    const handover = await http()
      .post(`/api/operator/rolls/${rollCode}/handover`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const label = await tokens.getOrCreate(rollCode);

    const accepted = await http()
      .post('/api/warehouse/intake/scans')
      .set(asWarehouse)
      .send({ operationKey: randomUUID(), payload: label.token })
      .expect(201);

    expect(accepted.body).toMatchObject({
      taskId: handover.body.id,
      rollCode,
      scanStatus: 'accepted',
      replayed: false,
    });
    const finishedStock = await http()
      .get('/api/warehouse/finished-stock')
      .query({ bucket: 'available', q: rollCode })
      .set(asWarehouse)
      .expect(200);
    expect(finishedStock.body).toMatchObject({
      items: [
        {
          id: expect.any(String),
          rollCode,
          batchCode: stockOrder.body.stockBatchCode,
          weightKg: 40,
          recipe: expect.any(String),
          specification: expect.any(String),
          ageDays: 0,
          processedAt: null,
        },
      ],
      summary: {
        totalCount: 1,
        totalWeightKg: 40,
        pageCount: 1,
        pageWeightKg: 40,
      },
      nextCursor: null,
    });
    expect(Object.keys(finishedStock.body.items[0]).sort()).toEqual(
      [
        'id',
        'rollCode',
        'batchCode',
        'weightKg',
        'recipe',
        'specification',
        'ageDays',
        'processedAt',
      ].sort(),
    );
    expect(JSON.stringify(finishedStock.body.items[0])).not.toMatch(
      /sourceOrder|availability|reservedFor|receivedAt/iu,
    );
    expect(finishedStock.body.items[0].recipe).toContain('Первичное');
    expect(finishedStock.body.items[0].specification).toContain('полотно');

    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode },
        select: {
          warehouseStatus: true,
          ownerCounterpartyId: true,
          producedForStockOrderId: true,
          reservedForOrderId: true,
          currentCoverageFactId: true,
          receivedAt: true,
        },
      }),
    ).resolves.toEqual({
      warehouseStatus: 'received',
      ownerCounterpartyId: null,
      producedForStockOrderId: stockOrder.body.id,
      reservedForOrderId: null,
      currentCoverageFactId: expect.any(String),
      receivedAt: expect.any(Date),
    });
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:finished_stock_created',
          detail: { path: ['sourceStockOrderId'], equals: stockOrder.body.id },
        },
      }),
    ).resolves.toBe(1);
  });
});
