import { randomBytes, randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { normalizeSpoolTypeKey } from '../src/common/production-cost/production-cost-calculator';
import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE,
} from '../src/common/payroll-tariffs/legacy-payroll-tariff-matrix';
import { RollProductionCostSnapshotService } from '../src/modules/director/roll-production-cost-snapshot.service';
import { OperatorPayrollService } from '../src/modules/operator/operator-payroll.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';

type Bearer = { Authorization: string };

type ProductionFactFixture = {
  assignmentId: string;
  postId: string;
  rollId: string;
  sessionId: string;
  shiftId: string;
};

type AnalyticsPayrollRow = {
  sessionId: string;
  payroll:
    | {
        status: 'resolved';
        tariffOrder: { id: string; name: string; effectiveFrom: string };
        rateKopecksPerKg: number;
        amountKopecks: number;
        tariffRule: string;
      }
    | { status: 'unresolved'; reasons: string[] };
};

type PayrollBreakdownRow = {
  shiftId: string;
  tariffOrderId: string;
  amountKopecks: number;
  rateKopecksPerKg: number;
};

type PayrollPreview = {
  appliedTariffOrders: Array<{ id: string; name: string; effectiveFrom: string }>;
  summary: { payableAmountKopecks: number };
  breakdown: PayrollBreakdownRow[];
};

type RollCostRow = {
  rollId: string;
  payrollAmountKopecks: number | null;
  payrollSource: {
    tariffOrderId: string;
    tariffOrderName: string;
    effectiveFrom: string;
    rateKopecksPerKg: number;
  } | null;
};

const RANGE = { from: '2026-01-15', to: '2026-01-16' } as const;
const DIVERGENCE_RANGE = { from: '2026-01-17', to: '2026-01-17' } as const;
const BOUNDARY = new Date('2026-01-15T21:00:00.000Z');
const BEFORE_BOUNDARY = new Date(BOUNDARY.getTime() - 1);
const GENERATED_AT = new Date('2026-01-20T12:00:00.000Z');
const NEW_ORDER_EFFECTIVE_FROM = '2026-01-16';
const NEW_ORDER_RATE = 800;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function requireRow<T>(rows: readonly T[], predicate: (row: T) => boolean, label: string): T {
  const row = rows.find(predicate);
  if (!row) throw new Error(`Missing payroll acceptance row: ${label}`);
  return row;
}

