import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SCALE_ADAPTER, type ScaleAdapter } from '../src/integrations/scale/scale.adapter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { enableSimulatedDevices } from './simulated-device-fixture';

type Auth = { Authorization: string };

describe('fixes 1433 BigBag trace (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let warehouse: Auth;
  let director: Auth;
  let production: Auth;
  let operator: Auth;
  let operatorId: string;

  const http = () => request(app.getHttpServer());

  async function expectRoleParity(
    code: string,
    expectedStatus: 'available' | 'in_use' | null,
  ): Promise<void> {
    const [operatorBags, productionSummary] = await Promise.all([
      http().get('/api/operator/big-bags').set(operator).expect(200),
      http().get('/api/production/big-bags/summary').set(production).expect(200),
    ]);
    const operatorBag = operatorBags.body.find((item: { code: string }) => item.code === code);
    const productionBag = productionSummary.body.bags.find(
      (item: { code: string }) => item.code === code,
    );
    const visible = expectedStatus !== null;
    expect(Boolean(operatorBag)).toBe(visible);
    expect(Boolean(productionBag)).toBe(visible);
    if (expectedStatus) {
      expect(operatorBag.status).toBe(expectedStatus);
      expect(productionBag.status).toBe(expectedStatus);
    }
  }

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
    const login = async (account: 'warehouse' | 'director' | 'production') => {
      const response = await http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(account), password })
        .expect(201);
      return { Authorization: `Bearer ${response.body.token as string}` };
    };
    [warehouse, director, production] = await Promise.all([
      login('warehouse'),
      login('director'),
      login('production'),
    ]);

    const operatorPassword = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
      select: { passwordHash: true },
    });
    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        login: `bigbag-trace-operator-${suffix}`,
        passwordHash: operatorPassword.passwordHash,
        displayName: `BigBag trace operator ${suffix}`,
        role: 'operator',
      },
      select: { login: true },
    });
    const response = await http()
      .post('/api/auth/login')
      .send({ login: user.login, password })
      .expect(201);
    operator = { Authorization: `Bearer ${response.body.token as string}` };
    operatorId = response.body.user.id as string;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps one BigBag current at the physically measured 450 kg through evidence and re-add', async () => {
    const suffix = randomUUID().slice(0, 8);
    const post = await prisma.post.create({
      data: {
        code: `BIGBAG-TRACE-${suffix}`,
        name: `BigBag trace post ${suffix}`,
        status: 'active',
      },
    });
    const devices = (['scale', 'printer', 'scanner'] as const).map((kind) => ({
      id: `bigbag-trace-${kind}-${suffix}`,
      code: `BIGBAG-TRACE-${kind}-${suffix}`,
      kind,
      postId: post.id,
    }));
    await prisma.deviceRuntime.createMany({ data: devices });
    const restoreDevices = await enableSimulatedDevices(
      prisma,
      devices.map(({ id }) => id),
    );

    try {
      const now = new Date();
      const shift = await prisma.shift.create({
        data: {
          label: `BigBag trace shift ${suffix}`,
          plannedStartAt: new Date(now.getTime() - 60_000),
          plannedEndAt: new Date(now.getTime() + 60 * 60_000),
          status: 'planned',
        },
      });
      await prisma.operatorShiftMachineAssignment.create({
        data: { shiftId: shift.id, operatorId, postId: post.id, status: 'planned' },
      });
      const counterparty = await prisma.counterparty.create({
        data: { displayName: `BigBag trace counterparty ${suffix}` },
      });
      const order = await prisma.commercialOrder.create({
        data: {
          orderNumber: `BIGBAG-TRACE-${suffix}`,
          creatorRole: 'commercial',
          counterpartyId: counterparty.id,
          requestType: 'client_order',
        },
      });
      const productionOrder = await prisma.productionOrder.create({
        data: { commercialOrderId: order.id, approvalState: 'approved' },
      });
      const [produced, defect] = await Promise.all(
        [
          { label: 'PRODUCED', planKg: 40, rank: 1 },
          { label: 'DEFECT', planKg: 10, rank: 2 },
        ].map(({ label, planKg, rank }) =>
          prisma.rollDispatchItem.create({
            data: {
              rollCode: `BIGBAG-TRACE-${label}-${suffix}`,
              productionOrderId: productionOrder.id,
              assignedOperatorId: operatorId,
              postId: post.id,
              machineId: post.code,
              workplaceId: post.id,
              plannedShiftId: shift.id,
              plannedWeightKg: planKg,
              queueRank: rank,
              status: 'assigned',
              operatorLine: { create: { sequence: rank, planKg, step: 'assigned' } },
            },
          }),
        ),
      );

      const bag = await http()
        .post('/api/warehouse/big-bags')
        .set(warehouse)
        .send({ code: `BIGBAG-TRACE-BAG-${suffix}`, materialPreset: 'pvd_tsp', weightKg: 500 })
        .expect(201);
      const scanToken = await prisma.bigBagScanToken.findUniqueOrThrow({
        where: { bigBagId: bag.body.id as string },
        select: { token: true },
      });
      await expectRoleParity(bag.body.code as string, null);
      await http()
        .post('/api/warehouse/big-bags/scans')
        .set(warehouse)
        .send({ operationKey: randomUUID(), qrCode: scanToken.token, destination: 'warehouse' })
        .expect(200);
      await expectRoleParity(bag.body.code as string, null);
      await http()
        .post('/api/warehouse/big-bags/scans')
        .set(warehouse)
        .send({ operationKey: randomUUID(), qrCode: scanToken.token, destination: 'production' })
        .expect(200);
      await expectRoleParity(bag.body.code as string, 'available');

      await http()
        .post('/api/operator/shift/open')
        .set(operator)
        .send({ postCode: post.code, bigBagId: bag.body.id, startKg: 500 })
        .expect(201);
      await expectRoleParity(bag.body.code as string, 'in_use');

      const scale = app.get<ScaleAdapter>(SCALE_ADAPTER);
      const rollReadings = [42, 12];
      const scaleSpy = jest.spyOn(scale, 'read').mockImplementation(async (binding, kind) => ({
        deviceId: binding.deviceId,
        status: 'ready',
        stable: true,
        grossKg: kind === 'spool' ? 2 : rollReadings.shift()!,
      }));
      try {
        for (const rollCode of [produced.rollCode, defect.rollCode]) {
          await http()
            .post(`/api/operator/rolls/${rollCode}/accept`)
            .set(operator)
            .send({ operationKey: randomUUID() })
            .expect(201);
          await http()
            .post(`/api/operator/rolls/${rollCode}/spool-weight`)
            .set(operator)
            .send({ operationKey: randomUUID() })
            .expect(201);
        }
        await http()
          .post(`/api/operator/rolls/${produced.rollCode}/roll-weight`)
          .set(operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
        await http()
          .post(`/api/operator/rolls/${defect.rollCode}/defects`)
          .set(operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
      } finally {
        scaleSpy.mockRestore();
      }

      await expect(
        prisma.defectRecord.findFirstOrThrow({
          where: { line: { rollDispatchItemId: defect.id } },
          select: { weightKg: true, weightCapture: { select: { netKg: true, stable: true } } },
        }),
      ).resolves.toEqual({ weightKg: 10, weightCapture: { netKg: 10, stable: true } });

      await http()
        .post(`/api/operator/shift/bags/${bag.body.id as string}/release`)
        .set(operator)
        .send({ operationKey: randomUUID(), endKg: 450 })
        .expect(201);
      await expectRoleParity(bag.body.code as string, 'available');
      const warehouseReturn = await http()
        .post('/api/warehouse/big-bags/scans')
        .set(warehouse)
        .send({
          operationKey: randomUUID(),
          qrCode: scanToken.token,
          destination: 'warehouse',
          warehouseWeightKg: 450,
        })
        .expect(200);
      expect(warehouseReturn.body.weightComparison).toEqual({
        operatorReportedKg: 450,
        warehouseMeasuredKg: 450,
        differenceKg: 0,
        differencePercent: 0,
      });
      await expectRoleParity(bag.body.code as string, null);

      const evidence = await http()
        .get(
          `/api/director/analytics/big-bags?from=2026-01-01&to=2026-12-31&bucket=day&bigBagId=${bag.body.id as string}`,
        )
        .set(director)
        .expect(200);
      expect(evidence.body.items).toEqual([
        expect.objectContaining({
          bigBagId: bag.body.id,
          startKg: 500,
          endKg: 450,
          currentKg: 450,
          actualUsageKg: 50,
          expectedUsageKg: 50,
          calculatedRemainderKg: 450,
          producedKg: 40,
          defectKg: 10,
          defectCount: 1,
          unverifiedDefectCount: 0,
          deviationKg: 0,
          deviationPercent: 0,
          status: 'ok',
        }),
      ]);

      await http()
        .post('/api/warehouse/big-bags/scans')
        .set(warehouse)
        .send({ operationKey: randomUUID(), qrCode: scanToken.token, destination: 'production' })
        .expect(200);
      await expectRoleParity(bag.body.code as string, 'available');
      await http()
        .post('/api/operator/shift/bags')
        .set(operator)
        .send({ bigBagId: bag.body.id, startKg: 450, reason: 'Возврат после складского контроля' })
        .expect(201);
      await expect(
        prisma.bigBagUnit.findUniqueOrThrow({
          where: { id: bag.body.id as string },
          select: {
            currentKg: true,
            lastMeasuredKg: true,
            lastWarehouseMeasuredKg: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        currentKg: 450,
        lastMeasuredKg: 450,
        lastWarehouseMeasuredKg: 450,
        status: 'in_use',
      });
      await expectRoleParity(bag.body.code as string, 'in_use');
      await http()
        .post(`/api/operator/shift/bags/${bag.body.id as string}/release`)
        .set(operator)
        .send({ operationKey: randomUUID(), endKg: 0 })
        .expect(201)
        .expect(({ body }) => expect(body).toMatchObject({ status: 'consumed' }));
      await expectRoleParity(bag.body.code as string, null);
    } finally {
      await restoreDevices();
    }
  });
});
