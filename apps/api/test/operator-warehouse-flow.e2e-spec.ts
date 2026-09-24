import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SCALE_ADAPTER, type ScaleAdapter } from '../src/integrations/scale/scale.adapter';
import { OperatorOperationService } from '../src/modules/operator/operator-operation.service';
import {
  approveProductionOnlyCover,
  PRIMARY_BASE_MATERIAL_SELECTION,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import { cleanupOwnedOperatorFixtureGraph } from './operator-e2e-cleanup';
import {
  closeOperatorSessionFixture,
  prepareReadyDefectBagFixture,
  registerAndSendBigBagToProduction,
} from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';
import { selectAcceptedRowsIntoCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

async function waitForAdapterSignal(
  signal: Promise<void>,
  requestResult: Promise<{ status: number; body?: unknown }>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      requestResult.then((response) => {
        const code =
          response.body &&
          typeof response.body === 'object' &&
          'code' in response.body &&
          typeof response.body.code === 'string'
            ? ` ${response.body.code}`
            : '';
        throw new Error(
          `${label} request ended before adapter signal with HTTP ${response.status}${code}`,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Slice 4–5 flow (design 2026-07-13): warehouse packs a big bag from stock → operator
 * opens the shift with it → roll pipeline on gateway devices → JSON QR → handover →
 * warehouse intake scan by payload → pallet draft/seal/print → full close →
 * defect rework with recycling → shift close with a balance mismatch problem.
 *
 * Env flags are read at module import time — AppModule is require()d inside beforeAll.
 */
describe('Operator → warehouse slice flow (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const savedEnv: Record<string, string | undefined> = {};
  const FLAGS = {
    AUTH_DEV_XROLE: 'on',
    DEVICE_GATEWAY_SCALE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
  } as const;
  const asCommercial = { 'x-role': 'commercial' };
  const asProduction = { 'x-role': 'production_lead' };
  const asFinance = { 'x-role': 'finance' };
  const uniq = Date.now();
  const cleanupActorIds = new Set<string>();
  const cleanupBigBagIds = new Set<string>();
  const cleanupDeviceIds = new Set<string>();
  const cleanupPostIds = new Set<string>();
  const cleanupShiftIds = new Set<string>();
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;
  let primaryStockDefinitionId: string | null | undefined;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(FLAGS)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
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
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'operator warehouse simulated devices',
          run: async () => restoreSimulatedDevices?.(),
        },
        {
          label: 'operator warehouse stock definition',
          run: async () => {
            if (primaryStockDefinitionId !== undefined) {
              await prisma.rawMaterialStock.update({
                where: { materialId: 'rm-pvd-15803' },
                data: { rawMaterialDefinitionId: primaryStockDefinitionId },
              });
            }
          },
        },
        {
          label: 'operator warehouse scoped fixture graph',
          run: async () => {
            if (!prisma) return;
            await cleanupOwnedOperatorFixtureGraph(prisma, {
              actorIds: [...cleanupActorIds],
              bigBagIds: [...cleanupBigBagIds],
              deviceIds: [...cleanupDeviceIds],
              postIds: [...cleanupPostIds],
              shiftIds: [...cleanupShiftIds],
            });
          },
        },
        { label: 'operator warehouse application', run: async () => app?.close() },
        {
          label: 'operator warehouse environment',
          run: () => {
            for (const [k, v] of Object.entries(savedEnv)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
          },
        },
      ],
    );
  });

  it('classifies concurrent cross-line reuse of one operation key without a false replay', async () => {
    const suffix = randomUUID().slice(0, 8);
    const passwordSource = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const operator = await prisma.user.create({
      data: {
        login: `operation-key-${suffix}`,
        passwordHash: passwordSource.passwordHash,
        displayName: `Operation key operator ${suffix}`,
        role: 'operator',
      },
    });
    cleanupActorIds.add(operator.id);
    const post = await prisma.post.create({
      data: {
        code: `OPERATION-KEY-${suffix}`,
        name: `Operation key post ${suffix}`,
        status: 'active',
      },
    });
    const session = await prisma.operatorPostSession.create({
      data: { operatorId: operator.id, postId: post.id, status: 'active' },
    });
    const lines = await prisma.operatorRollLine.findMany({ take: 2, orderBy: { id: 'asc' } });
    expect(lines).toHaveLength(2);
    const operationKey = randomUUID();
    const operations = new OperatorOperationService();
    const input = (operatorRollLineId: string, expectedStep: string) => ({
      operationKey,
      action: 'accept' as const,
      actorId: session.operatorId,
      operatorRollLineId,
      postId: session.postId,
      postSessionId: session.id,
      expectedStep,
      fingerprintInput: {},
    });

    try {
      const results = await Promise.allSettled(
        lines.map((line) =>
          prisma.$transaction((tx) => operations.claim(tx, input(line.id, line.step))),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toEqual(
        expect.objectContaining({
          status: 'rejected',
          reason: expect.objectContaining({
            response: expect.objectContaining({ code: 'OPERATOR_OPERATION_KEY_CONFLICT' }),
          }),
        }),
      );
      await expect(prisma.operatorRollOperation.count({ where: { operationKey } })).resolves.toBe(
        1,
      );
    } finally {
      await prisma.operatorRollOperation.deleteMany({ where: { operationKey } });
      await prisma.operatorPostSession.delete({ where: { id: session.id } });
      await prisma.post.delete({ where: { id: post.id } });
      // The actor is removed by the suite-scoped teardown after all assertions finish.
    }
  });

  it('reclaims one expired physical lease and fences the crashed worker in PostgreSQL', async () => {
    const suffix = randomUUID().slice(0, 8);
    const passwordSource = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const operator = await prisma.user.create({
      data: {
        login: `operation-lease-${suffix}`,
        passwordHash: passwordSource.passwordHash,
        displayName: `Operation lease operator ${suffix}`,
        role: 'operator',
      },
    });
    cleanupActorIds.add(operator.id);
    const post = await prisma.post.create({
      data: {
        code: `OPERATION-LEASE-${suffix}`,
        name: `Operation lease post ${suffix}`,
        status: 'active',
      },
    });
    const session = await prisma.operatorPostSession.create({
      data: { operatorId: operator.id, postId: post.id, status: 'active' },
    });
    const line = await prisma.operatorRollLine.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const operationKey = randomUUID();
    const staleSceneKey = randomUUID();
    const replacementKey = randomUUID();
    const operations = new OperatorOperationService();
    const input = {
      operationKey,
      action: 'defect' as const,
      actorId: operator.id,
      operatorRollLineId: line.id,
      postId: post.id,
      postSessionId: session.id,
      expectedStep: line.step,
      fingerprintInput: { comment: 'lease recovery e2e' },
    };

    try {
      const unfencedKey = randomUUID();
      await expect(
        prisma.$executeRaw`
          INSERT INTO "operator_roll_operations" (
            "id", "operationKey", "operatorRollLineId", "action", "actorId",
            "postSessionId", "postId", "requestFingerprint", "expectedStep", "status"
          ) VALUES (
            ${`unfenced-${suffix}`}, ${unfencedKey}, ${line.id}, 'defect', ${operator.id},
            ${session.id}, ${post.id}, ${'0'.repeat(64)}, ${line.step}, 'in_progress'
          )
        `,
      ).rejects.toBeDefined();
      await expect(
        prisma.operatorRollOperation.count({ where: { operationKey: unfencedKey } }),
      ).resolves.toBe(0);

      const first = await prisma.$transaction((tx) => operations.claim(tx, input));
      expect(first.kind).toBe('claimed');
      const oldToken = first.operation.leaseToken;
      expect(oldToken).toEqual(expect.any(String));
      await prisma.operatorRollOperation.update({
        where: { operationKey },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      const results = await Promise.allSettled([
        prisma.$transaction((tx) => operations.claim(tx, input)),
        prisma.$transaction((tx) => operations.claim(tx, input)),
      ]);
      const winners = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof operations.claim>>> =>
          result.status === 'fulfilled',
      );
      expect(winners).toHaveLength(1);
      expect(winners[0].value).toMatchObject({
        kind: 'claimed',
        operation: { attempt: 2, leaseToken: expect.any(String) },
      });
      const currentToken = winners[0].value.operation.leaseToken;
      expect(currentToken).not.toBe(oldToken);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({
          response: expect.objectContaining({ code: 'OPERATOR_OPERATION_IN_PROGRESS' }),
        }),
      });

      await expect(
        prisma.$transaction((tx) =>
          operations.complete(
            tx,
            first.operation.id,
            { resultStep: 'deferred', httpStatus: 200 },
            oldToken,
          ),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'OPERATOR_OPERATION_LEASE_LOST' }),
      });
      await prisma.$transaction((tx) =>
        operations.complete(
          tx,
          first.operation.id,
          { resultStep: 'deferred', httpStatus: 200 },
          currentToken,
        ),
      );
      await expect(
        prisma.operatorRollOperation.findUniqueOrThrow({ where: { operationKey } }),
      ).resolves.toMatchObject({
        status: 'succeeded',
        attempt: 2,
        leaseToken: null,
        leaseExpiresAt: null,
      });

      const staleSceneInput = { ...input, operationKey: staleSceneKey };
      const staleScene = await prisma.$transaction((tx) => operations.claim(tx, staleSceneInput));
      expect(staleScene.kind).toBe('claimed');
      const staleSceneToken = staleScene.operation.leaseToken;
      expect(staleSceneToken).toEqual(expect.any(String));
      await prisma.operatorRollOperation.update({
        where: { operationKey: staleSceneKey },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      await expect(
        prisma.$transaction(async (tx) => {
          await operations.claim(tx, staleSceneInput);
          throw new Error('scene changed after reclaim');
        }),
      ).rejects.toThrow('scene changed after reclaim');
      await expect(
        prisma.operatorRollOperation.findUniqueOrThrow({
          where: { operationKey: staleSceneKey },
        }),
      ).resolves.toMatchObject({
        status: 'in_progress',
        leaseToken: staleSceneToken,
      });

      await expect(
        prisma.$transaction((tx) =>
          operations.settleExpired(tx, staleScene.operation.id, staleSceneToken!, {
            httpStatus: 409,
            errorCode: 'OPERATOR_STEP_CONFLICT',
          }),
        ),
      ).resolves.toBe(true);
      await expect(
        prisma.operatorRollOperation.findUniqueOrThrow({
          where: { operationKey: staleSceneKey },
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'OPERATOR_STEP_CONFLICT',
        leaseToken: null,
        leaseExpiresAt: null,
      });
      await expect(
        prisma.$transaction((tx) =>
          operations.claim(tx, { ...input, operationKey: replacementKey }),
        ),
      ).resolves.toMatchObject({ kind: 'claimed' });
    } finally {
      await prisma.operatorRollOperation.deleteMany({
        where: { operationKey: { in: [operationKey, staleSceneKey, replacementKey] } },
      });
      await prisma.operatorPostSession.delete({ where: { id: session.id } });
      await prisma.post.delete({ where: { id: post.id } });
      // The actor is removed by the suite-scoped teardown after all assertions finish.
    }
  });

  it('runs the full operator→warehouse cycle with bags, QR intake, pallet list and balance check', async () => {
    const http = () => request(app.getHttpServer());
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-1',
      'dev-printer-1',
    ]);

    // --- Logins (operator/warehouse actions are session/identity-scoped) ------
    const mainSuffix = randomUUID().slice(0, 8);
    const passwordSource = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const mainOperator = await prisma.user.create({
      data: {
        login: `operator-flow-${mainSuffix}`,
        passwordHash: passwordSource.passwordHash,
        displayName: `Operator flow ${mainSuffix}`,
        role: 'operator',
      },
    });
    const mainPost = await prisma.post.findUniqueOrThrow({
      where: { code: 'POST-1' },
      select: { id: true },
    });
    const mainNow = new Date();
    const mainShift = await prisma.shift.create({
      data: {
        label: `Operator flow shift ${mainSuffix}`,
        plannedStartAt: new Date(mainNow.getTime() - 60_000),
        plannedEndAt: new Date(mainNow.getTime() + 60 * 60_000),
        startedAt: mainNow,
        status: 'open',
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: mainShift.id,
        operatorId: mainOperator.id,
        postId: mainPost.id,
        status: 'locked',
        lockedAt: mainNow,
      },
    });
    const operatorLogin = await http()
      .post('/api/auth/login')
      .send({ login: mainOperator.login, password: e2eSeedPassword() })
      .expect(201);
    const asOperator = { Authorization: `Bearer ${operatorLogin.body.token as string}` };
    const operatorId = operatorLogin.body.user.id as string;
    const foreignSuffix = randomUUID().slice(0, 8);
    const foreignLogin = `cross-post-${foreignSuffix}`;
    const foreignPostCode = `CROSS-POST-${foreignSuffix}`;
    const foreignOperator = await prisma.user.create({
      data: {
        login: foreignLogin,
        passwordHash: passwordSource.passwordHash,
        displayName: `Cross-post operator ${foreignSuffix}`,
        role: 'operator',
      },
    });
    cleanupActorIds.add(foreignOperator.id);
    const foreignPost = await prisma.post.create({
      data: {
        code: foreignPostCode,
        name: `Cross-post machine ${foreignSuffix}`,
        status: 'active',
      },
    });
    cleanupPostIds.add(foreignPost.id);
    const foreignDevices = (['scale', 'printer', 'scanner'] as const).map((kind) => ({
      id: `cross-post-${kind}-${foreignSuffix}`,
      code: `CROSS-POST-${kind}-${foreignSuffix}`,
      kind,
      postId: foreignPost.id,
    }));
    await prisma.deviceRuntime.createMany({ data: foreignDevices });
    foreignDevices.forEach(({ id }) => cleanupDeviceIds.add(id));
    const restoreForeignDevices = await enableSimulatedDevices(
      prisma,
      foreignDevices.map((device) => device.id),
    );
    const foreignNow = new Date();
    const foreignShift = await prisma.shift.create({
      data: {
        label: `Cross-post shift ${foreignSuffix}`,
        plannedStartAt: new Date(foreignNow.getTime() - 60_000),
        plannedEndAt: new Date(foreignNow.getTime() + 60 * 60_000),
        status: 'planned',
      },
    });
    cleanupShiftIds.add(foreignShift.id);
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: foreignShift.id,
        operatorId: foreignOperator.id,
        postId: foreignPost.id,
        status: 'planned',
      },
    });
    const operatorTwoLogin = await http()
      .post('/api/auth/login')
      .send({ login: foreignLogin, password: e2eSeedPassword() })
      .expect(201);
    const asOperatorTwo = {
      Authorization: `Bearer ${operatorTwoLogin.body.token as string}`,
    };
    const warehouseLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('warehouse'), password: e2eSeedPassword() })
      .expect(201);
    const asWarehouse = { Authorization: `Bearer ${warehouseLogin.body.token as string}` };
    const occupiedFixtureSessions = await prisma.operatorPostSession.findMany({
      where: {
        status: 'active',
        OR: [{ operatorId }, { post: { code: 'POST-1' } }],
      },
      select: { id: true },
    });
    for (const session of occupiedFixtureSessions) {
      await closeOperatorSessionFixture(prisma, session.id);
    }

    // --- Warehouse packs a fresh big bag from raw material stock --------------
    await http()
      .post('/api/warehouse/raw-materials/rm-pvd-15803/adjustments')
      .set(asWarehouse)
      .send({
        operationKey: randomUUID(),
        actualQty: 1000,
        reason: 'e2e: пополнение для фасовки',
      })
      .expect(201);
    const primaryStock = await prisma.rawMaterialStock.findUniqueOrThrow({
      where: { materialId: 'rm-pvd-15803' },
      select: { rawMaterialDefinitionId: true },
    });
    primaryStockDefinitionId = primaryStock.rawMaterialDefinitionId;
    await prisma.rawMaterialStock.update({
      where: { materialId: 'rm-pvd-15803' },
      data: {
        // This legacy recycling acceptance needs the physical stock identity downstream.
        // Public order intake still uses the structured base selector.
        rawMaterialDefinitionId: PRIMARY_BASE_MATERIAL_SELECTION.baseRawMaterialDefinitionId,
      },
    });
    const bagCode = `BB-E2E-${uniq}`;
    const bag = await http()
      .post('/api/warehouse/big-bags')
      .set(asWarehouse)
      .send({ materialId: 'rm-pvd-15803', weightKg: 200, code: bagCode })
      .expect(201);
    expect(bag.body.status).toBe('available');
    await registerAndSendBigBagToProduction(app, prisma, asWarehouse, bag.body.id as string);
    const stockAfterBag = await http()
      .get('/api/warehouse/raw-materials')
      .set(asWarehouse)
      .expect(200);
    const pvd = stockAfterBag.body.find(
      (m: { materialId: string }) => m.materialId === 'rm-pvd-15803',
    );
    expect(pvd.actualQty).toBe(800);

    // --- Commercial → finance (postpay allows handoff) → production -----------
    const cp = await http()
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `Слайс45 ${uniq}`, inn: `77${uniq}`.slice(0, 12) })
      .expect(201);
    const commercial = await http()
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: cp.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 3,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            spoolType: 'втулка 76',
            plannedWeightKg: 41.2,
            widthMm: 1700,
            plannedLengthM: 275,
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД 15803-020' }],
          },
        ],
      })
      .expect(201);
    await approveProductionOnlyCover(app, prisma, asCommercial, commercial.body);
    await http()
      .post(`/api/commercial/orders/${commercial.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 250000, note: 'e2e слайсов 4–5' })
      .expect(201);
    const financeOrders = await http().get('/api/finance/orders').set(asFinance).expect(200);
    const financeOrder = financeOrders.body.find(
      (order: { commercialOrder?: { id: string } }) =>
        order.commercialOrder?.id === commercial.body.id,
    );
    await http()
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(asFinance)
      .send({ amount: 250000, paymentTermsType: 'postpay_100_30d' })
      .expect(201);
    const production = await http()
      .post(`/api/commercial/orders/${commercial.body.id}/send-to-production`)
      .set(asCommercial)
      .send({})
      .expect(201);
    const [rollOne, rollTwo, rollThree] = production.body.dispatchItems.map(
      (item: { rollCode: string }) => item.rollCode,
    );

    // --- Production lead assigns both rolls to the operator on POST-1 ---------
    const shifts = await http().get('/api/production/shifts').set(asProduction).expect(200);
    const shift = shifts.body.find(
      (item: { status: string; machineAssignments: Array<{ operatorId: string }> }) =>
        item.status === 'open' &&
        item.machineAssignments.some((assignment) => assignment.operatorId === operatorId),
    );
    expect(shift).toBeTruthy();
    const shiftAssignment = shift.machineAssignments.find(
      (assignment: { operatorId: string }) => assignment.operatorId === operatorId,
    );
    expect(shiftAssignment).toBeTruthy();
    for (const rollCode of [rollOne, rollTwo, rollThree]) {
      const assignment = await http()
        .post(`/api/production/roll-dispatch/${rollCode}/assign`)
        .set(asProduction)
        .send({ operatorId })
        .expect(201);
      expect(assignment.body).toEqual(
        expect.objectContaining({
          assignedOperatorId: operatorId,
          plannedShiftId: shift.id,
          postId: shiftAssignment.post.id,
          machineId: shiftAssignment.post.code,
          workplaceId: shiftAssignment.post.id,
        }),
      );
    }
    await http()
      .post(`/api/production/orders/${production.body.id}/approve`)
      .set(asProduction)
      .expect(201);

    // --- Operator opens the shift WITH the bag (start weight gate) ------------
    await http().post('/api/operator/post-sessions/close').set(asOperator).expect(201);
    const bags = await http().get('/api/operator/big-bags').set(asOperator).expect(200);
    const pickable = bags.body.find((item: { code: string }) => item.code === bagCode);
    expect(pickable.status).toBe('available');
    expect(pickable.warehouseKg).toBe(200);
    await http()
      .post('/api/operator/shift/open')
      .set(asOperator)
      .send({ postCode: 'POST-1', bigBagId: pickable.id, startKg: 200 })
      .expect(201);
    const runtimeOpen = await http().get('/api/operator/runtime').set(asOperator).expect(200);
    expect(runtimeOpen.body.shift.status).toBe('active');
    expect(runtimeOpen.body.shift.bags[0].code).toBe(bagCode);
    expect(runtimeOpen.body.shift.plannedConsumptionKg).toBeGreaterThan(0);
    expect(runtimeOpen.body.shift.estimatedMinutes).toBeGreaterThan(0);

    // --- Roll 1: full pipeline through gateway devices + JSON QR --------------
    const foreignBag = await prisma.bigBagUnit.create({
      data: {
        code: `BB-CROSS-POST-${foreignSuffix}`,
        material: 'Cross-post isolation fixture',
        status: 'available',
        registrationStatus: 'registered',
        location: 'production',
        initialKg: 10,
        currentKg: 10,
        lastMeasuredKg: 10,
      },
    });
    cleanupBigBagIds.add(foreignBag.id);
    try {
      await http()
        .post('/api/operator/post-sessions')
        .set(asOperatorTwo)
        .send({ postCode: foreignPostCode })
        .expect(201);
      await http()
        .post('/api/operator/shift/open')
        .set(asOperatorTwo)
        .send({ postCode: foreignPostCode, bigBagId: foreignBag.id, startKg: 10 })
        .expect(201);
      await prepareReadyDefectBagFixture(prisma, foreignOperator.id);
      const foreignRoll = await http()
        .post(`/api/operator/rolls/${rollOne}/accept`)
        .set(asOperatorTwo)
        .send({ operationKey: randomUUID() })
        .expect(404);
      expect(foreignRoll.body).toEqual(
        expect.objectContaining({ code: 'OPERATOR_ROLL_NOT_FOUND' }),
      );
      await http()
        .post('/api/operator/shift/close')
        .set(asOperatorTwo)
        .send({ operationKey: randomUUID(), bags: [{ bigBagId: foreignBag.id, endKg: 10 }] })
        .expect(200);
    } finally {
      await restoreForeignDevices();
      // Keep immutable close evidence until the complete test finishes; suite teardown removes
      // this exact actor/post/shift/BigBag graph before another spec can observe it.
    }

    await http()
      .post(`/api/operator/rolls/${rollOne}/handover`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(409);
    await http()
      .post(`/api/operator/rolls/${rollOne}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID(), deviceId: 'browser-selected-scale' })
      .expect(400);

    const brokenPostKey = randomUUID();
    await prisma.post.update({ where: { code: 'POST-1' }, data: { status: 'broken' } });
    const brokenPostMutation = await http()
      .post(`/api/operator/rolls/${rollOne}/accept`)
      .set(asOperator)
      .send({ operationKey: brokenPostKey });
    await prisma.post.update({ where: { code: 'POST-1' }, data: { status: 'active' } });
    expect(brokenPostMutation.status).toBe(409);
    await expect(
      prisma.operatorRollOperation.count({ where: { operationKey: brokenPostKey } }),
    ).resolves.toBe(0);

    const acceptKey = randomUUID();
    await http()
      .post(`/api/operator/rolls/${rollOne}/accept`)
      .set(asOperator)
      .send({ operationKey: acceptKey })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollOne}/accept`)
      .set(asOperator)
      .send({ operationKey: acceptKey })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollOne}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(409);
    const failedSpoolKey = randomUUID();
    await prisma.deviceRuntime.update({
      where: { id: 'dev-scale-1' },
      data: { isEnabled: false },
    });
    await http()
      .post(`/api/operator/rolls/${rollOne}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: failedSpoolKey })
      .expect(503);
    await expect(
      prisma.operatorRollOperation.findUniqueOrThrow({ where: { operationKey: failedSpoolKey } }),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'POST_DEVICE_BINDING_UNAVAILABLE',
      deviceId: null,
    });
    await prisma.deviceRuntime.update({
      where: { id: 'dev-scale-1' },
      data: { isEnabled: true, status: 'ready' },
    });
    await http()
      .post(`/api/operator/rolls/${rollOne}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: failedSpoolKey })
      .expect(503);

    const recoveryEventsBefore = await prisma.domainEvent.count({
      where: {
        actorId: operatorId,
        objectId: rollOne,
        type: 'audit:operator_physical_operation_recovered',
      },
    });
    const spoolKey = randomUUID();
    await http()
      .post(`/api/operator/rolls/${rollOne}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: spoolKey })
      .expect(201);
    await expect(
      prisma.domainEvent.count({
        where: {
          actorId: operatorId,
          objectId: rollOne,
          type: 'audit:operator_physical_operation_recovered',
        },
      }),
    ).resolves.toBe(recoveryEventsBefore + 1);
    await http()
      .post(`/api/operator/rolls/${rollOne}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: spoolKey })
      .expect(201);
    expect(
      await prisma.weightCapture.count({
        where: { line: { rollDispatchItem: { rollCode: rollOne } }, kind: 'spool' },
      }),
    ).toBe(1);
    const weighed = await http()
      .post(`/api/operator/rolls/${rollOne}/roll-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    expect(weighed.body.netKg).toBeCloseTo(41.4, 3);

    const reweighKey = randomUUID();
    const reweighed = await http()
      .post(`/api/operator/rolls/${rollOne}/reweigh`)
      .set(asOperator)
      .send({ operationKey: reweighKey })
      .expect(201);
    expect(reweighed.body).toEqual({
      rollCode: rollOne,
      step: 'qr_print',
      previousWeight: { grossKg: 43.4, netKg: 41.4, toleranceOk: expect.any(Boolean) },
      currentWeight: { grossKg: 43.4, netKg: 41.4, toleranceOk: expect.any(Boolean) },
    });
    await http()
      .post(`/api/operator/rolls/${rollOne}/reweigh`)
      .set(asOperator)
      .send({ operationKey: reweighKey })
      .expect(201, reweighed.body);

    const concurrentReweighKeys = [randomUUID(), randomUUID()];
    const concurrentScaleAdapter = app.get<ScaleAdapter>(SCALE_ADAPTER);
    const originalConcurrentScaleRead = concurrentScaleAdapter.read.bind(concurrentScaleAdapter);
    let signalConcurrentScaleRead!: () => void;
    let releaseConcurrentScaleRead!: () => void;
    const concurrentScaleReadStarted = new Promise<void>((resolve) => {
      signalConcurrentScaleRead = resolve;
    });
    const concurrentScaleReadGate = new Promise<void>((resolve) => {
      releaseConcurrentScaleRead = resolve;
    });
    const concurrentScaleSpy = jest
      .spyOn(concurrentScaleAdapter, 'read')
      .mockImplementationOnce(async (binding, kind) => {
        const reading = await originalConcurrentScaleRead(binding, kind);
        signalConcurrentScaleRead();
        await concurrentScaleReadGate;
        return reading;
      });
    const firstConcurrentReweigh = http()
      .post(`/api/operator/rolls/${rollOne}/reweigh`)
      .set(asOperator)
      .send({ operationKey: concurrentReweighKeys[0] })
      .then((response) => response);
    try {
      await waitForAdapterSignal(
        concurrentScaleReadStarted,
        firstConcurrentReweigh,
        'concurrent reweigh scale read',
      );
      const blockedConcurrentReweigh = await http()
        .post(`/api/operator/rolls/${rollOne}/reweigh`)
        .set(asOperator)
        .send({ operationKey: concurrentReweighKeys[1] });
      expect(blockedConcurrentReweigh.status).toBe(409);
      expect(blockedConcurrentReweigh.body).toEqual(
        expect.objectContaining({ code: 'OPERATOR_OPERATION_CLAIM_CONFLICT' }),
      );
      releaseConcurrentScaleRead();
      await expect(firstConcurrentReweigh).resolves.toMatchObject({ status: 201 });
      await http()
        .post(`/api/operator/rolls/${rollOne}/reweigh`)
        .set(asOperator)
        .send({ operationKey: concurrentReweighKeys[1] })
        .expect(201);
    } finally {
      releaseConcurrentScaleRead();
      await Promise.allSettled([firstConcurrentReweigh]);
      concurrentScaleSpy.mockRestore();
    }

    const lineAfterConcurrentReweigh = await prisma.operatorRollLine.findFirstOrThrow({
      where: { rollDispatchItem: { rollCode: rollOne } },
      select: { id: true },
    });
    const reweighOperations = await prisma.operatorRollOperation.findMany({
      where: { operationKey: { in: [reweighKey, ...concurrentReweighKeys] } },
      select: { operationKey: true, status: true },
    });
    expect(reweighOperations).toHaveLength(3);
    expect(reweighOperations.every((operation) => operation.status === 'succeeded')).toBe(true);
    const rollCaptures = await prisma.weightCapture.findMany({
      where: { operatorRollLineId: lineAfterConcurrentReweigh.id, kind: 'roll', stable: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, supersedesCaptureId: true },
    });
    expect(rollCaptures).toHaveLength(4);
    const root = rollCaptures.find((capture) => capture.supersedesCaptureId === null);
    expect(root).toBeTruthy();
    const successorById = new Map<string, string>();
    for (const capture of rollCaptures) {
      if (capture.supersedesCaptureId) {
        expect(successorById.has(capture.supersedesCaptureId)).toBe(false);
        successorById.set(capture.supersedesCaptureId, capture.id);
      }
    }
    const visited = new Set<string>();
    let cursor: string | undefined = root?.id;
    while (cursor) {
      expect(visited.has(cursor)).toBe(false);
      visited.add(cursor);
      cursor = successorById.get(cursor);
    }
    expect(visited.size).toBe(rollCaptures.length);

    const scaleAdapter = app.get<ScaleAdapter>(SCALE_ADAPTER);
    const originalScaleRead = scaleAdapter.read.bind(scaleAdapter);
    let signalScaleRead!: () => void;
    let releaseScaleRead!: () => void;
    const scaleReadStarted = new Promise<void>((resolve) => {
      signalScaleRead = resolve;
    });
    const scaleReadGate = new Promise<void>((resolve) => {
      releaseScaleRead = resolve;
    });
    const scaleSpy = jest
      .spyOn(scaleAdapter, 'read')
      .mockImplementationOnce(async (binding, kind) => {
        const reading = await originalScaleRead(binding, kind);
        signalScaleRead();
        await scaleReadGate;
        return reading;
      });
    const printRaceReweighKey = randomUUID();
    const printKey = randomUUID();
    const printRaceReweigh = http()
      .post(`/api/operator/rolls/${rollOne}/reweigh`)
      .set(asOperator)
      .send({ operationKey: printRaceReweighKey })
      .then((response) => response);
    let injectedPrintJobId: string | null = null;
    try {
      await waitForAdapterSignal(scaleReadStarted, printRaceReweigh, 'reweigh scale read');
      const activeOperatorSession = await prisma.operatorPostSession.findFirstOrThrow({
        where: { operatorId, status: 'active' },
        select: { id: true, postId: true },
      });
      const injectedPrintJob = await prisma.labelPrintJob.create({
        data: {
          operatorRollLineId: lineAfterConcurrentReweigh.id,
          printerId: 'dev-printer-1',
          status: 'queued',
          actorId: operatorId,
          postSessionId: activeOperatorSession.id,
          postId: activeOperatorSession.postId,
        },
        select: { id: true },
      });
      injectedPrintJobId = injectedPrintJob.id;
      releaseScaleRead();
      const rejectedReweigh = await printRaceReweigh;
      expect(rejectedReweigh.status).toBe(409);
      expect(rejectedReweigh.body).toEqual(
        expect.objectContaining({ code: 'OPERATOR_REWEIGH_PRINT_ALREADY_STARTED' }),
      );
      await expect(
        prisma.operatorRollOperation.findUniqueOrThrow({
          where: { operationKey: printRaceReweighKey },
          select: { status: true, errorCode: true },
        }),
      ).resolves.toEqual({
        status: 'failed',
        errorCode: 'OPERATOR_REWEIGH_PRINT_ALREADY_STARTED',
      });
      await expect(
        prisma.weightCapture.count({
          where: { operatorRollLineId: lineAfterConcurrentReweigh.id, kind: 'roll', stable: true },
        }),
      ).resolves.toBe(rollCaptures.length);
    } finally {
      releaseScaleRead();
      await Promise.allSettled([printRaceReweigh]);
      scaleSpy.mockRestore();
      if (injectedPrintJobId) {
        await prisma.labelPrintJob.delete({ where: { id: injectedPrintJobId } });
      }
    }
    const printed = await http()
      .post(`/api/operator/rolls/${rollOne}/qr-print`)
      .set(asOperator)
      .send({ operationKey: printKey })
      .expect(201);
    expect(
      await prisma.labelPrintJob.count({
        where: { line: { rollDispatchItem: { rollCode: rollOne } } },
      }),
    ).toBe(1);
    await http()
      .post(`/api/operator/rolls/${rollOne}/reweigh`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(409);
    await expect(
      prisma.weightCapture.count({
        where: { operatorRollLineId: lineAfterConcurrentReweigh.id, kind: 'roll', stable: true },
      }),
    ).resolves.toBe(rollCaptures.length);
    expect(printed.body).not.toHaveProperty('qrCode');
    const printEvidence = await prisma.rollScanToken.findUniqueOrThrow({
      where: { rollCode: rollOne },
      select: { token: true },
    });
    const qrPayload = printEvidence.token;
    expect(qrPayload).toMatch(/^prt_[0-9a-f]{64}$/u);
    await http()
      .post(`/api/operator/rolls/${rollOne}/qr-verify`)
      .set(asOperator)
      .send({ operationKey: randomUUID(), payload: `${qrPayload}\n` })
      .expect(400);
    await http()
      .post(`/api/operator/rolls/${rollOne}/qr-verify`)
      .set(asOperator)
      .send({ operationKey: randomUUID(), payload: qrPayload })
      .expect(201);
    const handoverKey = randomUUID();
    await http()
      .post(`/api/operator/rolls/${rollOne}/handover`)
      .set(asOperator)
      .send({ operationKey: handoverKey })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollOne}/handover`)
      .set(asOperator)
      .send({ operationKey: handoverKey })
      .expect(201);

    // --- Warehouse intake: real data, scan by payload auto-targets the order --
    const intake = await http().get('/api/warehouse/intake').set(asWarehouse).expect(200);
    const intakeTask = intake.body.tasks.find(
      (task: { orderNumber: string | null }) => task.orderNumber === commercial.body.orderNumber,
    );
    expect(intakeTask).toBeTruthy();
    expect(intakeTask.operationCode).toMatch(/^ПР-\d{4}-\d{2,}$/);
    expect(intakeTask.rolls[0].rollCode).toBe(rollOne);
    expect(intakeTask.rolls[0].netKg).toBeCloseTo(41.4, 3);
    const scan = await http()
      .post('/api/warehouse/intake/scans')
      .set(asWarehouse)
      .send({ operationKey: randomUUID(), payload: qrPayload })
      .expect(201);
    expect(scan.body).toEqual(
      expect.objectContaining({
        taskId: intakeTask.taskId,
        rollCode: rollOne,
        scanStatus: 'accepted',
        replayed: false,
      }),
    );

    // --- Physical pallet: draft → immutable seal → gateway print ---------------
    await selectAcceptedRowsIntoCurrentPalletFixture(app, asWarehouse, intakeTask.taskId as string);
    const draft = await http()
      .get(`/api/warehouse/intake/${intakeTask.taskId}/pallet-list`)
      .set(asWarehouse)
      .expect(200);
    expect(draft.body.rows).toHaveLength(1);
    expect(draft.body.totals.rollCount).toBe(1);
    expect(draft.body.collectedBy).toContain('Склад');
    const printers = await http().get('/api/warehouse/printers').set(asWarehouse).expect(200);
    const readyPrinter = (
      printers.body as Array<{
        id: string;
        ready: boolean;
        post: { code: string };
      }>
    ).find((printer) => printer.ready && printer.post.code === 'POST-1');
    expect(readyPrinter).toBeTruthy();
    const requestId = randomUUID();
    const closeAndPrint = () =>
      http()
        .post(`/api/warehouse/intake/${intakeTask.taskId}/pallets/current/close-and-print`)
        .set(asWarehouse)
        .send({ printerId: readyPrinter!.id, requestId })
        .expect(200);
    const sealedPallet = await closeAndPrint();
    const sealedPalletReplay = await closeAndPrint();
    expect(sealedPallet.body).toEqual(
      expect.objectContaining({
        pallet: expect.objectContaining({ status: 'sealed', rollCount: 1 }),
        document: expect.objectContaining({ printStatus: 'submitted' }),
        printJob: expect.objectContaining({
          requestId,
          printerId: readyPrinter!.id,
          status: 'submitted',
        }),
      }),
    );
    expect(sealedPalletReplay.body).toEqual(sealedPallet.body);

    const automaticDelivery = await prisma.warehouseAcceptanceTask.findUniqueOrThrow({
      where: { deliveryScopeKey: `warehouse_delivery:${commercial.body.id as string}` },
      include: { rows: true },
    });
    expect(automaticDelivery).toMatchObject({
      mode: 'delivery',
      status: 'open',
      orderId: commercial.body.id,
      rows: [expect.objectContaining({ rollCode: rollOne, scanStatus: 'expected' })],
    });

    // --- Partial close: one received roll cannot close the three-roll order ----
    const incompleteFullClose = await http()
      .post(`/api/warehouse/tasks/${intakeTask.taskId}/close`)
      .set(asWarehouse)
      .send({ mode: 'full' })
      .expect(409);
    expect(incompleteFullClose.body).toEqual(
      expect.objectContaining({
        code: 'WAREHOUSE_ORDER_INTAKE_INCOMPLETE',
        missingRollCodes: [rollTwo, rollThree],
      }),
    );
    await http()
      .post(`/api/warehouse/tasks/${intakeTask.taskId}/close`)
      .set(asWarehouse)
      .send({ mode: 'partial' })
      .expect(201);

    const warehouseAfterClose = await prisma.warehouseRoll.findUniqueOrThrow({
      where: { rollCode: rollOne },
    });
    const rowCountAfterClose = await prisma.scanRow.count({
      where: { taskId: intakeTask.taskId, rollCode: rollOne },
    });
    const handoverEventsAfterClose = await prisma.domainEvent.count({
      where: {
        type: 'audit:operator_roll_handed_over',
        detail: { path: ['rollId'], equals: rollOne },
      },
    });
    await http()
      .post(`/api/operator/rolls/${rollOne}/handover`)
      .set(asOperator)
      .send({ operationKey: handoverKey })
      .expect(201);
    await expect(
      prisma.warehouseRoll.findUniqueOrThrow({ where: { rollCode: rollOne } }),
    ).resolves.toMatchObject({ warehouseStatus: warehouseAfterClose.warehouseStatus });
    expect(warehouseAfterClose.warehouseStatus).not.toBe('sent');
    await expect(
      prisma.scanRow.count({ where: { taskId: intakeTask.taskId, rollCode: rollOne } }),
    ).resolves.toBe(rowCountAfterClose);
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:operator_roll_handed_over',
          detail: { path: ['rollId'], equals: rollOne },
        },
      }),
    ).resolves.toBe(handoverEventsAfterClose);

    const assertOwnedByActivePost = async (rollCode: string) => {
      const [activeSession, dispatch] = await Promise.all([
        prisma.operatorPostSession.findFirst({
          where: { operatorId, status: 'active', post: { status: 'active' } },
          include: { post: true },
        }),
        prisma.rollDispatchItem.findUniqueOrThrow({
          where: { rollCode },
          include: { productionOrder: true },
        }),
      ]);
      expect(activeSession).toMatchObject({ operatorId, post: { code: 'POST-1' } });
      expect(dispatch).toMatchObject({
        assignedOperatorId: operatorId,
        postId: activeSession?.postId,
        productionOrder: { approvalState: 'approved' },
      });
    };

    // --- Roll 2: blocking defect → problem → production lead resolves rework --
    await assertOwnedByActivePost(rollTwo);
    await http()
      .post(`/api/operator/rolls/${rollTwo}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollTwo}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollTwo}/defects`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const problems = await http()
      .get('/api/production/problems?status=open')
      .set(asProduction)
      .expect(200);
    const defectProblem = problems.body.find(
      (problem: { rollId: string | null; type: string }) =>
        problem.rollId === rollTwo && problem.type === 'defect',
    );
    expect(defectProblem).toBeTruthy();
    const resolved = await http()
      .post(`/api/production/problems/${defectProblem.id}/resolve`)
      .set(asProduction)
      .send({ resolution: 'rework', note: 'Перезапуск рулона после подтверждённого брака' })
      .expect(201);
    expect(resolved.body.replacementRollCode).toBe(`${rollTwo}-R1`);
    await http()
      .post(`/api/operator/rolls/${rollTwo}/resume`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(409);
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { rollCode: rollTwo } }),
    ).resolves.toMatchObject({ status: 'defect' });
    await expect(
      prisma.operatorRollLine.findFirstOrThrow({
        where: { rollDispatchItem: { rollCode: rollTwo } },
      }),
    ).resolves.toMatchObject({ step: 'defect' });
    await expect(
      prisma.rollDispatchItem.count({ where: { rollCode: `${rollTwo}-R1` } }),
    ).resolves.toBe(1);

    const assertTerminalDefectRejected = async (rollCode: string) => {
      const lineBefore = await prisma.operatorRollLine.findFirstOrThrow({
        where: { rollDispatchItem: { rollCode } },
      });
      const dispatchBefore = await prisma.rollDispatchItem.findUniqueOrThrow({
        where: { rollCode },
      });
      const replacementBefore = await prisma.rollDispatchItem.findUnique({
        where: { rollCode: `${rollCode}-R1` },
      });
      const defectCountBefore = await prisma.defectRecord.count({
        where: { operatorRollLineId: lineBefore.id },
      });
      const problemCountBefore = await prisma.productionProblem.count({
        where: { rollId: rollCode },
      });
      const eventCountBefore = await prisma.domainEvent.count();
      const operationKey = randomUUID();

      const rejected = await http()
        .post(`/api/operator/rolls/${rollCode}/defects`)
        .set(asOperator)
        .send({ operationKey })
        .expect(409);
      expect(rejected.body).toEqual(
        expect.objectContaining({ code: 'OPERATOR_DISPATCH_TERMINAL' }),
      );
      await expect(
        prisma.operatorRollLine.findFirstOrThrow({ where: { id: lineBefore.id } }),
      ).resolves.toEqual(lineBefore);
      await expect(
        prisma.rollDispatchItem.findUniqueOrThrow({ where: { rollCode } }),
      ).resolves.toEqual(dispatchBefore);
      await expect(
        prisma.rollDispatchItem.findUnique({ where: { rollCode: `${rollCode}-R1` } }),
      ).resolves.toEqual(replacementBefore);
      await expect(
        prisma.defectRecord.count({ where: { operatorRollLineId: lineBefore.id } }),
      ).resolves.toBe(defectCountBefore);
      await expect(prisma.productionProblem.count({ where: { rollId: rollCode } })).resolves.toBe(
        problemCountBefore,
      );
      await expect(prisma.domainEvent.count()).resolves.toBe(eventCountBefore);
      await expect(prisma.operatorRollOperation.count({ where: { operationKey } })).resolves.toBe(
        0,
      );
    };

    await assertTerminalDefectRejected(rollTwo);

    // --- Roll 3: writeoff is terminal and cannot be reopened by the operator --
    await assertOwnedByActivePost(rollThree);
    await http()
      .post(`/api/operator/rolls/${rollThree}/accept`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollThree}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${rollThree}/defects`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const writeoffProblems = await http()
      .get('/api/production/problems?status=open')
      .set(asProduction)
      .expect(200);
    const writeoffProblem = writeoffProblems.body.find(
      (problem: { rollId: string | null; type: string }) =>
        problem.rollId === rollThree && problem.type === 'defect',
    );
    expect(writeoffProblem).toBeTruthy();
    await http()
      .post(`/api/production/problems/${writeoffProblem.id}/resolve`)
      .set(asProduction)
      .send({ resolution: 'writeoff', note: 'Списание подтверждённого брака' })
      .expect(201);
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { rollCode: rollThree } }),
    ).resolves.toMatchObject({ status: 'defect' });
    await expect(
      prisma.rollDispatchItem.count({ where: { rollCode: `${rollThree}-R1` } }),
    ).resolves.toBe(1);
    await assertTerminalDefectRejected(rollThree);

    const secondary = await http().get('/api/warehouse/raw-materials').set(asWarehouse).expect(200);
    const recycled = secondary.body.find(
      (m: { materialId: string }) => m.materialId === 'rm-secondary-pvd-15803',
    );
    expect(recycled).toBeTruthy();
    expect(recycled.actualQty).toBeGreaterThanOrEqual(41);

    // --- Defect handoff gate, then shift close and warehouse logistics --------
    const weighedDefectBag = await http()
      .post('/api/operator/shift/defect-bag/weigh')
      .set(asOperator)
      .send({ operationKey: randomUUID(), defectType: 'aika', weightKg: 41 })
      .expect(200);
    expect(weighedDefectBag.body).toEqual(
      expect.objectContaining({
        status: 'weighed',
        defectType: 'aika',
        weightKg: 41,
        labelState: 'not_printed',
      }),
    );
    expect(JSON.stringify(weighedDefectBag.body)).not.toContain('bbt_');
    await expect(
      prisma.defectBag.findUniqueOrThrow({ where: { id: weighedDefectBag.body.id } }),
    ).resolves.toEqual(
      expect.objectContaining({
        captureChannel: 'operator_manual',
        defectType: 'aika',
        scaleDeviceId: null,
        scaleStatus: null,
        scaleStable: null,
      }),
    );
    const closeBeforeDefectLabel = await http()
      .post('/api/operator/shift/close')
      .set(asOperator)
      .send({ operationKey: randomUUID(), bags: [{ bigBagId: pickable.id, endKg: 150 }] })
      .expect(409);
    expect(closeBeforeDefectLabel.body).toEqual(
      expect.objectContaining({ code: 'DEFECT_BAG_LABEL_REQUIRED' }),
    );
    const printedDefectBag = await http()
      .post('/api/operator/shift/defect-bag/print')
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(200);
    expect(printedDefectBag.body).toEqual(
      expect.objectContaining({ status: 'ready_for_warehouse', labelState: 'submitted' }),
    );
    expect(JSON.stringify(printedDefectBag.body)).not.toContain('bbt_');

    const secondBagRequest = { operationKey: randomUUID(), defectType: 'aika', weightKg: 41 };
    const secondBag = await http()
      .post('/api/operator/shift/defect-bag/weigh')
      .set(asOperator)
      .send(secondBagRequest)
      .expect(200);
    const replayedBag = await http()
      .post('/api/operator/shift/defect-bag/weigh')
      .set(asOperator)
      .send(secondBagRequest)
      .expect(200);
    expect(replayedBag.body.id).toBe(secondBag.body.id);
    expect(secondBag.body.id).not.toBe(printedDefectBag.body.id);
    expect(secondBag.body.code).not.toBe(printedDefectBag.body.code);
    const ambiguousPrint = await http()
      .post('/api/operator/shift/defect-bag/print')
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(409);
    expect(ambiguousPrint.body.code).toBe('DEFECT_BAG_SELECTION_REQUIRED');
    const blockedClose = await http()
      .post('/api/operator/shift/close')
      .set(asOperator)
      .send({ operationKey: randomUUID(), bags: [{ bigBagId: pickable.id, endKg: 150 }] })
      .expect(409);
    expect(blockedClose.body.code).toBe('DEFECT_BAG_LABEL_REQUIRED');
    const secondPrint = await http()
      .post('/api/operator/shift/defect-bag/print')
      .set(asOperator)
      .send({ operationKey: randomUUID(), defectBagId: secondBag.body.id })
      .expect(200);
    expect(secondPrint.body).toMatchObject({
      id: secondBag.body.id,
      status: 'ready_for_warehouse',
    });
    const runtimeWithBags = await http().get('/api/operator/runtime').set(asOperator).expect(200);
    expect(runtimeWithBags.body.shift.defectBags.map((bag: { id: string }) => bag.id)).toEqual([
      printedDefectBag.body.id,
      secondBag.body.id,
    ]);
    expect(runtimeWithBags.body.shift.defectBag.id).toBe(printedDefectBag.body.id);
    expect(JSON.stringify(runtimeWithBags.body)).not.toContain('bbt_');

    const zeroBag = await http()
      .post('/api/operator/shift/defect-bag/weigh')
      .set(asOperator)
      .send({ operationKey: randomUUID(), weightKg: 0 })
      .expect(200);
    expect(zeroBag.body).toMatchObject({
      weightKg: 0,
      defectType: null,
      status: 'weighed',
      labelState: 'not_printed',
    });
    await expect(
      prisma.defectBagScanToken.findUnique({
        where: { defectBagId: zeroBag.body.id },
      }),
    ).resolves.toBeNull();
    const zeroPrint = await http()
      .post('/api/operator/shift/defect-bag/print')
      .set(asOperator)
      .send({ operationKey: randomUUID(), defectBagId: zeroBag.body.id })
      .expect(409);
    expect(zeroPrint.body.code).toBe('DEFECT_BAG_ZERO_WEIGHT_NO_PRINT');
    expect(
      await prisma.defectBagLabelPrintJob.count({
        where: { defectBagId: zeroBag.body.id },
      }),
    ).toBe(0);

    const closed = await http()
      .post('/api/operator/shift/close')
      .set(asOperator)
      .send({ operationKey: randomUUID(), bags: [{ bigBagId: pickable.id, endKg: 150 }] })
      .expect(200);
    expect(closed.body.balance.actualUsageKg).toBe(50);
    expect(closed.body.balance.status).toBe('mismatch');
    expect(closed.body.problemId).toBeTruthy();

    const defectBagId = printedDefectBag.body.id as string;
    const defectBagToken = await prisma.defectBagScanToken.findUniqueOrThrow({
      where: { defectBagId },
      select: { token: true },
    });
    const receivingDefectBags = await http()
      .get('/api/warehouse/defect-bags?mode=receiving')
      .set(asWarehouse)
      .expect(200);
    expect(receivingDefectBags.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defectBagId,
          status: 'ready_for_warehouse',
          defectType: 'aika',
        }),
      ]),
    );
    expect(JSON.stringify(receivingDefectBags.body)).not.toContain('bbt_');

    const receiveOperationKey = randomUUID();
    const receivePayload = { operationKey: receiveOperationKey, payload: defectBagToken.token };
    const receivedDefectBag = await http()
      .post('/api/warehouse/defect-bags/receipts')
      .set(asWarehouse)
      .send(receivePayload)
      .expect(200);
    const receivedDefectBagReplay = await http()
      .post('/api/warehouse/defect-bags/receipts')
      .set(asWarehouse)
      .send(receivePayload)
      .expect(200);
    expect(receivedDefectBag.body).toEqual(
      expect.objectContaining({ id: defectBagId, status: 'received', defectType: 'aika' }),
    );
    expect(receivedDefectBagReplay.body).toEqual(receivedDefectBag.body);

    const shippingDefectBags = await http()
      .get('/api/warehouse/defect-bags?mode=shipping')
      .set(asWarehouse)
      .expect(200);
    expect(shippingDefectBags.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: defectBagId, status: 'received', defectType: 'aika' }),
      ]),
    );
    const shipOperationKey = randomUUID();
    const shipPayload = { operationKey: shipOperationKey, payload: defectBagToken.token };
    const shippedDefectBag = await http()
      .post('/api/warehouse/defect-bags/shipments')
      .set(asWarehouse)
      .send(shipPayload)
      .expect(200);
    const shippedDefectBagReplay = await http()
      .post('/api/warehouse/defect-bags/shipments')
      .set(asWarehouse)
      .send(shipPayload)
      .expect(200);
    expect(shippedDefectBag.body).toEqual(
      expect.objectContaining({ id: defectBagId, status: 'shipped', defectType: 'aika' }),
    );
    expect(shippedDefectBagReplay.body).toEqual(shippedDefectBag.body);

    const balanceProblems = await http()
      .get('/api/production/problems?status=open')
      .set(asProduction)
      .expect(200);
    expect(
      balanceProblems.body.some(
        (problem: { type: string }) => problem.type === 'shift_balance_mismatch',
      ),
    ).toBe(true);

    if (primaryStockDefinitionId === undefined) {
      throw new Error('Primary stock definition linkage was not captured');
    }
    const originalDefinitionId = primaryStockDefinitionId;
    await prisma.rawMaterialStock.update({
      where: { materialId: 'rm-pvd-15803' },
      data: { rawMaterialDefinitionId: originalDefinitionId },
    });
    await expect(
      prisma.rawMaterialStock.findUniqueOrThrow({
        where: { materialId: 'rm-pvd-15803' },
        select: { rawMaterialDefinitionId: true },
      }),
    ).resolves.toEqual({ rawMaterialDefinitionId: originalDefinitionId });
    primaryStockDefinitionId = undefined;
  });
});
