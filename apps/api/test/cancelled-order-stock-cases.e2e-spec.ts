import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RollTokenService } from '../src/common/roll-token/roll-token.service';
import { WarehouseRollCoverageFactService } from '../src/modules/warehouse-coverage/warehouse-roll-coverage-fact.service';
import { deliverWarehouseRoll } from '../src/modules/warehouse/warehouse-delivery-roll-transition';
import { PRIMARY_BASE_MATERIAL_SELECTION } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Cancelled order stock boundaries (PostgreSQL + Bearer)', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let prisma: PrismaService;
  let facts: WarehouseRollCoverageFactService;
  const headers: Record<string, Record<string, string>> = {};
  const http = () => request(app.getHttpServer());
  const previousFlag = process.env.WAREHOUSE_COVERAGE_V2_ENABLED;

  beforeAll(async () => {
    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'true';
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    prisma = module.get(PrismaService);
    facts = module.get(WarehouseRollCoverageFactService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
    for (const role of [
      'commercial',
      'finance',
      'warehouse',
      'operator',
      'production',
      'director',
      'admin',
    ] as const) {
      const login = await http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(role), password: e2eSeedPassword() })
        .expect(201);
      headers[role] = { Authorization: `Bearer ${login.body.token}` };
    }
  });

  afterAll(async () => {
    await app?.close();
    if (previousFlag === undefined) delete process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
    else process.env.WAREHOUSE_COVERAGE_V2_ENABLED = previousFlag;
  });

  function specification() {
    return {
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      ...PRIMARY_BASE_MATERIAL_SELECTION,
      widthMm: 1500,
      plannedLengthM: 300,
      spoolType: '76 мм',
      birka: `CANCEL-BOUNDARY-${randomUUID()}`,
      plannedWeightKg: 50,
    };
  }

  async function createOrder(
    rollCount: number,
    spec: ReturnType<typeof specification>,
    additionalPositions: Array<ReturnType<typeof specification> & { rollCount: number }> = [],
  ) {
    const counterparty = await prisma.counterparty.create({ data: { displayName: randomUUID() } });
    const response = await http()
      .post('/api/commercial/orders')
      .set(headers.commercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        requestType: 'client_order',
        counterpartyId: counterparty.id,
        positions: [{ ...spec, rollCount }, ...additionalPositions],
      })
      .expect(201);
    await http()
      .post(`/api/commercial/orders/${response.body.id}/invoice-handoff`)
      .set(headers.commercial)
      .send({})
      .expect(201);
    return prisma.commercialOrder.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { financeOrder: true },
    });
  }

  async function stock(
    total: number,
    made: number,
    warehouseStatus = 'received',
    spec = specification(),
  ) {
    const order = await createOrder(total, spec);
    await http()
      .post(`/api/finance/orders/${order.financeOrder!.id}/invoices`)
      .set(headers.finance)
      .send({ amount: 125000, paymentTermsType: 'postpay_100_30d' })
      .expect(201);
    await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(headers.commercial)
      .send({})
      .expect(201);
    const production = await prisma.productionOrder.findUniqueOrThrow({
      where: { commercialOrderId: order.id },
      include: { dispatchItems: true },
    });
    const operator = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
    });
    const rolls: Array<{ id: string; code: string; lineId: string; factId: string }> = [];
    for (const dispatch of production.dispatchItems.slice(0, made)) {
      rolls.push(
        await prisma.$transaction(async (tx) => {
          await tx.rollDispatchItem.update({
            where: { id: dispatch.id },
            data: { status: 'ready_for_warehouse', completedAt: new Date() },
          });
          const line = await tx.operatorRollLine.upsert({
            where: { rollDispatchItemId: dispatch.id },
            create: {
              rollDispatchItemId: dispatch.id,
              step: 'warehouse',
              warehouseState: warehouseStatus,
              netKg: 50,
            },
            update: { step: 'warehouse', warehouseState: warehouseStatus, netKg: 50 },
          });
          const capture = await tx.weightCapture.create({
            data: {
              operatorRollLineId: line.id,
              kind: 'roll',
              stable: true,
              grossKg: 52,
              spoolKg: 2,
              netKg: 50,
              deviceStatus: 'ready',
              actorRole: 'operator',
              actorId: operator.id,
            },
          });
          const roll = await tx.warehouseRoll.create({
            data: {
              rollCode: dispatch.rollCode,
              ownerCounterpartyId: order.counterpartyId,
              warehouseStatus,
              receivedAt: warehouseStatus === 'received' ? new Date() : null,
            },
          });
          const fact = await facts.appendProductionHandoverFact(tx, {
            rollId: roll.id,
            sourceDispatchItemId: dispatch.id,
            sourceWeightCaptureId: capture.id,
          });
          expect(fact).not.toBeNull();
          await tx.warehouseRoll.update({
            where: { id: roll.id },
            data: {
              producedForOrderId: order.id,
              producedForPositionId: dispatch.orderLineId,
              producedByCoverageDecisionId: production.sourceCoverageDecisionId,
            },
          });
          return { id: roll.id, code: roll.rollCode, lineId: line.id, factId: fact!.factId };
        }),
      );
    }
    return { order, production, spec, rolls };
  }

  async function cancellationCommand(orderId: string, reason = 'Клиент отменил заказ') {
    const order = await prisma.commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
    return { operationKey: randomUUID(), expectedVersion: order.version, reason };
  }

  async function cancel(orderId: string) {
    return http()
      .post(`/api/commercial/orders/${orderId}/cancellations`)
      .set(headers.commercial)
      .send(await cancellationCommand(orderId))
      .expect(201);
  }

  async function availability(order: Awaited<ReturnType<typeof createOrder>>) {
    return http()
      .get(`/api/finance/orders/${order.financeOrder!.id}/warehouse-coverage`)
      .set(headers.finance)
      .expect(200);
  }

  async function reserve(order: Awaited<ReturnType<typeof createOrder>>) {
    expect((await availability(order)).body.availability).toBe('verified_full');
    const state = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    return http()
      .post(`/api/finance/orders/${order.financeOrder!.id}/warehouse-coverage/decide`)
      .set(headers.finance)
      .send({
        clientRequestId: randomUUID(),
        decision: 'use_warehouse',
        expectedGeneration: state.generation,
        expectedStateVersion: state.stateVersion,
      })
      .expect(200);
  }

  it.each([0, 1, 30])(
    'preserves exactly %i manufactured rolls when cancelling a 30-roll order',
    async (made) => {
      const { order, production, rolls } = await stock(30, made);
      const result = await cancel(order.id);
      expect(result.body).toMatchObject({
        completedRollCount: made,
        remainingCancelledRollCount: 30 - made,
      });
      expect(
        await prisma.rollDispatchItem.count({
          where: { productionOrderId: production.id, status: 'cancelled' },
        }),
      ).toBe(30 - made);
      expect(
        await prisma.warehouseRoll.count({
          where: {
            releasedFromOrderId: order.id,
            ownerCounterpartyId: null,
            reservedForOrderId: null,
          },
        }),
      ).toBe(made);
      expect(
        await prisma.warehouseRollCoverageFact.count({
          where: { id: { in: rolls.map((roll) => roll.factId) } },
        }),
      ).toBe(made);
    },
  );

  it('rejects all other roles, stale versions and divergent idempotent payloads without changing stock', async () => {
    const { order } = await stock(2, 1);
    const command = await cancellationCommand(order.id);
    for (const role of ['finance', 'warehouse', 'operator', 'production', 'director', 'admin']) {
      await http()
        .post(`/api/commercial/orders/${order.id}/cancellations`)
        .set(headers[role])
        .send(command)
        .expect(403);
    }
    await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send({ ...command, expectedVersion: command.expectedVersion + 1 })
      .expect(409);
    expect(await prisma.warehouseRoll.count({ where: { releasedFromOrderId: order.id } })).toBe(0);
    const result = await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send(command)
      .expect(201);
    const replay = await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send(command)
      .expect(201);
    expect(replay.body).toEqual(result.body);
    await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send({ ...command, reason: 'Другая причина отмены' })
      .expect(409);
  });

  it.each(['', '  ', 'x', 'от', ' от ', 'x'.repeat(501)])(
    'rejects invalid reason %j before any mutation',
    async (reason) => {
      const { order } = await stock(2, 1);
      const command = await cancellationCommand(order.id, reason);
      await http()
        .post(`/api/commercial/orders/${order.id}/cancellations`)
        .set(headers.commercial)
        .send(command)
        .expect(400);
      expect(await prisma.commercialOrder.findUnique({ where: { id: order.id } })).toMatchObject({
        cancellationStatus: 'active',
        version: command.expectedVersion,
      });
      expect(await prisma.warehouseRoll.count({ where: { releasedFromOrderId: order.id } })).toBe(
        0,
      );
    },
  );

  it.each(['  нет  ', 'x'.repeat(500)])('accepts valid reason boundary %j', async (reason) => {
    const { order } = await stock(2, 1);
    await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send(await cancellationCommand(order.id, reason))
      .expect(201);
    expect(
      await prisma.warehouseRollCoverageFact.findFirstOrThrow({
        where: { sourceOrderId: order.id, source: 'order_cancellation' },
      }),
    ).toMatchObject({ reason: reason.trim() });
  });

  it.each([true, false])(
    'settles concurrent cancellations once (same operation key: %s)',
    async (sameKey) => {
      const { order } = await stock(3, 2);
      const command = await cancellationCommand(order.id);
      const results = await Promise.all(
        [command, { ...command, operationKey: sameKey ? command.operationKey : randomUUID() }].map(
          (body) =>
            http()
              .post(`/api/commercial/orders/${order.id}/cancellations`)
              .set(headers.commercial)
              .send(body),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual(
        sameKey ? [201, 201] : [201, 409],
      );
      if (sameKey) expect(results[0].body).toEqual(results[1].body);
      expect(
        await prisma.warehouseRollCoverageFact.count({
          where: { sourceOrderId: order.id, source: 'order_cancellation' },
        }),
      ).toBe(2);
      expect(
        await prisma.commercialOrderAmendmentCommand.count({
          where: { orderId: order.id, kind: 'cancel_order' },
        }),
      ).toBe(1);
    },
  );

  it('rolls back the order, unfinished work and stock when ownership release fails', async () => {
    const { order, production } = await stock(3, 1);
    const command = await cancellationCommand(order.id);
    const release = jest
      .spyOn(facts, 'releaseCancelledOrderRolls')
      .mockRejectedValueOnce(new Error('Injected transactional release failure'));
    try {
      await http()
        .post(`/api/commercial/orders/${order.id}/cancellations`)
        .set(headers.commercial)
        .send(command)
        .expect(500);
    } finally {
      release.mockRestore();
    }
    expect(await prisma.commercialOrder.findUnique({ where: { id: order.id } })).toMatchObject({
      cancellationStatus: 'active',
      version: command.expectedVersion,
    });
    expect(
      await prisma.rollDispatchItem.count({
        where: { productionOrderId: production.id, status: 'cancelled' },
      }),
    ).toBe(0);
    expect(
      await prisma.commercialOrderAmendmentCommand.count({
        where: { operationKey: command.operationKey },
      }),
    ).toBe(0);
    expect(await prisma.warehouseRoll.count({ where: { releasedFromOrderId: order.id } })).toBe(0);
    await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send(command)
      .expect(201);
  });

  it('excludes insufficient, incompatible, defective and already reserved released stock', async () => {
    const { order, spec, rolls } = await stock(3, 3);
    await cancel(order.id);
    const shortage = await createOrder(4, spec);
    expect((await availability(shortage)).body.availability).not.toBe('verified_full');
    const wrongSpec = await createOrder(3, { ...spec, widthMm: 1700 });
    expect((await availability(wrongSpec)).body.availability).not.toBe('verified_full');
    await prisma.defectRecord.create({
      data: {
        operatorRollLineId: rolls[0].lineId,
        sourceRole: 'warehouse',
        comment: 'Повреждён на складе',
        blocking: true,
      },
    });
    const blocked = await createOrder(3, spec);
    expect((await availability(blocked)).body.availability).not.toBe('verified_full');
    const first = await createOrder(2, spec);
    await reserve(first);
    expect(await prisma.warehouseRoll.count({ where: { reservedForOrderId: first.id } })).toBe(2);
    expect(
      (await prisma.warehouseRoll.findUniqueOrThrow({ where: { id: rolls[0].id } }))
        .reservedForOrderId,
    ).toBeNull();
    const second = await createOrder(2, spec);
    expect((await availability(second)).body.availability).not.toBe('verified_full');
    await cancel(first.id);
    const stale = (await availability(second)).body;
    expect(stale).toMatchObject({ stale: true, availableActions: ['refresh'] });
    await http()
      .post(`/api/finance/orders/${second.financeOrder!.id}/warehouse-coverage/refresh`)
      .set(headers.finance)
      .send({
        clientRequestId: randomUUID(),
        expectedGeneration: stale.generation,
        expectedStateVersion: stale.stateVersion,
      })
      .expect(200);
    await reserve(second);
    expect(await prisma.warehouseRoll.count({ where: { reservedForOrderId: second.id } })).toBe(2);
  });

  it('covers multiple positions from several cancelled orders without changing their origins', async () => {
    const first = await stock(2, 2);
    const second = await stock(1, 1, 'received', first.spec);
    const third = await stock(1, 1);
    await cancel(first.order.id);
    await cancel(second.order.id);
    await cancel(third.order.id);
    const next = await createOrder(3, first.spec, [{ ...third.spec, rollCount: 1 }]);
    await reserve(next);
    const reserved = await prisma.warehouseRoll.findMany({
      where: { reservedForOrderId: next.id },
    });
    expect(reserved).toHaveLength(4);
    const matches = await prisma.warehouseCoverageMatch.findMany({
      where: { orderId: next.id },
    });
    expect(matches).toHaveLength(4);
    expect(new Set(matches.map((match) => match.positionId)).size).toBe(2);
    expect(new Set(reserved.map((roll) => roll.releasedFromOrderId))).toEqual(
      new Set([first.order.id, second.order.id, third.order.id]),
    );
    expect(reserved.every((roll) => roll.producedForOrderId === roll.releasedFromOrderId)).toBe(
      true,
    );
    await cancel(next.id);
    expect(await prisma.warehouseRoll.count({ where: { reservedForOrderId: next.id } })).toBe(0);
    expect(await prisma.warehouseRoll.count({ where: { releasedFromOrderId: next.id } })).toBe(0);
  });

  it('lets only one concurrent order reserve the same released stock', async () => {
    const { order, spec, rolls } = await stock(2, 2);
    await cancel(order.id);
    const contenders = [await createOrder(2, spec), await createOrder(2, spec)];
    const commands = await Promise.all(
      contenders.map(async (contender) => {
        const projection = (await availability(contender)).body;
        expect(projection.availability).toBe('verified_full');
        return {
          clientRequestId: randomUUID(),
          decision: 'use_warehouse',
          expectedGeneration: projection.generation,
          expectedStateVersion: projection.stateVersion,
        };
      }),
    );
    const results = await Promise.all(
      contenders.map((contender, index) =>
        http()
          .post(`/api/finance/orders/${contender.financeOrder!.id}/warehouse-coverage/decide`)
          .set(headers.finance)
          .send(commands[index]),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = contenders[results.findIndex((result) => result.status === 200)];
    expect(
      await prisma.warehouseRoll.count({
        where: { id: { in: rolls.map((roll) => roll.id) }, reservedForOrderId: winner.id },
      }),
    ).toBe(2);
    expect(
      await prisma.warehouseRollCoverageFact.count({
        where: { sourceOrderId: order.id, source: 'order_cancellation' },
      }),
    ).toBe(2);
  });

  it('allows delivery only for the new reservation and rejects cancellation after partial shipment', async () => {
    const { order, spec, rolls } = await stock(2, 2);
    await cancel(order.id);
    const next = await createOrder(2, spec);
    await reserve(next);
    await expect(
      prisma.$transaction((tx) =>
        deliverWarehouseRoll(
          tx,
          { mode: 'delivery', orderId: order.id, positionId: null },
          rolls[0].code,
        ),
      ),
    ).rejects.toThrow();
    await prisma.$transaction((tx) =>
      deliverWarehouseRoll(
        tx,
        { mode: 'delivery', orderId: next.id, positionId: null },
        rolls[0].code,
      ),
    );
    await http()
      .post(`/api/commercial/orders/${next.id}/cancellations`)
      .set(headers.commercial)
      .send(await cancellationCommand(next.id))
      .expect(409);
    expect(await prisma.commercialOrder.findUnique({ where: { id: next.id } })).toMatchObject({
      cancellationStatus: 'active',
    });
    expect(await prisma.warehouseRoll.count({ where: { reservedForOrderId: next.id } })).toBe(2);
  });

  async function awaitingHandover() {
    const fixture = await stock(2, 0);
    const passwordSource = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
    });
    const operator = await prisma.user.create({
      data: {
        login: randomUUID(),
        displayName: 'Оператор проверки',
        role: 'operator',
        passwordHash: passwordSource.passwordHash,
      },
    });
    const login = await http()
      .post('/api/auth/login')
      .send({ login: operator.login, password: e2eSeedPassword() })
      .expect(201);
    const post = await prisma.post.create({
      data: { code: randomUUID(), name: 'Проверка отмены', status: 'active' },
    });
    const shift = await prisma.shift.create({
      data: { label: randomUUID(), status: 'open', startedAt: new Date() },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        operatorId: operator.id,
        postId: post.id,
        shiftId: shift.id,
        status: 'locked',
        lockedAt: new Date(),
      },
    });
    const session = await prisma.operatorPostSession.create({
      data: { operatorId: operator.id, postId: post.id, shiftId: shift.id, status: 'active' },
    });
    const bag = await prisma.bigBagUnit.create({
      data: {
        code: randomUUID(),
        material: 'ПВД',
        status: 'in_use',
        initialKg: 100,
        currentKg: 100,
        lastMeasuredKg: 100,
        lastActorRole: 'operator',
        machineId: post.code,
        createdByRole: 'warehouse',
      },
    });
    await prisma.shiftBagUsage.create({
      data: { sessionId: session.id, bigBagId: bag.id, startKg: 100 },
    });
    const dispatch = fixture.production.dispatchItems[0];
    await prisma.rollDispatchItem.update({
      where: { id: dispatch.id },
      data: {
        status: 'assigned',
        assignedOperatorId: operator.id,
        postId: post.id,
        plannedShiftId: shift.id,
      },
    });
    const lineData = {
      step: 'handover',
      labelState: 'verified',
      warehouseState: 'not_ready',
      spoolKg: 2,
      grossKg: 52,
      netKg: 50,
      toleranceOk: true,
    };
    const line = await prisma.operatorRollLine.upsert({
      where: { rollDispatchItemId: dispatch.id },
      create: { rollDispatchItemId: dispatch.id, ...lineData },
      update: lineData,
    });
    await prisma.weightCapture.create({
      data: {
        operatorRollLineId: line.id,
        kind: 'roll',
        stable: true,
        grossKg: 52,
        spoolKg: 2,
        netKg: 50,
        toleranceOk: true,
        deviceStatus: 'ready',
        actorRole: 'operator',
        actorId: operator.id,
        postId: post.id,
        postSessionId: session.id,
      },
    });
    return {
      ...fixture,
      dispatch,
      line,
      operator,
      post,
      session,
      auth: { Authorization: `Bearer ${login.body.token}` },
    };
  }

  it('preserves a weighed roll before handover, releases it on late handover, and accepts it exactly once', async () => {
    const fixture = await awaitingHandover();
    const { order, dispatch, auth } = fixture;
    await cancel(order.id);
    await http().delete(`/api/commercial/orders/${order.id}`).set(headers.commercial).expect(409);
    await http()
      .post(`/api/operator/rolls/${dispatch.rollCode}/step-back`)
      .set(auth)
      .send({ operationKey: randomUUID() })
      .expect(409);
    const operationKey = randomUUID();
    const handover = await http()
      .post(`/api/operator/rolls/${dispatch.rollCode}/handover`)
      .set(auth)
      .send({ operationKey })
      .expect(201);
    const replay = await http()
      .post(`/api/operator/rolls/${dispatch.rollCode}/handover`)
      .set(auth)
      .send({ operationKey })
      .expect(201);
    expect(replay.body).toEqual(handover.body);
    expect(
      await prisma.warehouseRoll.findUnique({ where: { rollCode: dispatch.rollCode } }),
    ).toMatchObject({
      warehouseStatus: 'sent',
      releasedFromOrderId: order.id,
      ownerCounterpartyId: null,
      producedForOrderId: order.id,
    });
    const stockBefore = await http()
      .get('/api/warehouse/finished-stock')
      .query({ q: dispatch.rollCode })
      .set(headers.warehouse)
      .expect(200);
    expect(stockBefore.body.summary.totalCount).toBe(0);
    const label = await app.get(RollTokenService).getOrCreate(dispatch.rollCode);
    await prisma.deviceRuntime.update({
      where: { id: 'dev-scanner-1' },
      data: { status: 'ready', isEnabled: true },
    });
    const scanKey = randomUUID();
    await http()
      .post(`/api/warehouse/tasks/${handover.body.id}/scans`)
      .set(headers.warehouse)
      .send({ operationKey: scanKey, payload: label.token })
      .expect(201);
    await http()
      .post(`/api/warehouse/tasks/${handover.body.id}/scans`)
      .set(headers.warehouse)
      .send({ operationKey: scanKey, payload: label.token })
      .expect(201);
    const stockAfter = await http()
      .get('/api/warehouse/finished-stock')
      .query({ q: dispatch.rollCode })
      .set(headers.warehouse)
      .expect(200);
    expect(stockAfter.body.summary.totalCount).toBe(1);
    expect(
      await prisma.warehouseRollCoverageFact.count({
        where: { sourceOrderId: order.id, source: 'order_cancellation' },
      }),
    ).toBe(1);
    expect(
      await prisma.warehouseAcceptanceTask.count({
        where: { orderId: order.id, mode: 'delivery', status: { not: 'cancelled' } },
      }),
    ).toBe(0);
  });

  it('rejects cancellation during an unfinished operator operation without losing physical facts', async () => {
    const { order, line, operator, post, session } = await awaitingHandover();
    const operation = await prisma.operatorRollOperation.create({
      data: {
        operationKey: randomUUID(),
        operatorRollLineId: line.id,
        action: 'handover',
        actorId: operator.id,
        postId: post.id,
        postSessionId: session.id,
        requestFingerprint: 'test',
        expectedStep: 'handover',
        status: 'in_progress',
      },
    });
    try {
      await http()
        .post(`/api/commercial/orders/${order.id}/cancellations`)
        .set(headers.commercial)
        .send(await cancellationCommand(order.id))
        .expect(409);
      expect(await prisma.commercialOrder.findUnique({ where: { id: order.id } })).toMatchObject({
        cancellationStatus: 'active',
      });
      expect(
        await prisma.weightCapture.count({ where: { operatorRollLineId: line.id, kind: 'roll' } }),
      ).toBe(1);
    } finally {
      await prisma.operatorRollOperation.update({
        where: { id: operation.id },
        data: { status: 'failed', completedAt: new Date(), errorCode: 'TEST_FINISHED' },
      });
    }
  });
});
