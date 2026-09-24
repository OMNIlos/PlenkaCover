import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { approveProductionOnlyCover } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import {
  attachAvailableBagToOperatorShift,
  createAvailableBigBagFixture,
  createAssignedOperatorShiftFixture,
} from './operator-shift-e2e-fixture';

async function waitForCondition(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
) {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Material-shortage correction workflow (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const uniq = `${Date.now()}-${process.pid}`;
  const oldMaterial = 'rm-pvd-15803';
  const newMaterial = 'rm-pvd-10803';
  const oldParameters = [{ label: 'Сырьё', value: 'ПВД 15803-020' }];
  const newParameters = [{ label: 'Сырьё', value: 'ПВД 10803-020' }];

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'on';
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
    await app.close();
  });

  it('proves operator report, scoped correction/runtime, RBAC and spool-weight conflict', async () => {
    const password = e2eSeedPassword();
    const [commercialLogin, productionLogin, operatorLogin, warehouseLogin, financeLogin] =
      await Promise.all(
        (['commercial', 'production', 'operator', 'warehouse', 'finance'] as const).map((account) =>
          request(app.getHttpServer())
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
    const asOperator = { Authorization: `Bearer ${operatorLogin.body.token as string}` };
    const asWarehouse = { Authorization: `Bearer ${warehouseLogin.body.token as string}` };
    const asFinance = { Authorization: `Bearer ${financeLogin.body.token as string}` };
    const commercialId = commercialLogin.body.user.id as string;
    const operatorId = operatorLogin.body.user.id as string;

    const counterparty = await request(app.getHttpServer())
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({
        displayName: `Shortage E2E ${uniq}`,
        legalName: `ООО SHORTAGE-E2E-SECRET ${uniq}`,
      })
      .expect(201);

    // This is the sole intentionally historical create fixture. Public intake no longer accepts
    // rawMaterialId, so the immutable legacy template boundary is seeded directly through Prisma.
    const legacyPositions = [
      {
        rollCount: 2,
        filmType: 'Рукав — shortage target',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        rawMaterialId: oldMaterial,
        spoolType: 'втулка 76',
        birka: 'target-position',
        plannedWeightKg: 41.2,
        recipeParameters: oldParameters,
      },
      {
        rollCount: 1,
        filmType: 'Полурукав — weighed control',
        actualThickness: '60 мкм',
        accountingThickness: '58 мкм',
        rawMaterialId: oldMaterial,
        spoolType: 'втулка 76',
        birka: 'control-position',
        plannedWeightKg: 41.2,
        recipeParameters: [{ label: 'Сырьё', value: 'Контрольный ПВД 15803-020' }],
      },
    ] as unknown as Prisma.InputJsonValue;
    const legacyTemplate = await prisma.counterpartyOrderTemplate.create({
      data: {
        counterpartyId: counterparty.body.id as string,
        name: `Historical shortage fixture ${uniq}`,
        ownerRole: 'production_lead',
        createdById: commercialId,
        positions: legacyPositions,
      },
    });
    const legacyTemplateVersion = await prisma.counterpartyOrderTemplateVersion.create({
      data: {
        templateId: legacyTemplate.id,
        version: 1,
        createdById: commercialId,
        positions: legacyPositions,
      },
    });
    const commercialOrder = await request(app.getHttpServer())
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        counterpartyId: counterparty.body.id,
        requestType: 'client_order',
        templateId: legacyTemplate.id,
        templateVersionId: legacyTemplateVersion.id,
      })
      .expect(201);
    const [affectedPosition, controlPosition] = commercialOrder.body.positions as Array<{
      id: string;
    }>;

    await approveProductionOnlyCover(app, prisma, asCommercial, commercialOrder.body);

    await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 120_000, note: `Material shortage e2e ${uniq}` })
      .expect(201);

    const financeOrders = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(asFinance)
      .expect(200);
    const financeOrder = financeOrders.body.find(
      (order: { commercialOrder?: { id: string } }) =>
        order.commercialOrder?.id === commercialOrder.body.id,
    );
    expect(financeOrder).toBeTruthy();

    const invoiced = await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 120_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const prepayment = invoiced.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'invoice_prepayment',
    );
    expect(prepayment).toBeTruthy();
    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrder.id}/payment-schedules/${prepayment.id}/confirm`)
      .set(asFinance)
      .send({})
      .expect(201);

    const productionOrder = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/send-to-production`)
      .set(asCommercial)
      .send({})
      .expect(201);

    const dispatchItems = productionOrder.body.dispatchItems as Array<{
      id: string;
      orderLineId: string;
      positionSequence: number;
      rollCode: string;
    }>;
    const affectedRolls = dispatchItems
      .filter((roll) => roll.orderLineId === affectedPosition.id)
      .sort((left, right) => left.positionSequence - right.positionSequence);
    const [controlRoll] = dispatchItems.filter((roll) => roll.orderLineId === controlPosition.id);
    expect(affectedRolls).toHaveLength(2);
    expect(controlRoll).toBeTruthy();

    const operatorShift = await createAssignedOperatorShiftFixture(prisma, {
      operatorId,
      postCode: 'POST-1',
      label: `Material shortage operator shift ${uniq}`,
    });

    for (const roll of dispatchItems) {
      const assignedRoll = await request(app.getHttpServer())
        .post(`/api/production/roll-dispatch/${roll.rollCode}/assign`)
        .set(asProduction)
        .send({ operatorId })
        .expect(201);
      expect(assignedRoll.body).toMatchObject({
        assignedOperatorId: operatorId,
        plannedShiftId: operatorShift.shiftId,
        postId: operatorShift.post.id,
        machineId: operatorShift.post.code,
        workplaceId: operatorShift.post.id,
      });
    }

    await request(app.getHttpServer())
      .post(`/api/production/orders/${productionOrder.body.id}/approve`)
      .set(asProduction)
      .expect(201);
    const session = await request(app.getHttpServer())
      .post('/api/operator/post-sessions')
      .set(asOperator)
      .send({ postCode: 'POST-1' })
      .expect(201);
    expect(session.body).toEqual(expect.objectContaining({ operatorId, status: 'active' }));
    const bigBagId = await createAvailableBigBagFixture(prisma, {
      code: `SHORTAGE-BAG-${uniq}`,
      material: 'ПВД 15803-020',
    });
    await attachAvailableBagToOperatorShift(app, prisma, asOperator, 'POST-1', bigBagId);

    const shortagePayload = {
      operationKey: randomUUID(),
      type: 'raw_material_shortage',
      rollId: affectedRolls[0].rollCode,
      reason: `Primary material exhausted ${uniq}`,
      recovery: 'Use approved safe replacement',
    };
    for (const headers of [asCommercial, asProduction, asWarehouse, asFinance]) {
      await request(app.getHttpServer())
        .post('/api/operator/problems')
        .set(headers)
        .send(shortagePayload)
        .expect(403);
    }

    const beforeOrder = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: commercialOrder.body.id },
      select: {
        productionIndicator: true,
        warehouseCoverStatus: true,
        paymentStatus: true,
        shipmentStatus: true,
        positions: {
          select: {
            id: true,
            rollCount: true,
            filmType: true,
            actualThickness: true,
            accountingThickness: true,
            rawMaterialId: true,
            spoolType: true,
            birka: true,
            recipe: {
              select: { id: true, version: true, parameters: true, source: true, createdBy: true },
            },
          },
          orderBy: { id: 'asc' },
        },
        financeOrder: {
          select: { id: true, invoiceStatus: true, paymentStatus: true, amountValue: true },
        },
      },
    });
    const beforeRolls = await prisma.rollDispatchItem.findMany({
      where: { productionOrderId: productionOrder.body.id },
      orderBy: [{ orderLineId: 'asc' }, { positionSequence: 'asc' }],
    });

    const problem = await request(app.getHttpServer())
      .post('/api/operator/problems')
      .set(asOperator)
      .send(shortagePayload)
      .expect(201);
    expect(problem.body).toEqual(
      expect.objectContaining({
        type: 'raw_material_shortage',
        status: 'open',
        orderId: commercialOrder.body.id,
        positionId: affectedPosition.id,
        rollId: affectedRolls[0].rollCode,
      }),
    );

    const openProjection = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${commercialOrder.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(openProjection.body.productionProblems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: problem.body.id,
          type: 'raw_material_shortage',
          status: 'open',
          positionId: affectedPosition.id,
          reportedRollId: affectedRolls[0].rollCode,
        }),
      ]),
    );

    const corrected = await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/material-shortage-corrections`)
      .set(asCommercial)
      .send({
        problemId: problem.body.id,
        fromRollId: affectedRolls[0].rollCode,
        newRawMaterialId: newMaterial,
        newParameters,
        reason: `Approved material replacement ${uniq}`,
      })
      .expect(201);
    expect(corrected.body).toEqual(
      expect.objectContaining({
        problemId: problem.body.id,
        status: 'resolved',
        recipeVersion: 'v2',
        affectedRollIds: affectedRolls.map((roll) => roll.rollCode),
      }),
    );

    const correctedProjection = await request(app.getHttpServer())
      .get(`/api/commercial/orders/${commercialOrder.body.id}`)
      .set(asCommercial)
      .expect(200);
    expect(
      correctedProjection.body.productionProblems.some(
        (candidate: { id: string }) => candidate.id === problem.body.id,
      ),
    ).toBe(false);
    expect(
      correctedProjection.body.positions.find(
        (position: { id: string }) => position.id === affectedPosition.id,
      ),
    ).toEqual(
      expect.objectContaining({
        rawMaterialId: newMaterial,
      }),
    );

    const afterOrder = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: commercialOrder.body.id },
      select: {
        productionIndicator: true,
        warehouseCoverStatus: true,
        paymentStatus: true,
        shipmentStatus: true,
        positions: {
          select: {
            id: true,
            rollCount: true,
            filmType: true,
            actualThickness: true,
            accountingThickness: true,
            rawMaterialId: true,
            spoolType: true,
            birka: true,
            recipe: {
              select: { id: true, version: true, parameters: true, source: true, createdBy: true },
            },
          },
          orderBy: { id: 'asc' },
        },
        financeOrder: {
          select: { id: true, invoiceStatus: true, paymentStatus: true, amountValue: true },
        },
      },
    });
    const beforeAffectedPosition = beforeOrder.positions.find(
      (position) => position.id === affectedPosition.id,
    )!;
    const afterAffectedPosition = afterOrder.positions.find(
      (position) => position.id === affectedPosition.id,
    )!;
    expect(afterAffectedPosition).toEqual({
      ...beforeAffectedPosition,
      rawMaterialId: newMaterial,
      recipe: {
        ...beforeAffectedPosition.recipe!,
        version: 'v2',
        parameters: newParameters,
      },
    });
    expect(afterOrder.positions.find((position) => position.id === controlPosition.id)).toEqual(
      beforeOrder.positions.find((position) => position.id === controlPosition.id),
    );
    expect({
      productionIndicator: afterOrder.productionIndicator,
      warehouseCoverStatus: afterOrder.warehouseCoverStatus,
      paymentStatus: afterOrder.paymentStatus,
      shipmentStatus: afterOrder.shipmentStatus,
      financeOrder: afterOrder.financeOrder,
    }).toEqual({
      productionIndicator: beforeOrder.productionIndicator,
      warehouseCoverStatus: beforeOrder.warehouseCoverStatus,
      paymentStatus: beforeOrder.paymentStatus,
      shipmentStatus: beforeOrder.shipmentStatus,
      financeOrder: beforeOrder.financeOrder,
    });

    const afterRolls = await prisma.rollDispatchItem.findMany({
      where: { productionOrderId: productionOrder.body.id },
      orderBy: [{ orderLineId: 'asc' }, { positionSequence: 'asc' }],
    });
    for (const affectedRoll of affectedRolls) {
      const before = beforeRolls.find((roll) => roll.id === affectedRoll.id)!;
      const after = afterRolls.find((roll) => roll.id === affectedRoll.id)!;
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
      expect(after).toEqual({
        ...before,
        rawMaterialId: newMaterial,
        recipeVersion: 'v2',
        characteristicsSnapshot: {
          ...(before.characteristicsSnapshot as Record<string, unknown>),
          rawMaterialId: newMaterial,
          recipeVersion: 'v2',
          recipeParameters: newParameters,
        },
        updatedAt: after.updatedAt,
      });
    }
    expect(afterRolls.find((roll) => roll.id === controlRoll.id)).toEqual(
      beforeRolls.find((roll) => roll.id === controlRoll.id),
    );
    const resolvedProblem = await prisma.productionProblem.findUniqueOrThrow({
      where: { id: problem.body.id },
    });
    expect(resolvedProblem).toEqual(
      expect.objectContaining({ status: 'resolved', resolvedById: commercialId }),
    );
    expect(resolvedProblem.resolvedAt).toBeInstanceOf(Date);

    const runtime = await request(app.getHttpServer())
      .get('/api/operator/runtime')
      .set(asOperator)
      .expect(200);
    const runtimeOrder = runtime.body.orders.find(
      (order: { id: string }) => order.id === commercialOrder.body.orderNumber,
    );
    expect(runtimeOrder).toBeTruthy();
    for (const affectedRoll of affectedRolls) {
      expect(
        runtimeOrder.rolls.find((roll: { id: string }) => roll.id === affectedRoll.rollCode),
      ).toEqual(
        expect.objectContaining({
          rawMaterialId: newMaterial,
          rawMaterialLabel: 'ПВД 10803-020',
          recipeVersion: 'v2',
        }),
      );
    }
    expect(
      runtimeOrder.rolls.find((roll: { id: string }) => roll.id === controlRoll.rollCode),
    ).toEqual(
      expect.objectContaining({
        rawMaterialId: oldMaterial,
        rawMaterialLabel: 'ПВД 15803-020',
        recipeVersion: 'v1',
      }),
    );
    const runtimeJson = JSON.stringify(runtime.body);
    expect(runtimeJson).not.toContain('legalName');
    expect(runtimeJson).not.toContain(`ООО SHORTAGE-E2E-SECRET ${uniq}`);
    expect(runtimeJson).not.toContain('rawPayload');

    const raceRoll = affectedRolls[1];
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${raceRoll.rollCode}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const raceProblem = await request(app.getHttpServer())
      .post('/api/operator/problems')
      .set(asOperator)
      .send({
        operationKey: randomUUID(),
        type: 'raw_material_shortage',
        rollId: raceRoll.rollCode,
        reason: `Concurrent shortage ${uniq}`,
        recovery: 'Keep the problem open once weighing wins',
      })
      .expect(201);
    const raceLine = await prisma.operatorRollLine.findUniqueOrThrow({
      where: { rollDispatchItemId: raceRoll.id },
      select: { id: true },
    });
    const artifactSuffix = `${Date.now()}_${process.pid}`;
    const triggerName = `test_delay_weight_capture_${artifactSuffix}`;
    const functionName = `test_delay_weight_capture_fn_${artifactSuffix}`;
    const quotedLineId = raceLine.id.replaceAll("'", "''");

    try {
      // The known delay keeps the insert in-flight after the condition poll exposes its DB state.
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."operatorRollLineId" = '${quotedLineId}' THEN
            PERFORM pg_sleep(3);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON "weight_captures"
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
      `);

      const weighing = request(app.getHttpServer())
        .post(`/api/operator/rolls/${raceRoll.rollCode}/spool-weight`)
        .set(asOperator)
        .send({ operationKey: randomUUID() })
        .then((response) => response);
      await waitForCondition(async () => {
        const [activity] = await prisma.$queryRaw<Array<{ sleeping: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event = 'PgSleep'
              AND query ILIKE '%weight_captures%'
          ) AS sleeping
        `;
        return activity.sleeping;
      }, 'the test weight insert to enter its PostgreSQL trigger');
      const correcting = request(app.getHttpServer())
        .post(`/api/commercial/orders/${commercialOrder.body.id}/material-shortage-corrections`)
        .set(asCommercial)
        .send({
          problemId: raceProblem.body.id,
          fromRollId: raceRoll.rollCode,
          newRawMaterialId: oldMaterial,
          newParameters: oldParameters,
          reason: `Concurrent replacement must lose ${uniq}`,
        })
        .then((response) => response);

      const [weighingResponse, correctionResponse] = await Promise.all([weighing, correcting]);

      expect(weighingResponse.status).toBe(201);
      expect(correctionResponse.status).toBe(409);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "weight_captures"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }

    const raceResult = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { id: raceRoll.id },
      include: { operatorLine: { include: { weightCaptures: true } } },
    });
    expect(raceResult).toEqual(
      expect.objectContaining({
        rawMaterialId: newMaterial,
        recipeVersion: 'v2',
        characteristicsSnapshot: expect.objectContaining({
          rawMaterialId: newMaterial,
          recipeVersion: 'v2',
        }),
        operatorLine: expect.objectContaining({ spoolKg: expect.any(Number) }),
      }),
    );
    expect(raceResult.operatorLine?.weightCaptures).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'spool' })]),
    );
    expect(
      await prisma.productionProblem.findUniqueOrThrow({ where: { id: raceProblem.body.id } }),
    ).toEqual(expect.objectContaining({ status: 'open', resolvedAt: null, resolvedById: null }));

    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${controlRoll.rollCode}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${controlRoll.rollCode}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const controlProblem = await request(app.getHttpServer())
      .post('/api/operator/problems')
      .set(asOperator)
      .send({
        operationKey: randomUUID(),
        type: 'raw_material_shortage',
        rollId: controlRoll.rollCode,
        reason: `Control shortage after spool weighing ${uniq}`,
        recovery: 'Must remain blocked',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/commercial/orders/${commercialOrder.body.id}/material-shortage-corrections`)
      .set(asCommercial)
      .send({
        problemId: controlProblem.body.id,
        fromRollId: controlRoll.rollCode,
        newRawMaterialId: newMaterial,
        newParameters,
        reason: `Forbidden after spool weighing ${uniq}`,
      })
      .expect(409);

    const weighedControl = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { id: controlRoll.id },
      include: { operatorLine: { include: { weightCaptures: true } } },
    });
    expect(weighedControl).toEqual(
      expect.objectContaining({
        rawMaterialId: oldMaterial,
        recipeVersion: 'v1',
        characteristicsSnapshot: expect.objectContaining({
          rawMaterialId: oldMaterial,
          recipeVersion: 'v1',
          birka: 'control-position',
        }),
        operatorLine: expect.objectContaining({ spoolKg: expect.any(Number) }),
      }),
    );
    expect(weighedControl.operatorLine?.weightCaptures).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'spool' })]),
    );
    expect(
      await prisma.productionProblem.findUniqueOrThrow({ where: { id: controlProblem.body.id } }),
    ).toEqual(expect.objectContaining({ status: 'open', resolvedAt: null, resolvedById: null }));
    expect(
      await prisma.commercialOrderPosition.findUniqueOrThrow({
        where: { id: controlPosition.id },
        select: {
          id: true,
          rollCount: true,
          filmType: true,
          actualThickness: true,
          accountingThickness: true,
          rawMaterialId: true,
          spoolType: true,
          birka: true,
          recipe: {
            select: { id: true, version: true, parameters: true, source: true, createdBy: true },
          },
        },
      }),
    ).toEqual(beforeOrder.positions.find((position) => position.id === controlPosition.id));
  });
});
