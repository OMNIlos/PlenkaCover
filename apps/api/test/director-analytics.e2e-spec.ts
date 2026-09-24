import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { createOpenApiDocument } from '../src/openapi';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type AuthHeaders = { Authorization: string };
type RollFixture = { lineId: string; rollCode: string; rollId: string };

function recursivelyCollectKeys(value: unknown, target: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) recursivelyCollectKeys(item, target);
    return target;
  }
  if (!value || typeof value !== 'object') return target;
  for (const [key, nested] of Object.entries(value)) {
    target.push(key);
    recursivelyCollectKeys(nested, target);
  }
  return target;
}

describe('Director production and BigBag analytics (e2e, real DB)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let director: AuthHeaders;
  let operator: AuthHeaders;
  let warehouse: AuthHeaders;
  let factOperatorId: string;
  let factOperatorName: string;
  let productionApplicationId: string;
  let productionApplicationNumber: string;
  let rollA: RollFixture;
  let rollB: RollFixture;
  let rollMissing: RollFixture;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      imports: [require('../src/app.module').AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const login = async (name: 'director' | 'operator' | 'warehouse') => {
      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(name), password: e2eSeedPassword() })
        .expect(201);
      return { Authorization: `Bearer ${response.body.token as string}` };
    };
    [director, operator, warehouse] = await Promise.all([
      login('director'),
      login('operator'),
      login('warehouse'),
    ]);

    const factOperator = await prisma.user.create({
      data: {
        login: `analytics-operator-${suffix}`,
        displayName: `Analytics Operator ${suffix}`,
        passwordHash: `PASSWORD_CANARY_${suffix}`,
        role: 'operator',
      },
    });
    const factCommercial = await prisma.user.create({
      data: {
        login: `analytics-commercial-${suffix}`,
        displayName: `Analytics Commercial ${suffix}`,
        passwordHash: `PASSWORD_CANARY_COMMERCIAL_${suffix}`,
        role: 'commercial',
      },
    });
    factOperatorId = factOperator.id;
    factOperatorName = factOperator.displayName;
    const [postA, postB, postC] = await Promise.all(
      ['A', 'B', 'C'].map((label) =>
        prisma.post.create({
          data: {
            code: `ANALYTICS-${label}-${suffix}`,
            name: `Analytics Post ${label}`,
            status: 'active',
            agentTokenHash: `TOKEN_CANARY_${label}_${suffix}`,
          },
        }),
      ),
    );
    const shiftA = await prisma.shift.create({
      data: {
        label: `Analytics shift A ${suffix}`,
        plannedStartAt: new Date('2024-02-27T20:00:00.000Z'),
        plannedEndAt: new Date('2024-02-27T23:00:00.000Z'),
        startedAt: new Date('2024-02-27T20:30:00.000Z'),
        endedAt: new Date('2024-02-27T22:30:00.000Z'),
        status: 'closed',
      },
    });
    const shiftB = await prisma.shift.create({
      data: {
        label: `Analytics shift B ${suffix}`,
        plannedStartAt: new Date('2024-02-28T20:00:00.000Z'),
        plannedEndAt: new Date('2024-02-28T23:00:00.000Z'),
        startedAt: new Date('2024-02-28T20:30:00.000Z'),
        endedAt: new Date('2024-02-28T22:30:00.000Z'),
        status: 'closed',
      },
    });
    const shiftC = await prisma.shift.create({
      data: {
        label: `Analytics shift C ${suffix}`,
        plannedStartAt: new Date('2024-02-29T09:00:00.000Z'),
        plannedEndAt: new Date('2024-02-29T17:00:00.000Z'),
        startedAt: new Date('2024-02-29T10:00:00.000Z'),
        status: 'open',
      },
    });
    const [sessionA, sessionB, sessionC] = await Promise.all([
      prisma.operatorPostSession.create({
        data: {
          operatorId: factOperator.id,
          postId: postA.id,
          shiftId: shiftA.id,
          status: 'closed',
          startedAt: new Date('2024-02-27T20:30:00.000Z'),
          endedAt: new Date('2024-02-27T22:30:00.000Z'),
        },
      }),
      prisma.operatorPostSession.create({
        data: {
          operatorId: factOperator.id,
          postId: postB.id,
          shiftId: shiftB.id,
          status: 'closed',
          startedAt: new Date('2024-02-28T20:30:00.000Z'),
          endedAt: new Date('2024-02-28T22:30:00.000Z'),
        },
      }),
      prisma.operatorPostSession.create({
        data: {
          operatorId: factOperator.id,
          postId: postC.id,
          shiftId: shiftC.id,
          status: 'active',
          startedAt: new Date('2024-02-29T10:00:00.000Z'),
        },
      }),
    ]);

    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Analytics counterparty ${suffix}` },
    });
    const commercialOrder = await prisma.commercialOrder.create({
      data: {
        orderNumber: `ANALYTICS-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        requestType: 'client_order',
        createdAt: new Date('2024-02-28T12:00:00.000Z'),
      },
    });
    productionApplicationId = commercialOrder.id;
    productionApplicationNumber = commercialOrder.orderNumber;
    const productionOrder = await prisma.productionOrder.create({
      data: { commercialOrderId: commercialOrder.id, approvalState: 'approved' },
    });
    let sequence = 0;
    const createLine = async (
      label: string,
      postId: string,
      postCode: string,
      planKg: number | null,
      shiftId?: string,
      characteristicsSnapshot?: object,
    ): Promise<RollFixture> => {
      sequence += 1;
      const dispatch = await prisma.rollDispatchItem.create({
        data: {
          rollCode: `ANALYTICS-${suffix}-${label}`,
          productionOrderId: productionOrder.id,
          assignedOperatorId: factOperator.id,
          postId,
          machineId: postCode,
          plannedShiftId: shiftId,
          plannedWeightKg: planKg,
          status: 'done',
          positionSequence: sequence,
          characteristicsSnapshot,
          operatorLine: { create: { sequence, step: 'warehouse', planKg } },
        },
        include: { operatorLine: { select: { id: true } } },
      });
      return {
        lineId: dispatch.operatorLine!.id,
        rollCode: dispatch.rollCode,
        rollId: dispatch.id,
      };
    };
    rollA = await createLine('A', postA.id, postA.code, 35, shiftA.id, {
      rawPayload: `RAW_CANARY_${suffix}`,
      sourceSnapshot: { headers: { authorization: `SECRET_CANARY_${suffix}` } },
      qrCode: `QR_CANARY_${suffix}`,
    });
    rollB = await createLine('B', postB.id, postB.code, 45, shiftB.id);
    const outsideCanonical = await createLine('OUTSIDE', postA.id, postA.code, 7);
    rollMissing = await createLine('MISSING', postB.id, postB.code, null);
    const excluded = await createLine('EXCLUDED', postB.id, postB.code, null);

    await prisma.weightCapture.createMany({
      data: [
        {
          id: `analytics-${suffix}-a-spool`,
          operatorRollLineId: rollA.lineId,
          kind: 'spool',
          deviceId: `DEVICE_CANARY_${suffix}`,
          deviceStatus: 'ready',
          stable: true,
          spoolKg: 2,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postA.id,
          postSessionId: sessionA.id,
          createdAt: new Date('2024-02-27T21:20:00.000Z'),
        },
        {
          id: `analytics-${suffix}-a-root`,
          operatorRollLineId: rollA.lineId,
          kind: 'roll',
          stable: true,
          grossKg: 47,
          spoolKg: 7,
          netKg: 40,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postA.id,
          postSessionId: sessionA.id,
          createdAt: new Date('2024-02-27T21:30:00.000Z'),
        },
        {
          id: `analytics-${suffix}-a-reweigh`,
          operatorRollLineId: rollA.lineId,
          kind: 'roll',
          stable: true,
          grossKg: 51.5,
          spoolKg: 7,
          netKg: 44.5,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postA.id,
          postSessionId: sessionA.id,
          supersedesCaptureId: `analytics-${suffix}-a-root`,
          createdAt: new Date('2024-02-28T10:00:00.000Z'),
        },
        {
          id: `analytics-${suffix}-a-future-reweigh`,
          operatorRollLineId: rollA.lineId,
          kind: 'roll',
          stable: true,
          grossKg: 907,
          spoolKg: 7,
          netKg: 900,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postA.id,
          postSessionId: sessionA.id,
          supersedesCaptureId: `analytics-${suffix}-a-reweigh`,
          createdAt: new Date('2024-03-02T10:00:00.000Z'),
        },
        {
          id: `analytics-${suffix}-b-canonical`,
          operatorRollLineId: rollB.lineId,
          kind: 'roll',
          stable: true,
          netKg: 42.8,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postB.id,
          postSessionId: sessionB.id,
          createdAt: new Date('2024-02-28T21:30:00.000Z'),
        },
        {
          id: `analytics-${suffix}-outside-canonical`,
          operatorRollLineId: outsideCanonical.lineId,
          kind: 'roll',
          stable: true,
          netKg: 7,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postA.id,
          createdAt: new Date('2024-02-26T20:00:00.000Z'),
        },
        {
          id: `analytics-${suffix}-outside-reweigh`,
          operatorRollLineId: outsideCanonical.lineId,
          kind: 'roll',
          stable: true,
          netKg: 700,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postA.id,
          supersedesCaptureId: `analytics-${suffix}-outside-canonical`,
          createdAt: new Date('2024-02-28T10:00:00.000Z'),
        },
        {
          id: `analytics-${suffix}-missing-00`,
          operatorRollLineId: rollMissing.lineId,
          kind: 'roll',
          stable: true,
          netKg: 5,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postB.id,
          createdAt: new Date('2024-02-28T22:00:00.000Z'),
        },
        {
          id: `analytics-${suffix}-missing-99`,
          operatorRollLineId: rollMissing.lineId,
          kind: 'roll',
          stable: true,
          netKg: 500,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postB.id,
          createdAt: new Date('2024-02-28T22:00:00.000Z'),
        },
        {
          id: `analytics-${suffix}-excluded-spool`,
          operatorRollLineId: excluded.lineId,
          kind: 'spool',
          stable: true,
          netKg: 8,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postB.id,
          createdAt: new Date('2024-02-28T22:10:00.000Z'),
        },
        {
          id: `analytics-${suffix}-excluded-unstable`,
          operatorRollLineId: excluded.lineId,
          kind: 'roll',
          stable: false,
          netKg: 9,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postB.id,
          createdAt: new Date('2024-02-28T22:11:00.000Z'),
        },
        {
          id: `analytics-${suffix}-excluded-null`,
          operatorRollLineId: excluded.lineId,
          kind: 'roll',
          stable: true,
          netKg: null,
          actorRole: 'operator',
          actorId: factOperator.id,
          postId: postB.id,
          createdAt: new Date('2024-02-28T22:12:00.000Z'),
        },
      ],
    });

    await prisma.defectRecord.createMany({
      data: [
        {
          operatorRollLineId: rollA.lineId,
          weightCaptureId: `analytics-${suffix}-a-reweigh`,
          sourceRole: 'operator',
          weightKg: 999,
          comment: `PAYLOAD_CANARY_VERIFIED_${suffix}`,
          createdAt: new Date('2024-02-28T12:30:00.000Z'),
        },
        {
          operatorRollLineId: rollMissing.lineId,
          sourceRole: 'operator',
          weightKg: 888,
          comment: `FRAME_CANARY_UNVERIFIED_${suffix}`,
          createdAt: new Date('2024-02-29T22:30:00.000Z'),
        },
      ],
    });

    const createApplication = (
      label: string,
      requestType: 'client_order' | 'stock_reserve',
      createdAt: string,
      promotedDraft = false,
    ) =>
      prisma.commercialOrder.create({
        data: {
          orderNumber: `ANALYTICS-APP-${label}-${suffix}`,
          creatorRole: 'commercial',
          counterpartyId: counterparty.id,
          requestType,
          commercialStage: 'incoming',
          draftedAt: promotedDraft ? new Date(createdAt) : null,
          createdAt: new Date(createdAt),
        },
      });
    await createApplication('DIRECT-STOCK', 'stock_reserve', '2024-02-10T12:00:00.000Z');
    const promotedThreeMonths = await createApplication(
      'PROMOTED-THREE',
      'stock_reserve',
      '2023-11-15T12:00:00.000Z',
      true,
    );
    const promotedSixMonths = await createApplication(
      'PROMOTED-SIX',
      'client_order',
      '2023-08-01T12:00:00.000Z',
      true,
    );
    await prisma.commercialOrder.create({
      data: {
        orderNumber: `ANALYTICS-APP-DRAFT-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        requestType: 'client_order',
        commercialStage: 'draft',
        draftedAt: new Date('2024-02-27T12:00:00.000Z'),
        createdAt: new Date('2024-02-27T12:00:00.000Z'),
      },
    });
    await createApplication('OUTSIDE-SIX', 'client_order', '2023-08-31T12:00:00.000Z');
    await prisma.domainEvent.createMany({
      data: [
        {
          family: 'audit',
          type: 'audit:commercial_draft_promoted',
          objectId: promotedThreeMonths.id,
          actorKind: 'user',
          actorRole: 'commercial',
          actorId: factCommercial.id,
          createdAt: new Date('2024-01-15T12:00:00.000Z'),
        },
        {
          family: 'audit',
          type: 'audit:commercial_draft_promoted',
          objectId: promotedThreeMonths.id,
          actorKind: 'user',
          actorRole: 'commercial',
          actorId: factCommercial.id,
          createdAt: new Date('2024-01-16T12:00:00.000Z'),
        },
        {
          family: 'audit',
          type: 'audit:commercial_draft_promoted',
          objectId: promotedSixMonths.id,
          actorKind: 'user',
          actorRole: 'commercial',
          actorId: factCommercial.id,
          createdAt: new Date('2023-10-15T12:00:00.000Z'),
        },
      ],
    });

    const [bagA, bagB, bagC, bagConsumedAfterRange] = await Promise.all([
      prisma.bigBagUnit.create({
        data: {
          code: `ANALYTICS-BAG-A-${suffix}`,
          material: 'ПВД test A',
          materialId: 'rm-pvd-15803',
          status: 'available',
          initialKg: 100,
          currentKg: 60,
          lastMeasuredKg: 60,
          lastMeasuredAt: new Date('2024-02-27T22:15:00.000Z'),
          createdAt: new Date('2024-02-01T00:00:00.000Z'),
        },
      }),
      prisma.bigBagUnit.create({
        data: {
          code: `ANALYTICS-BAG-B-${suffix}`,
          material: 'ПВД test B',
          materialId: 'rm-pvd-15803',
          status: 'available',
          initialKg: 50,
          currentKg: 52,
          lastMeasuredKg: 52,
          lastMeasuredAt: new Date('2024-02-28T22:15:00.000Z'),
          createdAt: new Date('2024-02-01T00:00:00.000Z'),
        },
      }),
      prisma.bigBagUnit.create({
        data: {
          code: `ANALYTICS-BAG-C-${suffix}`,
          material: 'ПВД test C',
          materialId: 'rm-pvd-15803',
          status: 'in_use',
          initialKg: 70,
          currentKg: 70,
          lastMeasuredKg: 70,
          lastMeasuredAt: new Date('2024-02-29T10:05:00.000Z'),
          createdAt: new Date('2024-02-29T09:00:00.000Z'),
        },
      }),
      prisma.bigBagUnit.create({
        data: {
          code: `ANALYTICS-BAG-D-${suffix}`,
          material: 'ПВД test D',
          materialId: 'rm-pvd-15803',
          status: 'consumed',
          initialKg: 30,
          currentKg: 0,
          lastMeasuredKg: 0,
          lastMeasuredAt: new Date('2024-03-02T12:00:00.000Z'),
          createdAt: new Date('2024-02-01T00:00:00.000Z'),
        },
      }),
    ]);
    await prisma.shiftBagUsage.createMany({
      data: [
        {
          sessionId: sessionA.id,
          bigBagId: bagA.id,
          startKg: 100,
          endKg: 60,
          createdAt: new Date('2024-02-27T20:35:00.000Z'),
          closedAt: new Date('2024-02-27T22:15:00.000Z'),
        },
        {
          sessionId: sessionB.id,
          bigBagId: bagB.id,
          startKg: 50,
          endKg: 52,
          createdAt: new Date('2024-02-28T20:35:00.000Z'),
          closedAt: new Date('2024-02-28T22:15:00.000Z'),
        },
        {
          sessionId: sessionC.id,
          bigBagId: bagC.id,
          startKg: 70,
          createdAt: new Date('2024-02-29T10:05:00.000Z'),
        },
        {
          sessionId: sessionC.id,
          bigBagId: bagConsumedAfterRange.id,
          startKg: 30,
          endKg: 0,
          createdAt: new Date('2024-03-02T10:00:00.000Z'),
          closedAt: new Date('2024-03-02T12:00:00.000Z'),
        },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps discriminating promotion-time and spool-evidence fixture controls', async () => {
    const captures = await prisma.weightCapture.findMany({
      where: {
        id: {
          in: [
            `analytics-${suffix}-a-spool`,
            `analytics-${suffix}-a-root`,
            `analytics-${suffix}-a-reweigh`,
            `analytics-${suffix}-a-future-reweigh`,
          ],
        },
      },
      select: { id: true, kind: true, grossKg: true, spoolKg: true, netKg: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(captures).toEqual([
      {
        id: `analytics-${suffix}-a-spool`,
        kind: 'spool',
        grossKg: null,
        spoolKg: 2,
        netKg: null,
      },
      {
        id: `analytics-${suffix}-a-root`,
        kind: 'roll',
        grossKg: 47,
        spoolKg: 7,
        netKg: 40,
      },
      {
        id: `analytics-${suffix}-a-reweigh`,
        kind: 'roll',
        grossKg: 51.5,
        spoolKg: 7,
        netKg: 44.5,
      },
      {
        id: `analytics-${suffix}-a-future-reweigh`,
        kind: 'roll',
        grossKg: 907,
        spoolKg: 7,
        netKg: 900,
      },
    ]);

    const applications = await prisma.commercialOrder.findMany({
      where: {
        orderNumber: {
          in: [`ANALYTICS-APP-PROMOTED-THREE-${suffix}`, `ANALYTICS-APP-PROMOTED-SIX-${suffix}`],
        },
      },
      select: { id: true, orderNumber: true, createdAt: true },
      orderBy: { orderNumber: 'asc' },
    });
    expect(
      Object.fromEntries(
        applications.map(({ orderNumber, createdAt }) => [orderNumber, createdAt.toISOString()]),
      ),
    ).toEqual({
      [`ANALYTICS-APP-PROMOTED-THREE-${suffix}`]: '2023-11-15T12:00:00.000Z',
      [`ANALYTICS-APP-PROMOTED-SIX-${suffix}`]: '2023-08-01T12:00:00.000Z',
    });
    const promotionEvents = await prisma.domainEvent.findMany({
      where: {
        type: 'audit:commercial_draft_promoted',
        objectId: { in: applications.map(({ id }) => id) },
      },
      select: { objectId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(promotionEvents.map(({ createdAt }) => createdAt.toISOString())).toEqual([
      '2023-10-15T12:00:00.000Z',
      '2024-01-15T12:00:00.000Z',
      '2024-01-16T12:00:00.000Z',
    ]);
  });

  it('returns exact Moscow buckets, canonical production and immutable bag usage facts', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/director/analytics?from=2024-02-27&to=2024-03-01&bucket=day')
      .set(director)
      .expect(200);

    expect(response.body.range).toEqual(
      expect.objectContaining({
        timezone: 'Europe/Moscow',
        requested: { from: '2024-02-27', to: '2024-03-01' },
        effective: {
          fromUtc: '2024-02-26T21:00:00.000Z',
          toExclusiveUtc: '2024-03-01T21:00:00.000Z',
        },
        bucket: 'day',
        generatedAt: expect.any(String),
      }),
    );
    expect(response.body.productionSeries).toEqual([
      { bucketStartDate: '2024-02-27', rollCount: 0, producedKg: 0 },
      { bucketStartDate: '2024-02-28', rollCount: 1, producedKg: 44.5 },
      { bucketStartDate: '2024-02-29', rollCount: 2, producedKg: 47.8 },
      { bucketStartDate: '2024-03-01', rollCount: 0, producedKg: 0 },
    ]);
    expect(response.body.materialSeries).toEqual([
      { bucketStartDate: '2024-02-27', expectedUsageKg: 0, actualUsageKg: 0 },
      { bucketStartDate: '2024-02-28', expectedUsageKg: 44.5, actualUsageKg: 40 },
      { bucketStartDate: '2024-02-29', expectedUsageKg: 47.8, actualUsageKg: -2 },
      { bucketStartDate: '2024-03-01', expectedUsageKg: 0, actualUsageKg: 0 },
    ]);
    expect(response.body.operatorOverPlan).toEqual({
      series: [
        {
          bucketStartDate: '2024-02-27',
          affectedRollCount: 0,
          affectedOperatorCount: 0,
          overPlanKg: 0,
        },
        {
          bucketStartDate: '2024-02-28',
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 9.5,
        },
        {
          bucketStartDate: '2024-02-29',
          affectedRollCount: 0,
          affectedOperatorCount: 0,
          overPlanKg: 0,
        },
        {
          bucketStartDate: '2024-03-01',
          affectedRollCount: 0,
          affectedOperatorCount: 0,
          overPlanKg: 0,
        },
      ],
      totals: [
        {
          period: 'week',
          fromDate: '2024-02-24',
          toDate: '2024-03-01',
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 9.5,
        },
        {
          period: 'month',
          fromDate: '2024-02-01',
          toDate: '2024-03-01',
          affectedRollCount: 1,
          affectedOperatorCount: 1,
          overPlanKg: 9.5,
        },
      ],
      topOperators: [
        {
          operatorId: factOperatorId,
          operatorName: factOperatorName,
          affectedRollCount: 1,
          overPlanKg: 9.5,
        },
      ],
      missingPlanCount: 1,
      missingActorCount: 1,
    });
    expect(response.body.productionQualitySeries).toEqual([
      {
        id: 'day:2024-02-27',
        bucketStartDate: '2024-02-27',
        producedRollCount: 0,
        producedKg: 0,
        defectRecordCount: 0,
        defectiveRollCount: 0,
        verifiedDefectKg: 0,
        unverifiedDefectCount: 0,
        returnedSpoolCount: 0,
      },
      {
        id: 'day:2024-02-28',
        bucketStartDate: '2024-02-28',
        producedRollCount: 1,
        producedKg: 44.5,
        defectRecordCount: 1,
        defectiveRollCount: 1,
        verifiedDefectKg: 44.5,
        unverifiedDefectCount: 0,
        returnedSpoolCount: 0,
      },
      {
        id: 'day:2024-02-29',
        bucketStartDate: '2024-02-29',
        producedRollCount: 2,
        producedKg: 47.8,
        defectRecordCount: 0,
        defectiveRollCount: 0,
        verifiedDefectKg: 0,
        unverifiedDefectCount: 0,
        returnedSpoolCount: 0,
      },
      {
        id: 'day:2024-03-01',
        bucketStartDate: '2024-03-01',
        producedRollCount: 0,
        producedKg: 0,
        defectRecordCount: 1,
        defectiveRollCount: 1,
        verifiedDefectKg: 0,
        unverifiedDefectCount: 1,
        returnedSpoolCount: 0,
      },
    ]);
    expect(response.body.materialSpendSeries).toEqual([
      {
        bucketStartDate: '2024-02-27',
        consumedGranulesKg: 0,
        recordedSpoolCount: 0,
        recordedSpoolTareKg: 0,
        missingSpoolEvidenceCount: 0,
      },
      {
        bucketStartDate: '2024-02-28',
        consumedGranulesKg: 40,
        recordedSpoolCount: 1,
        recordedSpoolTareKg: 2,
        missingSpoolEvidenceCount: 0,
      },
      {
        bucketStartDate: '2024-02-29',
        consumedGranulesKg: -2,
        recordedSpoolCount: 0,
        recordedSpoolTareKg: 0,
        missingSpoolEvidenceCount: 2,
      },
      {
        bucketStartDate: '2024-03-01',
        consumedGranulesKg: 0,
        recordedSpoolCount: 0,
        recordedSpoolTareKg: 0,
        missingSpoolEvidenceCount: 0,
      },
    ]);
    expect(response.body.spoolEvidence).toEqual({
      availability: 'measured_evidence_only',
      explanation:
        'Spool tare is measured production evidence, not exact warehouse inventory consumption.',
    });
    expect(response.body.commercialApplications).toEqual({
      definition: 'submitted',
      asOfDate: '2024-03-01',
      periods: [
        {
          period: 'week',
          fromDate: '2024-02-24',
          toDate: '2024-03-01',
          totalCount: 1,
          clientOrderCount: 1,
          stockReserveCount: 0,
        },
        {
          period: 'month',
          fromDate: '2024-02-01',
          toDate: '2024-03-01',
          totalCount: 2,
          clientOrderCount: 1,
          stockReserveCount: 1,
        },
        {
          period: '3_months',
          fromDate: '2023-12-01',
          toDate: '2024-03-01',
          totalCount: 3,
          clientOrderCount: 1,
          stockReserveCount: 2,
        },
        {
          period: '6_months',
          fromDate: '2023-09-01',
          toDate: '2024-03-01',
          totalCount: 4,
          clientOrderCount: 2,
          stockReserveCount: 2,
        },
      ],
    });
    const latestProductionSync = (
      await prisma.oneCSyncRun.findMany({
        where: {
          status: 'completed',
          mode: { in: ['apply', 'scheduled'] },
          completedAt: { not: null },
        },
        select: { completedAt: true, counters: true },
        orderBy: { completedAt: 'desc' },
        take: 100,
      })
    ).find(
      ({ counters }) =>
        typeof counters === 'object' &&
        counters !== null &&
        Object.prototype.hasOwnProperty.call(counters, 'production_report'),
    );
    const latestProductionImportedAt = latestProductionSync?.completedAt ?? null;
    expect(response.body.accountingProduction).toEqual({
      source: {
        sourceKind: '1C',
        label: '1С · Отчет производства за смену',
        latestImportedAt: latestProductionImportedAt?.toISOString() ?? null,
        latestDocumentDate: null,
        stale:
          !latestProductionImportedAt ||
          Date.now() >= latestProductionImportedAt.getTime() + 24 * 60 * 60 * 1_000,
      },
      coverage: {
        documentCount: 0,
        excludedOutputLineCount: 0,
        excludedMaterialLineCount: 0,
      },
      productionSeries: [
        { bucketStartDate: '2024-02-27', documentCount: 0, producedKg: 0 },
        { bucketStartDate: '2024-02-28', documentCount: 0, producedKg: 0 },
        { bucketStartDate: '2024-02-29', documentCount: 0, producedKg: 0 },
        { bucketStartDate: '2024-03-01', documentCount: 0, producedKg: 0 },
      ],
      materialSeries: [
        { bucketStartDate: '2024-02-27', consumedKg: 0 },
        { bucketStartDate: '2024-02-28', consumedKg: 0 },
        { bucketStartDate: '2024-02-29', consumedKg: 0 },
        { bucketStartDate: '2024-03-01', consumedKg: 0 },
      ],
    });

    const shiftA = response.body.shiftBalances.find((item: { postCode: string }) =>
      item.postCode.includes(`ANALYTICS-A-${suffix}`),
    );
    const shiftB = response.body.shiftBalances.find((item: { postCode: string }) =>
      item.postCode.includes(`ANALYTICS-B-${suffix}`),
    );
    expect(shiftA).toEqual(
      expect.objectContaining({
        rollCount: 1,
        producedKg: 44.5,
        expectedUsageKg: 44.5,
        actualUsageKg: 40,
        deviationPercent: -10.112,
        status: 'mismatch',
      }),
    );
    expect(shiftB).toEqual(
      expect.objectContaining({
        rollCount: 1,
        producedKg: 42.8,
        expectedUsageKg: 42.8,
        actualUsageKg: -2,
        status: 'mismatch',
      }),
    );

    const bagA = response.body.bigBags.find(
      (item: { code: string }) => item.code === `ANALYTICS-BAG-A-${suffix}`,
    );
    const bagC = response.body.bigBags.find(
      (item: { code: string }) => item.code === `ANALYTICS-BAG-C-${suffix}`,
    );
    const bagConsumedAfterRange = response.body.bigBags.find(
      (item: { code: string }) => item.code === `ANALYTICS-BAG-D-${suffix}`,
    );
    expect(bagA.currentSnapshot).toEqual({
      measuredKg: 60,
      measuredAt: '2024-02-27T22:15:00.000Z',
    });
    expect(bagA.usageHistory).toEqual([
      expect.objectContaining({
        startKg: 100,
        endKg: 60,
        deltaKg: 40,
        openedAt: '2024-02-27T20:35:00.000Z',
        closedAt: '2024-02-27T22:15:00.000Z',
      }),
    ]);
    expect(bagC.usageHistory).toEqual([
      expect.objectContaining({ startKg: 70, endKg: null, deltaKg: null, closedAt: null }),
    ]);
    expect(bagConsumedAfterRange).toEqual(
      expect.objectContaining({
        status: 'consumed',
        currentSnapshot: {
          measuredKg: 0,
          measuredAt: '2024-03-02T12:00:00.000Z',
        },
        usageHistory: [],
      }),
    );
  });

  it('returns exact cursor pages with underweight, missing-plan and historical reweigh facts', async () => {
    const path = '/api/director/analytics/operator-rolls?from=2024-02-27&to=2024-03-01&limit=2';
    const firstPage = await request(app.getHttpServer()).get(path).set(director).expect(200);
    const expectedCursor = Buffer.from(
      JSON.stringify({
        producedAt: '2024-02-28T21:30:00.000Z',
        rollId: rollB.rollId,
      }),
      'utf8',
    ).toString('base64url');

    expect(firstPage.body).toEqual({
      items: [
        {
          operatorId: null,
          operatorName: null,
          orderId: productionApplicationId,
          orderNumber: productionApplicationNumber,
          rollId: rollMissing.rollId,
          rollCode: rollMissing.rollCode,
          producedAt: '2024-02-28T22:00:00.000Z',
          actualCapturedAt: '2024-02-28T22:00:00.000Z',
          plannedKg: null,
          actualKg: 5,
          varianceKg: null,
          overPlanKg: null,
          provenance: 'plan_missing',
        },
        {
          operatorId: factOperatorId,
          operatorName: factOperatorName,
          orderId: productionApplicationId,
          orderNumber: productionApplicationNumber,
          rollId: rollB.rollId,
          rollCode: rollB.rollCode,
          producedAt: '2024-02-28T21:30:00.000Z',
          actualCapturedAt: '2024-02-28T21:30:00.000Z',
          plannedKg: 45,
          actualKg: 42.8,
          varianceKg: -2.2,
          overPlanKg: 0,
          provenance: 'post_session',
        },
      ],
      nextCursor: expectedCursor,
    });

    const secondPage = await request(app.getHttpServer())
      .get(`${path}&cursor=${encodeURIComponent(expectedCursor)}`)
      .set(director)
      .expect(200);
    expect(secondPage.body).toEqual({
      items: [
        {
          operatorId: factOperatorId,
          operatorName: factOperatorName,
          orderId: productionApplicationId,
          orderNumber: productionApplicationNumber,
          rollId: rollA.rollId,
          rollCode: rollA.rollCode,
          producedAt: '2024-02-27T21:30:00.000Z',
          actualCapturedAt: '2024-02-28T10:00:00.000Z',
          plannedKg: 35,
          actualKg: 44.5,
          varianceKg: 9.5,
          overPlanKg: 9.5,
          provenance: 'post_session',
        },
      ],
      nextCursor: null,
    });
  });

  it('enforces real Bearer director access, strict input and the safe-field boundary', async () => {
    const aggregatePath = '/api/director/analytics?from=2024-02-27&to=2024-03-01&bucket=day';
    const pagePath = '/api/director/analytics/operator-rolls?from=2024-02-27&to=2024-03-01&limit=2';
    for (const path of [aggregatePath, pagePath]) {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer()).get(path).set(operator).expect(403);
      await request(app.getHttpServer()).get(path).set(warehouse).expect(403);
    }
    await request(app.getHttpServer())
      .get('/api/director/analytics?from=2024-02-30&to=2024-03-01&bucket=day')
      .set(director)
      .expect(400);

    const [aggregate, page] = await Promise.all([
      request(app.getHttpServer()).get(aggregatePath).set(director).expect(200),
      request(app.getHttpServer()).get(pagePath).set(director).expect(200),
    ]);
    const forbiddenKey = /raw|payload|frame|sourceSnapshot|token|secret|headers?/i;
    const bodies = [aggregate.body, page.body];
    expect(
      bodies
        .flatMap((body) => recursivelyCollectKeys(body))
        .filter((key) => forbiddenKey.test(key)),
    ).toEqual([]);
    const serialized = JSON.stringify(bodies);
    for (const canary of [
      'RAW_CANARY_',
      'TOKEN_CANARY_',
      'PASSWORD_CANARY_',
      'SECRET_CANARY_',
      'DEVICE_CANARY_',
      'PAYLOAD_CANARY_',
      'FRAME_CANARY_',
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(JSON.stringify(aggregate.body.accountingProduction)).not.toMatch(
      /rawPayload|externalId|sourceVersion|reportExternalId|organizationExternalId|warehouseExternalId|departmentExternalId|nomenclatureExternalId|unitExternalId|productExternalId|price|cost|amount|responsibleUser|Ответственный/i,
    );
  });

  it('documents both Bearer routes, outcomes and V2 response schemas in OpenAPI', () => {
    const document = createOpenApiDocument(app);
    const aggregateOperation = document.paths['/api/director/analytics']?.get;
    const pageOperation = document.paths['/api/director/analytics/operator-rolls']?.get;

    for (const operation of [aggregateOperation, pageOperation]) {
      expect(operation?.security).toContainEqual({ session: [] });
      expect(operation?.responses).toEqual(
        expect.objectContaining({
          '200': expect.any(Object),
          '400': expect.any(Object),
          '401': expect.any(Object),
          '403': expect.any(Object),
        }),
      );
    }
    expect(document.components?.schemas).toEqual(
      expect.objectContaining({
        DirectorAnalyticsResponseDto: expect.objectContaining({
          required: expect.arrayContaining([
            'operatorOverPlan',
            'productionQualitySeries',
            'materialSpendSeries',
            'spoolEvidence',
            'commercialApplications',
            'accountingProduction',
          ]),
          properties: expect.objectContaining({
            operatorOverPlan: expect.any(Object),
            productionQualitySeries: expect.any(Object),
            materialSpendSeries: expect.any(Object),
            spoolEvidence: expect.any(Object),
            commercialApplications: expect.any(Object),
            accountingProduction: expect.any(Object),
          }),
        }),
        DirectorAccountingProductionResponseDto: expect.objectContaining({
          required: ['source', 'coverage', 'productionSeries', 'materialSeries'],
        }),
        DirectorAccountingProductionSourceResponseDto: expect.objectContaining({
          required: ['sourceKind', 'label', 'latestImportedAt', 'latestDocumentDate', 'stale'],
        }),
        DirectorOperatorRollVariancePageResponseDto: expect.objectContaining({
          required: expect.arrayContaining(['items', 'nextCursor']),
          properties: expect.objectContaining({
            items: expect.any(Object),
            nextCursor: expect.any(Object),
          }),
        }),
        DirectorOperatorRollVarianceResponseDto: expect.objectContaining({
          required: expect.arrayContaining([
            'operatorId',
            'operatorName',
            'orderId',
            'orderNumber',
            'rollId',
            'rollCode',
            'producedAt',
            'actualCapturedAt',
            'plannedKg',
            'actualKg',
            'varianceKg',
            'overPlanKg',
            'provenance',
          ]),
        }),
      }),
    );
  });

  it('runs in the harness schema and installs the expected additive analytics indexes', async () => {
    const [schemaRow] = await prisma.$queryRaw<Array<{ schema: string }>>`
      SELECT current_schema() AS schema
    `;
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
    `;
    const names = indexes.map((index) => index.indexname);

    expect(schemaRow?.schema).toMatch(/^e2e_[1-9]\d*_[0-9a-f]{12}$/);
    expect(names).toEqual(
      expect.arrayContaining([
        'wc_analytics_scan_idx',
        'wc_line_canon_idx',
        'wc_session_scan_idx',
        'sbu_analytics_period_idx',
        'sbu_bag_period_idx',
        'sbu_closed_period_idx',
        'bbu_active_period_idx',
        'ops_closed_period_idx',
        'defect_records_created_at_id_idx',
      ]),
    );
    expect(
      indexes.find(({ indexname }) => indexname === 'defect_records_created_at_id_idx')?.indexdef,
    ).toMatch(/\("createdAt", id\)$/);
  });
});
