import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorRollOwnershipService } from '../src/modules/operator/operator-roll-ownership.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { enableSimulatedDevices } from './simulated-device-fixture';

describe('Operator roll step back (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let operatorId = '';
  let fixtureSessionId = '';
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    DEVICE_GATEWAY_SCALE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
  } as const;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(flags)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    const ownership = {
      lockOwned: async (
        client: Prisma.TransactionClient,
        actor: { userId: string | null },
        rollCode: string,
      ) => {
        if (!operatorId || actor.userId !== operatorId || !fixtureSessionId) {
          throw new Error('Unexpected operator step-back fixture actor');
        }
        const [session, line] = await Promise.all([
          client.operatorPostSession.findUniqueOrThrow({
            where: { id: fixtureSessionId },
          }),
          client.operatorRollLine.findFirstOrThrow({
            where: { rollDispatchItem: { rollCode } },
            include: {
              rollDispatchItem: {
                include: {
                  productionOrder: {
                    include: {
                      commercialOrder: { include: { counterparty: true } },
                    },
                  },
                },
              },
            },
          }),
        ]);
        return { session, line };
      },
    };

    // Environment-backed integration providers are selected when AppModule is imported.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OperatorRollOwnershipService)
      .useValue(ownership)
      .compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await restoreSimulatedDevices?.();
    await app?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reopens both weight stages, preserves evidence and blocks return after print', async () => {
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-1',
      'dev-printer-1',
    ]);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('operator'), password: e2eSeedPassword() })
      .expect(201);
    operatorId = login.body.user.id as string;
    const asOperator = { Authorization: `Bearer ${login.body.token as string}` };
    const post = await prisma.post.findUniqueOrThrow({
      where: { code: 'POST-1' },
      select: { id: true },
    });
    const session = await prisma.operatorPostSession.create({
      data: {
        operatorId,
        postId: post.id,
        status: 'closed',
        endedAt: new Date(),
      },
    });
    fixtureSessionId = session.id;
    const productionOrder = await prisma.productionOrder.findFirstOrThrow({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const rollCode = `STEP-BACK-${randomUUID().slice(0, 8)}`;
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: productionOrder.id,
        status: 'assigned',
        assignedOperatorId: operatorId,
        postId: post.id,
        plannedWeightKg: 41.4,
      },
    });
    const line = await prisma.operatorRollLine.create({
      data: {
        rollDispatchItemId: dispatch.id,
        planKg: 41.4,
        spoolKg: 2,
        grossKg: 43.4,
        netKg: 41.4,
        toleranceOk: true,
        step: 'qr_print',
        labelState: 'not_printed',
        warehouseState: 'not_ready',
      },
    });
    const capturedAt = new Date();
    await prisma.weightCapture.createMany({
      data: [
        {
          operatorRollLineId: line.id,
          kind: 'spool',
          deviceId: 'dev-scale-1',
          deviceStatus: 'ready',
          stable: true,
          grossKg: 2,
          spoolKg: 2,
          actorRole: 'operator',
          actorId: operatorId,
          postId: post.id,
          postSessionId: session.id,
          createdAt: new Date(capturedAt.getTime() - 2_000),
        },
        {
          operatorRollLineId: line.id,
          kind: 'roll',
          deviceId: 'dev-scale-1',
          deviceStatus: 'ready',
          stable: true,
          grossKg: 43.4,
          spoolKg: 2,
          netKg: 41.4,
          toleranceOk: true,
          actorRole: 'operator',
          actorId: operatorId,
          postId: post.id,
          postSessionId: session.id,
          createdAt: new Date(capturedAt.getTime() - 1_000),
        },
      ],
    });

    const backToRollKey = randomUUID();
    const backToRoll = await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/step-back`)
      .set(asOperator)
      .send({ operationKey: backToRollKey })
      .expect(200);
    expect(backToRoll.body).toEqual({
      rollCode,
      previousStep: 'qr_print',
      step: 'roll_weight',
    });
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/step-back`)
      .set(asOperator)
      .send({ operationKey: backToRollKey })
      .expect(200, backToRoll.body);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: rollCode,
          type: 'audit:operator_roll_step_reopened',
        },
      }),
    ).resolves.toBe(1);

    const backToSpool = await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/step-back`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(200);
    expect(backToSpool.body).toEqual({
      rollCode,
      previousStep: 'roll_weight',
      step: 'spool_weight',
    });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({
        where: { id: line.id },
        select: {
          step: true,
          spoolKg: true,
          grossKg: true,
          netKg: true,
          toleranceOk: true,
        },
      }),
    ).resolves.toEqual({
      step: 'spool_weight',
      spoolKg: null,
      grossKg: null,
      netKg: null,
      toleranceOk: null,
    });

    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/spool-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/roll-weight`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const correctedRollCaptures = await prisma.weightCapture.findMany({
      where: { operatorRollLineId: line.id, kind: 'roll', stable: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, supersedesCaptureId: true },
    });
    expect(correctedRollCaptures).toHaveLength(2);
    expect(correctedRollCaptures[0].supersedesCaptureId).toBeNull();
    expect(correctedRollCaptures[1].supersedesCaptureId).toBe(
      correctedRollCaptures[0].id,
    );
    await expect(
      prisma.weightCapture.count({
        where: { operatorRollLineId: line.id, kind: 'spool', stable: true },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: {
          objectId: rollCode,
          type: 'audit:operator_roll_reweighed',
        },
        orderBy: { createdAt: 'desc' },
        select: { reason: true },
      }),
    ).resolves.toEqual({ reason: 'operator_reopened_previous_step' });

    await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/qr-print`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const afterPrint = await request(app.getHttpServer())
      .post(`/api/operator/rolls/${rollCode}/step-back`)
      .set(asOperator)
      .send({ operationKey: randomUUID() })
      .expect(409);
    expect(afterPrint.body).toEqual(
      expect.objectContaining({ code: 'OPERATOR_STEP_BACK_PRINT_STARTED' }),
    );
  });
});
