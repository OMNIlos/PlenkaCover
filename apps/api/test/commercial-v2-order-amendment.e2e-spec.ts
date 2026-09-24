import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { PRIMARY_BASE_MATERIAL_SELECTION } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Headers = Record<string, string>;

describe('Commercial V2 order amendments (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let asCommercial: Headers;
  let asFinance: Headers;
  let previousAuthDevXRole: string | undefined;
  let previousCoverageFlag: string | undefined;

  const http = () => request(app.getHttpServer());

  async function bearerFor(account: Parameters<typeof e2eSeedLogin>[0]): Promise<Headers> {
    const response = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin(account), password: e2eSeedPassword() })
      .expect(201);
    return { Authorization: `Bearer ${response.body.token as string}` };
  }

  async function createVerifiedCoverageRoll(
    orderId: string,
    positionId: string,
    counterpartyId: string,
    suffix: string,
  ): Promise<string> {
    const position = await prisma.commercialOrderPosition.findUniqueOrThrow({
      where: { id: positionId },
      include: { recipe: true },
    });
    const rollId = `v2-amendment-roll-${suffix}`;
    const factId = `v2-amendment-fact-${suffix}`;
    const rollCode = `V2-AMENDMENT-ROLL-${suffix}`;
    const ingredients = [
      {
        rawMaterialDefinitionId: position.baseRawMaterialDefinitionId!,
        shareBasisPoints: 10_000,
      },
    ];
    const spec = canonicalizeRollCoverageSpec({
      rollCode,
      sourceOrderId: orderId,
      sourcePositionId: positionId,
      ownerCounterpartyId: counterpartyId,
      filmType: position.filmType,
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_500_000,
      plannedLengthMilliM: 300_000,
      birka: position.birka,
      spoolType: position.spoolType,
      actualWeightMilliKg: 50_000,
      plannedWeightMilliKg: 50_000,
      ingredients,
      recipeId: position.recipe!.id,
      recipeVersion: position.recipe!.version,
      recipeDefinitionId: position.recipe!.recipeDefinitionId,
      recipeDefinitionVersionId: position.recipe!.recipeDefinitionVersionId,
      recipeVersionNumber: position.recipe!.recipeVersionNumber,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
    await prisma.$transaction(async (tx) => {
      await tx.warehouseRoll.create({
        data: {
          id: rollId,
          rollCode,
          ownerCounterpartyId: counterpartyId,
          warehouseStatus: 'received',
        },
      });
      await tx.warehouseRollCoverageFact.create({
        data: {
          id: factId,
          rollId,
          version: 1,
          source: 'migration_backfill',
          specVersion: 'warehouse-roll-coverage/v1',
          specFingerprint: fingerprintRollFact(spec),
          spec: spec as unknown as Prisma.InputJsonValue,
          sourceOrderId: orderId,
          sourcePositionId: positionId,
          actorKind: 'system',
          systemActorKey: 'warehouse_coverage_engine',
        },
      });
      await tx.warehouseRoll.update({
        where: { id: rollId },
        data: { currentCoverageFactId: factId },
      });
    });
    return rollId;
  }

  beforeAll(async () => {
    try {
      previousAuthDevXRole = process.env.AUTH_DEV_XROLE;
      previousCoverageFlag = process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
      process.env.AUTH_DEV_XROLE = 'off';
      process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'true';

      // Configuration is evaluated while AppModule is imported.
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
      [asCommercial, asFinance] = await Promise.all([
        bearerFor('commercial'),
        bearerFor('finance'),
      ]);
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
          : JSON.stringify(error);
      throw new Error(`Commercial V2 amendment e2e setup failed: ${detail}`);
    }
  });

  afterAll(async () => {
    await app?.close();
    if (previousAuthDevXRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousAuthDevXRole;
    if (previousCoverageFlag === undefined) delete process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
    else process.env.WAREHOUSE_COVERAGE_V2_ENABLED = previousCoverageFlag;
  });

  it('keeps the production handoff action in list and detail when auto coverage becomes stale', async () => {
    const suffix = randomUUID().slice(0, 8);
    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `V2 stale production action ${suffix}` })
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
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            widthMm: 1500,
            plannedLengthM: 300,
            spoolType: '76 мм',
            birka: `V2-STALE-${suffix}`,
            plannedWeightKg: 50,
          },
        ],
      })
      .expect(201);

    await http()
      .post(`/api/commercial/orders/${created.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({})
      .expect(201);
    const financeOrders = await http().get('/api/finance/orders').set(asFinance).expect(200);
    const financeOrder = financeOrders.body.find(
      (candidate: { commercialOrder?: { id: string } }) =>
        candidate.commercialOrder?.id === created.body.id,
    );
    expect(financeOrder).toBeTruthy();
    await http()
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 125_000, paymentTermsType: 'postpay_100_30d' })
      .expect(201);

    const coverage = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: created.body.id },
      include: { currentCalculation: true, currentDecision: true },
    });
    expect(coverage).toMatchObject({
      state: 'production_required',
      currentDecision: { kind: 'auto_produce_all' },
    });
    await createVerifiedCoverageRoll(
      created.body.id,
      created.body.positions[0].id,
      counterparty.body.id,
      `stale-action-${suffix}`,
    );
    const inventoryEpoch = await prisma.warehouseCoverageInventoryEpoch.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(inventoryEpoch.epoch).toBeGreaterThan(coverage.currentCalculation!.inventoryEpoch);

    const expectedAction = {
      code: 'send_to_production',
      ownerRole: 'commercial',
      allowed: true,
    };
    const detail = await http()
      .get(`/api/commercial/orders/${created.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        productionOrderId: null,
        warehouseCoverage: expect.objectContaining({
          state: 'stale',
          reasonCodes: expect.arrayContaining(['inventory_changed']),
        }),
        nextAction: expect.objectContaining(expectedAction),
      }),
    );

    const page = await http()
      .get('/api/commercial/orders?bucket=incoming&mode=current&limit=100')
      .set(asCommercial)
      .expect(200);
    expect(page.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.id,
          warehouseCoverage: expect.objectContaining({ state: 'stale' }),
          nextAction: expect.objectContaining(expectedAction),
        }),
      ]),
    );
  });

  it('amends equal-epoch automatic production coverage, refreshes it, and keeps invoice lock', async () => {
    const suffix = randomUUID().slice(0, 8);
    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `V2 amendment ${suffix}` })
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
            widthMm: 1500,
            plannedLengthM: 300,
            spoolType: '76 мм',
            birka: `V2-${suffix}`,
            plannedWeightKg: 50,
            comment: '',
          },
        ],
      })
      .expect(201);

    await http()
      .post(`/api/commercial/orders/${created.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 125_000, note: `V2 amendment ${suffix}` })
      .expect(201);

    const financeOrders = await http().get('/api/finance/orders').set(asFinance).expect(200);
    const financeOrder = financeOrders.body.find(
      (candidate: { commercialOrder?: { id: string } }) =>
        candidate.commercialOrder?.id === created.body.id,
    );
    expect(financeOrder).toBeTruthy();

    const before = await http()
      .get(`/api/commercial/orders/${created.body.id}`)
      .set(asCommercial)
      .expect(200);
    const position = before.body.positions[0];
    const [coverageBefore, epochBefore] = await Promise.all([
      prisma.warehouseCoverageState.findUniqueOrThrow({
        where: { orderId: created.body.id },
        include: { currentCalculation: true, currentDecision: true },
      }),
      prisma.warehouseCoverageInventoryEpoch.findUniqueOrThrow({ where: { id: 1 } }),
    ]);
    expect(coverageBefore).toMatchObject({
      state: 'production_required',
      stateVersion: 2,
      generation: 1,
      currentCalculation: { availability: 'unavailable' },
      currentDecision: { kind: 'auto_produce_all' },
    });
    expect(coverageBefore.currentCalculation?.inventoryEpoch).toBe(epochBefore.epoch);

    const notificationCountBefore = await prisma.domainEvent.count({
      where: {
        objectId: created.body.id,
        type: 'notification:commercial_order_amended',
      },
    });
    await http()
      .post(`/api/commercial/orders/${created.body.id}/amendments`)
      .set(asCommercial)
      .send({
        kind: 'update_position',
        operationKey: randomUUID(),
        expectedOrderVersion: before.body.version,
        expectedPositionVersion: position.version,
        reason: 'Клиент уточнил ширину до выставления счёта',
        positionId: position.id,
        changes: { widthMm: 1600, comment: '' },
      })
      .expect(201);

    const [coverageAfterAmendment, epochAfterAmendment, oldCalculation, oldDecision] =
      await Promise.all([
        prisma.warehouseCoverageState.findUniqueOrThrow({
          where: { orderId: created.body.id },
        }),
        prisma.warehouseCoverageInventoryEpoch.findUniqueOrThrow({ where: { id: 1 } }),
        prisma.warehouseCoverageCalculation.findUniqueOrThrow({
          where: { id: coverageBefore.currentCalculationId! },
        }),
        prisma.warehouseCoverageDecision.findUniqueOrThrow({
          where: { id: coverageBefore.currentDecisionId! },
        }),
      ]);
    expect(coverageAfterAmendment).toMatchObject({
      state: 'order_spec_changed',
      stateVersion: 3,
      generation: 1,
      currentCalculationId: coverageBefore.currentCalculationId,
      currentDecisionId: null,
    });
    expect(epochAfterAmendment.epoch).toBe(epochBefore.epoch);
    expect(oldCalculation).toMatchObject({
      id: coverageBefore.currentCalculationId,
      generation: 1,
      availability: 'unavailable',
      inventoryEpoch: epochBefore.epoch,
    });
    expect(oldDecision).toMatchObject({
      id: coverageBefore.currentDecisionId,
      calculationId: coverageBefore.currentCalculationId,
      kind: 'auto_produce_all',
    });

    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: created.body.id,
          type: 'notification:commercial_order_amended',
        },
      }),
    ).resolves.toBe(notificationCountBefore + 1);
    const invalidationEvents = await prisma.domainEvent.findMany({
      where: {
        objectId: created.body.id,
        type: 'audit:warehouse_coverage_order_spec_invalidated',
      },
    });
    expect(invalidationEvents).toHaveLength(1);
    expect(invalidationEvents[0]?.detail).toMatchObject({
      calculationId: coverageBefore.currentCalculationId,
      decisionId: coverageBefore.currentDecisionId,
      previousState: 'production_required',
      nextState: 'order_spec_changed',
      decisionPreserved: false,
      physicalFactsPreserved: false,
      productionOrderPreserved: false,
    });
    const amendmentNotification = await prisma.domainEvent.findFirstOrThrow({
      where: {
        objectId: created.body.id,
        type: 'notification:commercial_order_amended',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(amendmentNotification.detail).toMatchObject({
      changedFields: ['widthMm'],
      recipientRoles: expect.arrayContaining(['finance']),
    });
    const financeInbox = await http()
      .get('/api/finance/notifications?limit=100')
      .set(asFinance)
      .expect(200);
    expect(
      financeInbox.body.items.filter(
        (item: { eventType: string; orderId: string | null }) =>
          item.eventType === 'notification:commercial_order_amended' &&
          item.orderId === created.body.id,
      ),
    ).toHaveLength(1);

    const refreshed = await http()
      .post(`/api/finance/orders/${financeOrder.id}/warehouse-coverage/refresh`)
      .set(asFinance)
      .send({
        clientRequestId: randomUUID(),
        expectedGeneration: coverageAfterAmendment.generation,
        expectedStateVersion: coverageAfterAmendment.stateVersion,
      })
      .expect(200);
    expect(refreshed.body).toMatchObject({
      state: 'production_required',
      generation: 2,
      availability: 'unavailable',
    });
    const coverageAfterRefresh = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: created.body.id },
      include: { currentCalculation: true, currentDecision: true },
    });
    expect(coverageAfterRefresh).toMatchObject({
      state: 'production_required',
      stateVersion: 4,
      generation: 2,
      currentCalculation: { availability: 'unavailable' },
      currentDecision: { kind: 'auto_produce_all' },
    });
    expect(coverageAfterRefresh.currentCalculation?.inventoryEpoch).toBe(epochBefore.epoch);

    await http()
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 125_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const afterInvoice = await http()
      .get(`/api/commercial/orders/${created.body.id}`)
      .set(asCommercial)
      .expect(200);
    await http()
      .post(`/api/commercial/orders/${created.body.id}/amendments`)
      .set(asCommercial)
      .send({
        kind: 'update_position',
        operationKey: randomUUID(),
        expectedOrderVersion: afterInvoice.body.version,
        expectedPositionVersion: afterInvoice.body.positions[0].version,
        reason: 'Попытка изменить ширину после счёта',
        positionId: position.id,
        changes: { widthMm: 1700 },
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE');
      });
  });

  it.each(['produce_all', 'use_warehouse'] as const)(
    'retires an uncommitted %s decision after the desired specification changes',
    async (decisionKind) => {
      const suffix = randomUUID().slice(0, 8);
      const counterparty = await http()
        .post('/api/commercial/counterparties')
        .set(asCommercial)
        .send({ displayName: `V2 ${decisionKind} amendment ${suffix}` })
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
              rollCount: 1,
              filmType: 'Рукав',
              actualThickness: '80 мкм',
              accountingThickness: '78 мкм',
              ...PRIMARY_BASE_MATERIAL_SELECTION,
              widthMm: 1500,
              plannedLengthM: 300,
              spoolType: '76 мм',
              birka: `V2-${suffix}`,
              plannedWeightKg: 50,
            },
          ],
        })
        .expect(201);
      const positionId = created.body.positions[0].id as string;
      const rollId = await createVerifiedCoverageRoll(
        created.body.id,
        positionId,
        counterparty.body.id,
        suffix,
      );

      await http()
        .post(`/api/commercial/orders/${created.body.id}/invoice-handoff`)
        .set(asCommercial)
        .send({ amount: 125_000 })
        .expect(201);
      const financeOrders = await http().get('/api/finance/orders').set(asFinance).expect(200);
      const financeOrder = financeOrders.body.find(
        (candidate: { commercialOrder?: { id: string } }) =>
          candidate.commercialOrder?.id === created.body.id,
      );
      expect(financeOrder).toBeTruthy();
      const awaitingDecision = await prisma.warehouseCoverageState.findUniqueOrThrow({
        where: { orderId: created.body.id },
      });
      expect(awaitingDecision).toMatchObject({
        state: 'awaiting_finance',
        stateVersion: 2,
        generation: 1,
        currentDecisionId: null,
      });

      await http()
        .post(`/api/finance/orders/${financeOrder.id}/warehouse-coverage/decide`)
        .set(asFinance)
        .send({
          clientRequestId: randomUUID(),
          expectedGeneration: awaitingDecision.generation,
          expectedStateVersion: awaitingDecision.stateVersion,
          decision: decisionKind,
        })
        .expect(200);
      const decided = await prisma.warehouseCoverageState.findUniqueOrThrow({
        where: { orderId: created.body.id },
        include: { currentDecision: true },
      });
      expect(decided).toMatchObject({
        state: decisionKind === 'use_warehouse' ? 'warehouse_reserved' : 'production_required',
        stateVersion: 3,
        generation: 1,
        currentDecision: { kind: decisionKind },
      });
      if (decisionKind === 'produce_all') {
        await expect(
          prisma.$transaction(async (tx) => {
            await tx.commercialOrderPosition.update({
              where: { id: positionId },
              data: { version: { increment: 1 } },
            });
            await tx.$executeRaw`
              UPDATE "warehouse_coverage_states"
              SET
                "state" = 'order_spec_changed',
                "stateVersion" = "stateVersion" + 1
              WHERE "orderId" = ${created.body.id}
            `;
          }),
        ).rejects.toThrow(/cannot retain an uncommitted decision/u);
      }

      const before = await http()
        .get(`/api/commercial/orders/${created.body.id}`)
        .set(asCommercial)
        .expect(200);
      await http()
        .post(`/api/commercial/orders/${created.body.id}/amendments`)
        .set(asCommercial)
        .send({
          kind: 'update_position',
          operationKey: randomUUID(),
          expectedOrderVersion: before.body.version,
          expectedPositionVersion: before.body.positions[0].version,
          reason: `Изменена ширина после решения ${decisionKind}`,
          positionId,
          changes: { widthMm: 1600 },
        })
        .expect(201);

      const invalidated = await prisma.warehouseCoverageState.findUniqueOrThrow({
        where: { orderId: created.body.id },
      });
      expect(invalidated).toMatchObject({
        state: 'order_spec_changed',
        stateVersion: 4,
        generation: 1,
        currentCalculationId: decided.currentCalculationId,
        currentDecisionId: null,
      });
      if (decisionKind === 'use_warehouse') {
        await expect(
          prisma.$executeRaw`
            UPDATE "warehouse_coverage_states"
            SET
              "state" = 'awaiting_finance',
              "stateVersion" = "stateVersion" + 1
            WHERE "orderId" = ${created.body.id}
          `,
        ).rejects.toThrow(/exit requires a new calculation/u);
        await expect(
          prisma.warehouseRoll.findUniqueOrThrow({
            where: { id: rollId },
            select: {
              reservedForOrderId: true,
              reservedByCoverageDecisionId: true,
            },
          }),
        ).resolves.toEqual({
          reservedForOrderId: null,
          reservedByCoverageDecisionId: null,
        });
        await expect(
          prisma.warehouseAcceptanceTask.findUniqueOrThrow({
            where: { coverageDecisionId: decided.currentDecisionId! },
            select: { status: true },
          }),
        ).resolves.toEqual({ status: 'cancelled' });
      }
    },
  );
});