describe('payroll tariff order cross-contour acceptance (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  const previousDevActor = process.env.AUTH_DEV_XROLE;
  const suffix = randomUUID();
  const operatorId = `payroll-parity-operator-${suffix}`;
  const operatorLogin = `payroll-parity-${suffix}@test.local`;
  const operatorPassword = randomBytes(18).toString('base64url');
  const materialId = 'rmd-base-primary';
  const spoolLabel = `Payroll parity spool ${suffix}`;
  const orderId = `payroll-tariff-parity-${suffix}`;
  const orderName = `Приказ parity ${suffix}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let snapshots: RollProductionCostSnapshotService;
  let operatorPayroll: OperatorPayrollService;
  let directorAuth: Bearer;
  let operatorAuth: Bearer;
  let legacyFact: ProductionFactFixture;
  let boundaryFact: ProductionFactFixture;
  let divergenceFacts: Record<'thin' | 'alabuga' | 'falz', ProductionFactFixture>;
  let legacyClosingPayroll: Awaited<ReturnType<OperatorPayrollService['getClosingPayroll']>>;
  let boundaryClosingPayroll: Awaited<ReturnType<OperatorPayrollService['getClosingPayroll']>>;
  let frozenCostBeforePublication: Awaited<
    ReturnType<PrismaService['rollProductionCostSnapshot']['findFirstOrThrow']>
  >;
  let frozenCloseBeforePublication: Awaited<
    ReturnType<PrismaService['operatorShiftCloseCommand']['findUniqueOrThrow']>
  >;

  async function createFact(input: {
    label: string;
    postName: string;
    producedAt: Date;
    endedAt: Date;
    rollKg: number;
    filmType: string;
    counterpartyLegalName: string;
    birka?: string;
  }): Promise<ProductionFactFixture> {
    const id = `${input.label}-${suffix}`;
    const startedAt = new Date(input.endedAt.getTime() - 8 * 60 * 60 * 1_000);
    const postId = `payroll-post-${id}`;
    const shiftId = `payroll-shift-${id}`;
    const assignmentId = `payroll-assignment-${id}`;
    const sessionId = `payroll-session-${id}`;
    const bagId = `payroll-bag-${id}`;
    const usageId = `payroll-usage-${id}`;
    const commercialOrderId = `payroll-commercial-${id}`;
    const productionOrderId = `payroll-production-${id}`;
    const rollId = `payroll-roll-${id}`;
    const lineId = `payroll-line-${id}`;

    await prisma.$transaction(async (tx) => {
      const counterparty = await tx.counterparty.create({
        data: {
          id: `payroll-counterparty-${id}`,
          displayName: `Payroll customer ${input.label}`,
          legalName: input.counterpartyLegalName,
          createdAt: startedAt,
        },
      });
      await tx.commercialOrder.create({
        data: {
          id: commercialOrderId,
          orderNumber: `PAYROLL-${input.label.toUpperCase()}-${suffix}`,
          creatorRole: Role.commercial,
          counterpartyId: counterparty.id,
          createdAt: startedAt,
        },
      });
      await tx.productionOrder.create({
        data: {
          id: productionOrderId,
          commercialOrderId,
          approvalState: 'approved',
          createdAt: startedAt,
        },
      });
      await tx.post.create({
        data: {
          id: postId,
          code: `PAYROLL-${input.label.toUpperCase()}-${suffix}`,
          name: input.postName,
          status: 'active',
        },
      });
      await tx.shift.create({
        data: {
          id: shiftId,
          label: `Payroll shift ${input.label}`,
          plannedStartAt: startedAt,
          plannedEndAt: input.endedAt,
          startedAt,
          endedAt: input.endedAt,
          status: 'closed',
          createdAt: startedAt,
        },
      });
      await tx.operatorShiftMachineAssignment.create({
        data: {
          id: assignmentId,
          shiftId,
          operatorId,
          postId,
          status: 'completed',
          lockedAt: startedAt,
          createdAt: startedAt,
        },
      });
      await tx.operatorPostSession.create({
        data: {
          id: sessionId,
          operatorId,
          postId,
          shiftId,
          status: 'closed',
          startedAt,
          endedAt: input.endedAt,
        },
      });
      await tx.bigBagUnit.create({
        data: {
          id: bagId,
          code: `PAYROLL-BAG-${input.label.toUpperCase()}-${suffix}`,
          material: 'ПВД первичный',
          materialSelectionKind: 'material',
          baseRawMaterialDefinitionId: materialId,
          initialKg: 100,
          currentKg: 100 - input.rollKg,
          lastMeasuredKg: 100 - input.rollKg,
          priceKopecksPerKg: 1_000,
          priceSource: 'Payroll parity fixture',
          priceEffectiveAt: startedAt,
          status: 'available',
          registrationStatus: 'registered',
          location: 'production',
          createdByRole: Role.warehouse,
          createdAt: startedAt,
        },
      });
      await tx.shiftBagUsage.create({
        data: {
          id: usageId,
          sessionId,
          bigBagId: bagId,
          startKg: 100,
          endKg: 100 - input.rollKg,
          sequence: 1,
          createdAt: startedAt,
          closedAt: input.endedAt,
          episodes: {
            create: {
              sequence: 1,
              startKg: 100,
              endKg: 100 - input.rollKg,
              openedAt: startedAt,
              closedAt: input.endedAt,
              closeKind: 'shift_closed',
            },
          },
        },
      });
      await tx.rollDispatchItem.create({
        data: {
          id: rollId,
          rollCode: `PAYROLL-ROLL-${input.label.toUpperCase()}-${suffix}`,
          productionOrderId,
          positionSequence: 1,
          filmType: input.filmType,
          plannedWeightKg: input.rollKg,
          widthMm: 1_000,
          characteristicsSnapshot: {
            birka: input.birka ?? 'ГОСТ',
            spoolType: spoolLabel,
            widthMm: 1_000,
            recipe: {
              ingredients: [{ rawMaterialDefinitionId: materialId, shareBasisPoints: 10_000 }],
            },
          },
          assignedOperatorId: operatorId,
          machineId: `PAYROLL-${input.label.toUpperCase()}-${suffix}`,
          postId,
          plannedShiftId: shiftId,
          status: 'done',
          completedAt: input.endedAt,
          createdAt: startedAt,
          operatorLine: {
            create: {
              id: lineId,
              sequence: 1,
              planKg: input.rollKg,
              netKg: input.rollKg,
              step: 'warehouse',
              warehouseState: 'ready',
              createdAt: startedAt,
            },
          },
        },
      });
      await tx.weightCapture.create({
        data: {
          id: `payroll-capture-${id}`,
          operatorRollLineId: lineId,
          kind: 'roll',
          stable: true,
          netKg: input.rollKg,
          actorRole: Role.operator,
          actorId: operatorId,
          postId,
          postSessionId: sessionId,
          createdAt: input.producedAt,
        },
      });
    });

    return { assignmentId, postId, rollId, sessionId, shiftId };
  }

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'off';
    // AppModule reads the authentication mode during module loading.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    prisma = moduleRef.get(PrismaService);
    snapshots = moduleRef.get(RollProductionCostSnapshotService);
    operatorPayroll = moduleRef.get(OperatorPayrollService);
    await initializeE2eApp(app);

    const director = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('director') },
    });
    await prisma.user.create({
      data: {
        id: operatorId,
        externalId: operatorId,
        login: operatorLogin,
        passwordHash: hashPassword(operatorPassword),
        displayName: 'Payroll parity operator',
        role: Role.operator,
      },
    });
    await prisma.spoolPriceReference.create({
      data: {
        operationKey: randomUUID(),
        requestFingerprint: 'a'.repeat(64),
        spoolTypeKey: normalizeSpoolTypeKey(spoolLabel),
        spoolTypeLabel: spoolLabel,
        priceKopecksPerMeter: 100n,
        source: 'Payroll parity fixture',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        reason: 'Cross-contour acceptance fixture',
        createdById: director.id,
        createdByRole: Role.director,
      },
    });

    const nextMatrix = structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
    nextMatrix.ladders.urp12h[0]!.primaryRateKopecksPerKg = NEW_ORDER_RATE;
    await prisma.payrollTariffOrder.create({
      data: {
        id: orderId,
        name: orderName,
        status: 'draft',
        effectiveFrom: BOUNDARY,
        currency: 'RUB',
        matrix: nextMatrix as unknown as Prisma.InputJsonValue,
        revision: 1,
        createdById: director.id,
        updatedById: director.id,
      },
    });

    legacyFact = await createFact({
      label: 'legacy',
      postName: 'УРП',
      producedAt: BEFORE_BOUNDARY,
      endedAt: BEFORE_BOUNDARY,
      rollKg: 10,
      filmType: 'Прозрачная',
      counterpartyLegalName: 'ООО Payroll legacy',
    });
    await expect(
      snapshots.reconcileRollIds([legacyFact.rollId], GENERATED_AT),
    ).resolves.toMatchObject({ created: 1 });
    legacyClosingPayroll = await operatorPayroll.getClosingPayroll(prisma, {
      operatorId,
      sessionId: legacyFact.sessionId,
      shiftId: legacyFact.shiftId,
      postId: legacyFact.postId,
      generatedAt: GENERATED_AT,
    });
    await prisma.operatorShiftCloseCommand.create({
      data: {
        operationKey: randomUUID(),
        requestFingerprint: 'b'.repeat(64),
        operatorId,
        sessionId: legacyFact.sessionId,
        shiftId: legacyFact.shiftId,
        postId: legacyFact.postId,
        assignmentId: legacyFact.assignmentId,
        actorRole: Role.operator,
        resultSnapshot: json({
          balance: {
            producedKg: 10,
            defectKg: 0,
            expectedUsageKg: 10,
            actualUsageKg: 10,
            deviationPercent: 0,
            status: 'ok',
          },
          problemId: null,
          releasedRollIds: [],
          closingPayroll: legacyClosingPayroll,
        }),
      },
    });
    frozenCostBeforePublication = await prisma.rollProductionCostSnapshot.findFirstOrThrow({
      where: { rollDispatchItemId: legacyFact.rollId },
      orderBy: { version: 'desc' },
    });
    frozenCloseBeforePublication = await prisma.operatorShiftCloseCommand.findUniqueOrThrow({
      where: { sessionId: legacyFact.sessionId },
    });

    await prisma.payrollTariffOrder.update({
      where: { id: orderId },
      data: {
        status: 'published',
        publishedAt: new Date('2026-01-14T12:00:00.000Z'),
        publishedById: director.id,
        updatedById: director.id,
      },
    });

    boundaryFact = await createFact({
      label: 'boundary',
      postName: 'УРП',
      producedAt: BOUNDARY,
      endedAt: BOUNDARY,
      rollKg: 10,
      filmType: 'Прозрачная',
      counterpartyLegalName: 'ООО Payroll boundary',
    });
    boundaryClosingPayroll = await operatorPayroll.getClosingPayroll(prisma, {
      operatorId,
      sessionId: boundaryFact.sessionId,
      shiftId: boundaryFact.shiftId,
      postId: boundaryFact.postId,
      generatedAt: GENERATED_AT,
    });

    divergenceFacts = {
      thin: await createFact({
        label: 'thin',
        postName: 'УРП',
        producedAt: new Date('2026-01-17T08:00:00.000Z'),
        endedAt: new Date('2026-01-17T09:00:00.000Z'),
        rollKg: 6,
        filmType: 'Прозрачная',
        counterpartyLegalName: 'ООО Payroll thin',
      }),
      alabuga: await createFact({
        label: 'alabuga',
        postName: 'АВС новая',
        producedAt: new Date('2026-01-17T10:00:00.000Z'),
        endedAt: new Date('2026-01-17T11:00:00.000Z'),
        rollKg: 10,
        filmType: 'Прозрачная',
        counterpartyLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
      }),
      falz: await createFact({
        label: 'falz',
        postName: 'АВС старая',
        producedAt: new Date('2026-01-17T12:00:00.000Z'),
        endedAt: new Date('2026-01-17T13:00:00.000Z'),
        rollKg: 10,
        filmType: 'Фальц',
        counterpartyLegalName: 'ООО Payroll Falz',
      }),
    };

    const [directorLogin, operatorLoginResponse] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('director'), password: e2eSeedPassword() })
        .expect(201),
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: operatorLogin, password: operatorPassword })
        .expect(201),
    ]);
    directorAuth = { Authorization: `Bearer ${directorLogin.body.token as string}` };
    operatorAuth = { Authorization: `Bearer ${operatorLoginResponse.body.token as string}` };
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        { label: 'payroll tariff cross-contour application', run: async () => app?.close() },
        {
          label: 'payroll tariff cross-contour auth environment',
          run: () => {
            if (previousDevActor === undefined) delete process.env.AUTH_DEV_XROLE;
            else process.env.AUTH_DEV_XROLE = previousDevActor;
          },
        },
      ],
    );
  });

  it('keeps exact parity across Control, salary, operator, closing and roll cost at the boundary', async () => {
    const [analyticsResponse, directorResponse, operatorResponse, costResponse] = await Promise.all(
      [
        request(app.getHttpServer())
          .get('/api/director/analytics')
          .set(directorAuth)
          .query({ ...RANGE, bucket: 'day' })
          .expect(200),
        request(app.getHttpServer())
          .get('/api/director/payroll-preview')
          .set(directorAuth)
          .query(RANGE)
          .expect(200),
        request(app.getHttpServer())
          .get('/api/operator/payroll')
          .set(operatorAuth)
          .query(RANGE)
          .expect(200),
        request(app.getHttpServer())
          .get('/api/director/roll-costs')
          .set(directorAuth)
          .query(RANGE)
          .expect(200),
      ],
    );
    const analytics = analyticsResponse.body as { shiftBalances: AnalyticsPayrollRow[] };
    const director = directorResponse.body as PayrollPreview;
    const operator = operatorResponse.body as PayrollPreview;
    const costs = costResponse.body as { rows: RollCostRow[] };

    const fixtures = [
      {
        label: 'legacy',
        fact: legacyFact,
        orderId: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
        orderName: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.name,
        effectiveFrom: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.effectiveFrom,
        rate: 400,
        amount: 4_000,
        closing: legacyClosingPayroll,
      },
      {
        label: 'boundary',
        fact: boundaryFact,
        orderId,
        orderName,
        effectiveFrom: NEW_ORDER_EFFECTIVE_FROM,
        rate: NEW_ORDER_RATE,
        amount: 8_000,
        closing: boundaryClosingPayroll,
      },
    ] as const;

    for (const expected of fixtures) {
      const control = requireRow(
        analytics.shiftBalances,
        (row) => row.sessionId === expected.fact.sessionId,
        `${expected.label} Control`,
      );
      const directorRow = requireRow(
        director.breakdown,
        (row) => row.shiftId === expected.fact.shiftId,
        `${expected.label} director`,
      );
      const operatorRow = requireRow(
        operator.breakdown,
        (row) => row.shiftId === expected.fact.shiftId,
        `${expected.label} operator`,
      );
      const closingRow = requireRow(
        expected.closing.breakdown,
        (row) => row.shiftId === expected.fact.shiftId,
        `${expected.label} closing`,
      );
      const cost = requireRow(
        costs.rows,
        (row) => row.rollId === expected.fact.rollId,
        `${expected.label} cost`,
      );

      expect(control.payroll).toMatchObject({
        status: 'resolved',
        tariffOrder: {
          id: expected.orderId,
          name: expected.orderName,
          effectiveFrom: expected.effectiveFrom,
        },
        rateKopecksPerKg: expected.rate,
        amountKopecks: expected.amount,
      });
      expect(directorRow).toMatchObject({
        tariffOrderId: expected.orderId,
        rateKopecksPerKg: expected.rate,
        amountKopecks: expected.amount,
      });
      expect(operatorRow).toMatchObject({
        tariffOrderId: expected.orderId,
        rateKopecksPerKg: expected.rate,
        amountKopecks: expected.amount,
      });
      expect(closingRow).toMatchObject({
        tariffOrderId: expected.orderId,
        rateKopecksPerKg: expected.rate,
        amountKopecks: expected.amount,
      });
      expect(cost).toMatchObject({
        payrollAmountKopecks: expected.amount,
        payrollSource: {
          tariffOrderId: expected.orderId,
          tariffOrderName: expected.orderName,
          effectiveFrom: expected.effectiveFrom,
          rateKopecksPerKg: expected.rate,
        },
      });
      expect([
        control.payroll.status === 'resolved' ? control.payroll.amountKopecks : null,
        directorRow.amountKopecks,
        operatorRow.amountKopecks,
        closingRow.amountKopecks,
        cost.payrollAmountKopecks,
      ]).toEqual(Array(5).fill(expected.amount));
    }

    expect(operator.summary.payableAmountKopecks).toBe(12_000);
    expect(
      director.breakdown
        .filter((row) => [legacyFact.shiftId, boundaryFact.shiftId].includes(row.shiftId))
        .reduce((sum, row) => sum + row.amountKopecks, 0),
    ).toBe(12_000);
    expect(director.appliedTariffOrders.map(({ id }) => id)).toEqual([
      LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
      orderId,
    ]);
    expect(operator.appliedTariffOrders.map(({ id }) => id)).toEqual([
      LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
      orderId,
    ]);
    expect(
      JSON.stringify([
        analyticsResponse.body,
        directorResponse.body,
        operatorResponse.body,
        costResponse.body,
      ]),
    ).not.toMatch(/rawPayload|sourceSnapshot|password|token|device/iu);
  });

  it('keeps frozen historical facts unchanged after the future order is published', async () => {
    const [frozenCost, frozenClose] = await Promise.all([
      prisma.rollProductionCostSnapshot.findFirstOrThrow({
        where: { rollDispatchItemId: legacyFact.rollId },
        orderBy: { version: 'desc' },
      }),
      prisma.operatorShiftCloseCommand.findUniqueOrThrow({
        where: { sessionId: legacyFact.sessionId },
      }),
    ]);
    expect(frozenCost).toEqual(frozenCostBeforePublication);
    expect(frozenClose).toEqual(frozenCloseBeforePublication);
    await expect(
      prisma.rollProductionCostSnapshot.count({
        where: { rollDispatchItemId: legacyFact.rollId },
      }),
    ).resolves.toBe(1);

    const replay = await operatorPayroll.parseClosingResult(prisma, frozenClose.resultSnapshot, {
      sessionId: legacyFact.sessionId,
      shiftId: legacyFact.shiftId,
      postId: legacyFact.postId,
    });
    expect(replay.closingPayroll).toEqual(legacyClosingPayroll);
    expect(replay.closingPayroll.appliedTariffOrders).toEqual([
      LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE,
    ]);
    expect(JSON.stringify(replay)).not.toMatch(/rawPayload|sourceSnapshot|password|token|device/iu);
  });

  it('applies thin-roll pay to shifts while preserving the separate ABC cost rules', async () => {
    const [analyticsResponse, costResponse] = await Promise.all([
      request(app.getHttpServer())
        .get('/api/director/analytics')
        .set(directorAuth)
        .query({ ...DIVERGENCE_RANGE, bucket: 'day' })
        .expect(200),
      request(app.getHttpServer())
        .get('/api/director/roll-costs')
        .set(directorAuth)
        .query(DIVERGENCE_RANGE)
        .expect(200),
    ]);
    const analytics = analyticsResponse.body as { shiftBalances: AnalyticsPayrollRow[] };
    const costs = costResponse.body as { rows: RollCostRow[] };
    const expectations = [
      {
        label: 'thin',
        fact: divergenceFacts.thin,
        shiftRate: 650,
        shiftAmount: 3_900,
        rollRate: 650,
        rollAmount: 3_900,
      },
      {
        label: 'Alabuga',
        fact: divergenceFacts.alabuga,
        shiftRate: 450,
        shiftAmount: 4_500,
        rollRate: 400,
        rollAmount: 4_000,
      },
      {
        label: 'falz',
        fact: divergenceFacts.falz,
        shiftRate: 450,
        shiftAmount: 4_500,
        rollRate: 500,
        rollAmount: 5_000,
      },
    ] as const;

    for (const expected of expectations) {
      const control = requireRow(
        analytics.shiftBalances,
        (row) => row.sessionId === expected.fact.sessionId,
        `${expected.label} Control`,
      );
      const cost = requireRow(
        costs.rows,
        (row) => row.rollId === expected.fact.rollId,
        `${expected.label} cost`,
      );
      expect(control.payroll).toMatchObject({
        status: 'resolved',
        tariffOrder: { id: orderId },
        rateKopecksPerKg: expected.shiftRate,
        amountKopecks: expected.shiftAmount,
      });
      expect(cost).toMatchObject({
        payrollAmountKopecks: expected.rollAmount,
        payrollSource: {
          tariffOrderId: orderId,
          rateKopecksPerKg: expected.rollRate,
        },
      });
      if (expected.label === 'thin') {
        expect(cost.payrollAmountKopecks).toBe(expected.shiftAmount);
      } else {
        expect(cost.payrollAmountKopecks).not.toBe(expected.shiftAmount);
        expect(cost.payrollSource?.rateKopecksPerKg).not.toBe(expected.shiftRate);
      }
    }
  });

  it('keeps mixed tag pay consistent across director, operator, Control and closing replay', async () => {
    const fixture = await createFact({
      label: 'mixed',
      postName: 'УРП',
      birka: 'ГОСТ103',
      rollKg: 40,
      producedAt: new Date('2026-01-18T08:00:00.000Z'),
      endedAt: new Date('2026-01-18T09:00:00.000Z'),
      filmType: 'Прозрачная',
      counterpartyLegalName: 'ООО Mixed',
    });
    const firstRoll = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { id: fixture.rollId },
    });
    const secondId = `${fixture.rollId}-secondary`;
    await prisma.rollDispatchItem.create({
      data: {
        id: secondId,
        rollCode: secondId,
        productionOrderId: firstRoll.productionOrderId,
        positionSequence: 2,
        filmType: 'Прозрачная',
        plannedWeightKg: 40,
        characteristicsSnapshot: {
          ...(firstRoll.characteristicsSnapshot as Prisma.JsonObject),
          birka: '(i)',
        },
        assignedOperatorId: operatorId,
        postId: fixture.postId,
        plannedShiftId: fixture.shiftId,
        status: 'done',
        completedAt: new Date('2026-01-18T09:00:00.000Z'),
        operatorLine: {
          create: {
            id: secondId,
            sequence: 2,
            planKg: 40,
            netKg: 40,
            step: 'warehouse',
            warehouseState: 'ready',
          },
        },
      },
    });
    await prisma.weightCapture.create({
      data: {
        operatorRollLineId: secondId,
        kind: 'roll',
        stable: true,
        netKg: 40,
        actorRole: Role.operator,
        actorId: operatorId,
        postId: fixture.postId,
        postSessionId: fixture.sessionId,
        createdAt: new Date('2026-01-18T08:30:00.000Z'),
      },
    });
    const range = { from: '2026-01-18', to: '2026-01-18' };
    const expectedAmount = 40 * NEW_ORDER_RATE + 40 * 500;
    for (const [path, auth] of [
      ['/api/director/payroll-preview', directorAuth],
      ['/api/operator/payroll', operatorAuth],
    ] as const) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set(auth)
        .query(range)
        .expect(200);
      expect(
        response.body.breakdown.filter(
          (row: PayrollBreakdownRow) => row.shiftId === fixture.shiftId,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            materialClass: 'primary',
            payableKg: 40,
            rateKopecksPerKg: NEW_ORDER_RATE,
          }),
          expect.objectContaining({
            materialClass: 'secondary',
            payableKg: 40,
            rateKopecksPerKg: 500,
          }),
        ]),
      );
      expect(response.body.summary.payableAmountKopecks).toBe(expectedAmount);
    }
    const analytics = await request(app.getHttpServer())
      .get('/api/director/analytics')
      .set(directorAuth)
      .query({ ...range, bucket: 'day' })
      .expect(200);
    expect(
      analytics.body.shiftBalances.find(
        (row: AnalyticsPayrollRow) => row.sessionId === fixture.sessionId,
      ).payroll,
    ).toMatchObject({
      status: 'resolved',
      rateKopecksPerKg: null,
      tariffRule: null,
      amountKopecks: expectedAmount,
    });
    const closingPayroll = await operatorPayroll.getClosingPayroll(prisma, {
      operatorId,
      sessionId: fixture.sessionId,
      shiftId: fixture.shiftId,
      postId: fixture.postId,
      generatedAt: GENERATED_AT,
    });
    const replay = await operatorPayroll.parseClosingResult(
      prisma,
      json({
        balance: {
          producedKg: 80,
          defectKg: 0,
          expectedUsageKg: 80,
          actualUsageKg: 40,
          deviationPercent: -50,
          status: 'mismatch',
        },
        problemId: null,
        releasedRollIds: [],
        closingPayroll,
      }),
      fixture,
    );
    expect(replay.closingPayroll.summary.payableAmountKopecks).toBe(expectedAmount);
  });
});
