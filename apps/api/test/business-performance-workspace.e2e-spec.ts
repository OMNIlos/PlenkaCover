import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  BusinessOperationalProblemPage,
  BusinessPerformanceRollPage,
  CommercialPerformanceControl,
  CommercialPerformanceFinanceItem,
  CommercialPerformancePage,
  CommercialPerformanceProductionItem,
  WarehouseBusinessPage,
} from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../src/modules/warehouse-coverage/warehouse-coverage-canonical';
import { WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION } from '../src/modules/warehouse-coverage/warehouse-roll-coverage-fact.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Account =
  | 'commercial'
  | 'director'
  | 'production'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'admin';

type AuthSession = {
  headers: { Authorization: string };
  userId: string;
};

type Fixture = {
  dispatchIds: [string, string, string];
  financeOrderId: string;
  internalEvidenceValues: string[];
  orderId: string;
  orderNumber: string;
  problemIds: {
    defectA: string;
    defectZ: string;
    machine: string;
    overweight: string;
  };
  productionOrderId: string;
  rollCodes: [string, string, string];
};

type ProblemTraversal = {
  items: BusinessOperationalProblemPage['items'];
  pages: BusinessOperationalProblemPage[];
};

const ACCOUNTS: readonly Account[] = [
  'commercial',
  'director',
  'production',
  'operator',
  'warehouse',
  'finance',
  'admin',
];
const FORBIDDEN_ACCOUNTS = ['production', 'operator', 'warehouse', 'finance', 'admin'] as const;
const FIXTURE_DAY = '2099-05-17';
const RANGE_QUERY = `from=${FIXTURE_DAY}&to=${FIXTURE_DAY}`;
const OCCURRED_AT = new Date(`${FIXTURE_DAY}T09:00:00.000Z`);
const PROBLEM_AT = new Date(`${FIXTURE_DAY}T10:00:00.000Z`);
const FORBIDDEN_PROJECTION_KEYS = new Set([
  'actorId',
  'deviceId',
  'gatewayCommandId',
  'operationId',
  'parsedPayload',
  'postId',
  'postSessionId',
  'rawPayload',
  'requestFingerprint',
  'safeResult',
  'sessionId',
  'sourceSnapshotId',
  'tokenHash',
  'warehouseOperationId',
]);

function collectKeys(value: unknown, target: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, target);
    return target;
  }
  if (value === null || typeof value !== 'object') return target;
  for (const [key, nested] of Object.entries(value)) {
    target.push(key);
    collectKeys(nested, target);
  }
  return target;
}

function normalizeGeneratedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeGeneratedAt);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === 'generatedAt' ? '<generated-at>' : normalizeGeneratedAt(nested),
    ]),
  );
}

describe('Shared business performance workspace (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let auth: Record<Account, AuthSession>;
  let fixture: Fixture;
  let previousDevRole: string | undefined;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';

    // Import only after the auth mode is fixed: this suite verifies real Bearer sessions.
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
    const sessions = await Promise.all(
      ACCOUNTS.map(async (account) => {
        const response = await http()
          .post('/api/auth/login')
          .send({ login: e2eSeedLogin(account), password })
          .expect(201);
        return [
          account,
          {
            headers: { Authorization: `Bearer ${response.body.token as string}` },
            userId: response.body.user.id as string,
          },
        ] as const;
      }),
    );
    auth = Object.fromEntries(sessions) as Record<Account, AuthSession>;
    fixture = await createFixture();
  });

  afterAll(async () => {
    await app?.close();
    if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousDevRole;
  });

  async function createFixture(): Promise<Fixture> {
    const suffix = randomUUID().slice(0, 8);
    const orderId = `bp-${suffix}-order`;
    const positionId = `bp-${suffix}-position`;
    const productionOrderId = `bp-${suffix}-production`;
    const financeOrderId = `bp-${suffix}-finance`;
    const operatorId = `bp-${suffix}-operator-internal`;
    const postId = `bp-${suffix}-post-internal`;
    const deviceId = `bp-${suffix}-device-internal`;
    const postSessionId = `bp-${suffix}-post-session-internal`;
    const warehouseSessionId = `bp-${suffix}-warehouse-session-internal`;
    const taskId = `bp-${suffix}-task-internal`;
    const scanRowId = `bp-${suffix}-scan-row-internal`;
    const warehouseOperationId = `bp-${suffix}-warehouse-operation-internal`;
    const orderNumber = `BP-${suffix.toUpperCase()}`;
    const rollCodes: [string, string, string] = [
      `BP-${suffix}-ROLL-A`,
      `BP-${suffix}-ROLL-B`,
      `BP-${suffix}-ROLL-C`,
    ];
    const dispatchIds: [string, string, string] = [
      `bp-${suffix}-dispatch-a`,
      `bp-${suffix}-dispatch-b`,
      `bp-${suffix}-dispatch-c`,
    ];
    const lineId = `bp-${suffix}-line`;
    const rollCaptureId = `bp-${suffix}-roll-weight`;
    const problemIds = {
      defectA: `bp-${suffix}-problem-defect-a`,
      defectZ: `bp-${suffix}-problem-defect-z`,
      machine: `bp-${suffix}-problem-machine`,
      overweight: `bp-${suffix}-event-weight`,
    };
    const rawCanary = `RAW_DEVICE_PAYLOAD_${suffix}`;
    const parsedCanary = `PARSED_DEVICE_PAYLOAD_${suffix}`;
    const snapshotCanary = `SOURCE_SNAPSHOT_SECRET_${suffix}`;

    const counterparty = await prisma.counterparty.create({
      data: {
        id: `bp-${suffix}-counterparty`,
        displayName: `Покупатель ${suffix}`,
        legalName: `Скрытое юридическое имя ${suffix}`,
      },
    });
    await prisma.commercialOrder.create({
      data: {
        id: orderId,
        orderNumber,
        title: `Business performance ${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
        commercialStage: 'in_work',
        productionIndicator: 'in_progress',
        warehouseCoverStatus: 'partial',
        paymentStatus: 'partial',
        shipmentStatus: 'not_shipped',
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
        positions: {
          create: {
            id: positionId,
            rollCount: 3,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            plannedWeightKg: 40,
            widthMm: 1700,
            plannedLengthM: 275,
          },
        },
      },
    });
    await prisma.financeOrder.create({
      data: {
        id: financeOrderId,
        commercialOrderId: orderId,
        invoiceStatus: 'invoiced',
        invoiceNumber: `INV-${suffix}`,
        invoiceCurrency: 'RUB',
        paymentStatus: 'partial',
        amountValue: 1200,
        sourceStatus: 'ready',
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
        policy: {
          create: {
            installmentDays: 30,
            capturedInvoiceAmount: 1200,
            capturedInvoiceCurrency: 'RUB',
            stages: {
              create: [
                {
                  sequence: 1,
                  trigger: 'invoice_issued',
                  percentageBasisPoints: 5000,
                  offsetDays: 0,
                },
                {
                  sequence: 2,
                  trigger: 'full_shipment',
                  percentageBasisPoints: 5000,
                  offsetDays: 30,
                },
              ],
            },
          },
        },
        schedules: {
          create: [
            {
              percentageBasisPoints: 5000,
              offsetDays: 0,
              kind: 'invoice_prepayment',
              dueDate: OCCURRED_AT,
              amount: 600,
              status: 'paid',
            },
            {
              percentageBasisPoints: 5000,
              offsetDays: 30,
              kind: 'post_delivery',
              dueDate: new Date('2099-06-16T09:00:00.000Z'),
              amount: 600,
              status: 'unpaid',
            },
          ],
        },
      },
    });

    await prisma.user.create({
      data: {
        id: operatorId,
        login: `bp-operator-${suffix}`,
        displayName: `Оператор ${suffix}`,
        role: 'operator',
      },
    });
    await prisma.post.create({
      data: {
        id: postId,
        code: `BP-POST-${suffix}`,
        name: `Экструдер ${suffix}`,
        status: 'active',
        agentTokenHash: `AGENT_TOKEN_HASH_${suffix}`,
      },
    });
    await prisma.deviceRuntime.create({
      data: {
        id: deviceId,
        code: `BP-SCALE-${suffix}`,
        label: `Весы ${suffix}`,
        kind: 'scale',
        status: 'ready',
        isEnabled: true,
        postId,
        parsedPayload: { secret: parsedCanary },
        rawPayload: { secret: rawCanary },
      },
    });
    await prisma.operatorPostSession.create({
      data: {
        id: postSessionId,
        operatorId,
        postId,
        status: 'closed',
        startedAt: new Date('2099-05-17T08:00:00.000Z'),
        endedAt: new Date('2099-05-17T11:00:00.000Z'),
      },
    });
    await prisma.productionOrder.create({
      data: {
        id: productionOrderId,
        commercialOrderId: orderId,
        indicator: 'in_progress',
        approvalState: 'approved',
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      },
    });
    await prisma.rollDispatchItem.create({
      data: {
        id: dispatchIds[0],
        rollCode: rollCodes[0],
        productionOrderId,
        orderLineId: positionId,
        positionSequence: 1,
        filmType: 'Рукав',
        plannedWeightKg: 40,
        widthMm: 1700,
        plannedLengthM: 275,
        assignedOperatorId: operatorId,
        postId,
        machineId: `MACHINE_SECRET_${suffix}`,
        workplaceId: `WORKPLACE_SECRET_${suffix}`,
        priority: 3,
        status: 'done',
        completedAt: OCCURRED_AT,
        characteristicsSnapshot: {
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          widthMm: '1700 мм',
          plannedLengthM: '275 м',
          plannedWeightKg: '40 кг',
          rawPayload: rawCanary,
          postId,
          sourceSnapshot: { secret: snapshotCanary },
        },
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
        operatorLine: {
          create: {
            id: lineId,
            sequence: 1,
            planKg: 40,
            spoolKg: 2,
            grossKg: 44.5,
            netKg: 42.5,
            toleranceOk: false,
            step: 'warehouse',
            warehouseState: 'received',
            createdAt: OCCURRED_AT,
            updatedAt: OCCURRED_AT,
          },
        },
      },
    });
    await prisma.rollDispatchItem.createMany({
      data: [
        {
          id: dispatchIds[1],
          rollCode: rollCodes[1],
          productionOrderId,
          orderLineId: positionId,
          positionSequence: 2,
          plannedWeightKg: 41,
          priority: 2,
          status: 'assigned',
          characteristicsSnapshot: {
            filmType: 'Полотно',
            actualThickness: '60 мкм',
            accountingThickness: '58 мкм',
            widthMm: 1400,
            plannedLengthM: 300,
            plannedWeightKg: 41,
          },
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
        },
        {
          id: dispatchIds[2],
          rollCode: rollCodes[2],
          productionOrderId,
          orderLineId: positionId,
          positionSequence: 3,
          plannedWeightKg: 42,
          priority: 1,
          status: 'new',
          characteristicsSnapshot: {
            filmType: 'Рукав',
            actualThickness: '100 мкм',
            accountingThickness: '98 мкм',
            widthMm: 1200,
            plannedLengthM: 250,
            plannedWeightKg: 42,
          },
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
        },
      ],
    });
    await prisma.weightCapture.create({
      data: {
        id: rollCaptureId,
        operatorRollLineId: lineId,
        kind: 'roll',
        deviceId,
        deviceStatus: 'ready',
        stable: true,
        grossKg: 44.5,
        spoolKg: 2,
        netKg: 42.5,
        toleranceOk: false,
        actorRole: 'operator',
        actorId: operatorId,
        postId,
        postSessionId,
        createdAt: OCCURRED_AT,
      },
    });
    const defect = await prisma.defectRecord.create({
      data: {
        id: `bp-${suffix}-defect-record`,
        operatorRollLineId: lineId,
        weightCaptureId: rollCaptureId,
        sourceRole: 'operator',
        weightKg: 3.25,
        comment: 'Проверочный брак',
        blocking: true,
        createdAt: PROBLEM_AT,
      },
    });
    await prisma.productionProblem.createMany({
      data: [
        {
          id: problemIds.defectZ,
          orderId,
          positionId,
          rollId: rollCodes[0],
          actorRole: 'operator',
          reason: 'Брак полотна',
          status: 'open',
          type: 'defect',
          defectRecordId: defect.id,
          createdAt: PROBLEM_AT,
        },
        {
          id: problemIds.defectA,
          orderId,
          positionId,
          rollId: rollCodes[1],
          actorRole: 'operator',
          reason: 'Повторный контроль качества',
          status: 'resolved',
          type: 'defect',
          resolvedAt: PROBLEM_AT,
          createdAt: PROBLEM_AT,
        },
        {
          id: problemIds.machine,
          postId,
          actorRole: 'operator',
          reason: 'Остановка привода',
          status: 'open',
          type: 'machine_breakdown',
          createdAt: PROBLEM_AT,
        },
      ],
    });

    const warehouseClientRollId = `bp-${suffix}-warehouse-client-roll`;
    await prisma.warehouseRoll.createMany({
      data: [
        {
          id: warehouseClientRollId,
          rollCode: rollCodes[0],
          ownerCounterpartyId: counterparty.id,
          reservedForOrderId: orderId,
          warehouseStatus: 'received',
          receivedAt: OCCURRED_AT,
          positionSnapshot: { sourceSnapshot: snapshotCanary },
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
        },
        {
          id: `bp-${suffix}-warehouse-reserve-roll`,
          rollCode: `BP-${suffix}-RESERVE`,
          reservedForOrderId: orderId,
          reservedForPositionId: positionId,
          warehouseStatus: 'received',
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
        },
      ],
    });
    const coverageSpec = canonicalizeRollCoverageSpec({
      rollCode: rollCodes[0],
      sourceOrderId: orderId,
      sourcePositionId: positionId,
      ownerCounterpartyId: counterparty.id,
      filmType: 'Рукав',
      actualThicknessMilliMicron: 80_000,
      accountingThicknessMilliMicron: 78_000,
      widthMilliMm: 1_700_000,
      plannedLengthMilliM: 275_000,
      birka: 'Business performance',
      spoolType: '76 мм',
      actualWeightMilliKg: 42_500,
      plannedWeightMilliKg: 40_000,
      ingredients: [
        {
          rawMaterialDefinitionId: `bp-${suffix}-material`,
          shareBasisPoints: 10_000,
        },
      ],
      recipeId: null,
      recipeVersion: null,
      recipeDefinitionId: null,
      recipeDefinitionVersionId: null,
      recipeVersionNumber: null,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
    const coverageFact = await prisma.warehouseRollCoverageFact.create({
      data: {
        rollId: warehouseClientRollId,
        version: 1,
        source: 'migration_backfill',
        specVersion: WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION,
        specFingerprint: fingerprintRollFact(coverageSpec),
        spec: coverageSpec as unknown as Prisma.InputJsonValue,
        sourceOrderId: orderId,
        sourcePositionId: positionId,
        actorKind: 'system',
        systemActorKey: 'warehouse_coverage_engine',
      },
    });
    await prisma.warehouseRoll.update({
      where: { id: warehouseClientRollId },
      data: { currentCoverageFactId: coverageFact.id },
    });
    await prisma.session.create({
      data: {
        id: warehouseSessionId,
        userId: auth.warehouse.userId,
        tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        expiresAt: new Date('2100-01-01T00:00:00.000Z'),
        purpose: 'full',
        warehousePostId: postId,
        warehousePostBoundAt: OCCURRED_AT,
      },
    });
    await prisma.warehouseAcceptanceTask.create({
      data: {
        id: taskId,
        mode: 'receiving',
        status: 'closed',
        operationCode: `BP-${suffix}`,
        orderId,
        positionId,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      },
    });
    await prisma.scanRow.create({
      data: {
        id: scanRowId,
        taskId,
        rollCode: rollCodes[0],
        fromOrderId: orderId,
        scanStatus: 'accepted',
        lastScanAt: OCCURRED_AT,
      },
    });
    await prisma.warehouseOperation.create({
      data: {
        id: warehouseOperationId,
        operationKey: randomUUID(),
        kind: 'control_weight',
        status: 'succeeded',
        taskId,
        scanRowId,
        rollCode: rollCodes[0],
        actorId: auth.warehouse.userId,
        sessionId: warehouseSessionId,
        postId,
        deviceId,
        requestFingerprint: 'f'.repeat(64),
        safeResult: {
          operationId: warehouseOperationId,
          taskId,
          rollCode: rollCodes[0],
          grossKg: 47,
          spoolKg: 2,
          netKg: 45,
          toleranceOk: false,
        },
        httpStatus: 200,
        completedAt: PROBLEM_AT,
        createdAt: PROBLEM_AT,
      },
    });
    await prisma.weightCapture.create({
      data: {
        id: `bp-${suffix}-warehouse-weight`,
        operatorRollLineId: lineId,
        kind: 'control',
        deviceId,
        deviceStatus: 'ready',
        stable: true,
        grossKg: 47,
        spoolKg: 2,
        netKg: 45,
        toleranceOk: false,
        actorRole: 'warehouse',
        actorId: auth.warehouse.userId,
        postId,
        warehouseOperationId,
        createdAt: PROBLEM_AT,
      },
    });
    await prisma.domainEvent.create({
      data: {
        id: problemIds.overweight,
        family: 'audit',
        type: 'audit:warehouse_roll_reserved_overweight',
        objectId: rollCodes[0],
        actorRole: 'warehouse',
        actorId: auth.warehouse.userId,
        label: 'Перевес резервного рулона',
        detail: {
          warehouseOperationId,
          taskId,
          rollCode: rollCodes[0],
          deviceId,
          rawPayload: rawCanary,
        },
        createdAt: PROBLEM_AT,
      },
    });

    return {
      dispatchIds,
      financeOrderId,
      internalEvidenceValues: [
        operatorId,
        postId,
        deviceId,
        postSessionId,
        warehouseSessionId,
        taskId,
        scanRowId,
        warehouseOperationId,
        rawCanary,
        parsedCanary,
        snapshotCanary,
      ],
      orderId,
      orderNumber,
      problemIds,
      productionOrderId,
      rollCodes,
    };
  }

  function expectSafeProjection(body: unknown): void {
    const keys = collectKeys(body);
    for (const key of FORBIDDEN_PROJECTION_KEYS) {
      expect(keys).not.toContain(key);
    }
    const serialized = JSON.stringify(body);
    for (const value of fixture.internalEvidenceValues) {
      expect(serialized).not.toContain(value);
    }
  }

  async function getFor<T>(account: Account, path: string): Promise<T> {
    const response = await http().get(path).set(auth[account].headers).expect(200);
    return response.body as T;
  }

  async function expectEqualForBusinessRoles<T>(path: string): Promise<T> {
    const [commercial, director] = await Promise.all([
      getFor<T>('commercial', path),
      getFor<T>('director', path),
    ]);
    expect(normalizeGeneratedAt(commercial)).toEqual(normalizeGeneratedAt(director));
    expectSafeProjection(commercial);
    expectSafeProjection(director);
    return commercial;
  }

  async function traverseProblems(account: Account, limit: number): Promise<ProblemTraversal> {
    const items: BusinessOperationalProblemPage['items'] = [];
    const pages: BusinessOperationalProblemPage[] = [];
    const seenCursors = new Set<string>();
    const seenProblems = new Set<string>();
    let cursor: string | null = null;

    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const requestPath: string =
        `/api/commercial/performance/problems?filter=all&limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const page: BusinessOperationalProblemPage = await getFor<BusinessOperationalProblemPage>(
        account,
        requestPath,
      );
      expectSafeProjection(page);
      pages.push(page);

      for (const item of page.items) {
        const identity = `${item.kind}:${item.id}`;
        expect(seenProblems.has(identity)).toBe(false);
        seenProblems.add(identity);
        items.push(item);
      }

      if (page.nextCursor === null) return { items, pages };
      expect(seenCursors.has(page.nextCursor)).toBe(false);
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    throw new Error('Business problem pagination exceeded the 100-page safety bound.');
  }

  async function expectEqualProblemTraversalForBusinessRoles(
    limit: number,
  ): Promise<ProblemTraversal> {
    const [commercial, director] = await Promise.all([
      traverseProblems('commercial', limit),
      traverseProblems('director', limit),
    ]);
    expect(commercial.pages).toEqual(director.pages);
    return commercial;
  }

  function fixtureProblemCohort(
    items: BusinessOperationalProblemPage['items'],
  ): BusinessOperationalProblemPage['items'] {
    const fixtureIds = new Set(Object.values(fixture.problemIds));
    return items.filter(({ id }) => fixtureIds.has(id));
  }

  it('returns identical safe control, finance, production, warehouse and problem projections', async () => {
    const control = await expectEqualForBusinessRoles<CommercialPerformanceControl>(
      `/api/commercial/performance/control?${RANGE_QUERY}&bucket=day`,
    );
    expect(control.summary).toMatchObject({
      invoicedAmount: 1200,
      paidAmount: 600,
      receivableAmount: 600,
      producedKg: 42.5,
      producedRolls: 1,
      defectKg: 42.5,
      defectRollCount: 1,
      returnedSpoolCount: 0,
      warehouseAcceptedRolls: 1,
    });

    const finance = await expectEqualForBusinessRoles<
      CommercialPerformancePage<CommercialPerformanceFinanceItem>
    >(`/api/commercial/performance/finance?${RANGE_QUERY}&limit=10`);
    expect(finance.items).toContainEqual(
      expect.objectContaining({
        id: fixture.financeOrderId,
        orderNumber: fixture.orderNumber,
        paymentPlanKind: 'half_split',
        paymentPlanLabel: '50/50',
        invoicedAmount: 1200,
        paidAmount: 600,
        remainingAmount: 600,
      }),
    );

    const production = await expectEqualForBusinessRoles<
      CommercialPerformancePage<CommercialPerformanceProductionItem>
    >(`/api/commercial/performance/production?${RANGE_QUERY}&limit=10`);
    expect(production.items).toContainEqual(
      expect.objectContaining({
        id: fixture.productionOrderId,
        orderNumber: fixture.orderNumber,
        plannedRollCount: 3,
        completedRollCount: 1,
        plannedKg: 123,
        actualKg: 42.5,
        defectKg: 3.25,
        defectRollCount: 1,
      }),
    );

    const warehouse = await expectEqualForBusinessRoles<WarehouseBusinessPage>(
      '/api/commercial/performance/warehouse?page=1&pageSize=100',
    );
    expect(warehouse.items).toContainEqual(
      expect.objectContaining({
        kind: 'client_order',
        id: fixture.orderId,
        orderNumber: fixture.orderNumber,
        status: 'awaiting_shipment',
        templates: [
          expect.objectContaining({
            filmType: 'рукав',
            actualThicknessMicron: 80,
            accountingThicknessMicron: 78,
            widthMm: 1700,
            plannedLengthM: 275,
            plannedWeightKg: 40,
          }),
        ],
      }),
    );

    const rolls = await expectEqualForBusinessRoles<BusinessPerformanceRollPage>(
      `/api/commercial/performance/production/${fixture.productionOrderId}/rolls?limit=10`,
    );
    expect(rolls.items).toHaveLength(3);
    expect(rolls.items[0]).toEqual({
      id: fixture.dispatchIds[0],
      rollName: 'Рукав 80 мкм',
      rollCode: fixture.rollCodes[0],
      orderNumber: fixture.orderNumber,
      parameters: {
        filmType: 'Рукав',
        actualThicknessUm: 80,
        accountingThicknessUm: 78,
        widthMm: 1700,
        plannedLengthM: 275,
        weightKg: 42.5,
      },
      operatorName: expect.stringMatching(/^Оператор /),
      machineName: expect.stringMatching(/^Экструдер /),
      priority: 3,
      status: 'warehouse_accepted',
      lifecycleStatus: 'warehouse_accepted',
      createdAt: OCCURRED_AT.toISOString(),
      completedAt: OCCURRED_AT.toISOString(),
      weights: {
        plannedNetKg: 40,
        actualNetKg: 42.5,
        actualGrossKg: 44.5,
        deviationKg: 2.5,
      },
      productionCost: expect.objectContaining({
        kind: 'planned_preview',
        status: 'partial',
        calculationVersion: 'production-cost-v1',
        basis: { kind: 'planned', weightGrams: 40_000 },
      }),
    });

    const problems = await expectEqualProblemTraversalForBusinessRoles(10);
    const fixtureProblems = fixtureProblemCohort(problems.items);
    expect(fixtureProblems.map(({ id }) => id)).toEqual([
      fixture.problemIds.overweight,
      fixture.problemIds.machine,
      fixture.problemIds.defectZ,
      fixture.problemIds.defectA,
    ]);
    expect(fixtureProblems.map(({ kind }) => kind)).toEqual([
      'weight_deviation',
      'machine_breakdown',
      'defect',
      'defect',
    ]);
    expect(fixtureProblems[0]).toEqual({
      id: fixture.problemIds.overweight,
      kind: 'weight_deviation',
      status: 'resolved',
      orderId: fixture.orderId,
      label: 'Перевес рулона: 45 кг при плане 40 кг',
      createdAt: PROBLEM_AT.toISOString(),
      orderNumber: fixture.orderNumber,
      rollCode: fixture.rollCodes[0],
      machineName: expect.stringMatching(/^Экструдер /),
      reason: 'Контрольный вес превысил допустимое отклонение.',
    });
    for (const item of problems.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'createdAt',
          'id',
          'kind',
          'label',
          'machineName',
          'orderId',
          'orderNumber',
          'reason',
          'rollCode',
          'status',
        ].sort(),
      );
    }
  });

  it('paginates production rolls and the equal-time problem cohort deterministically', async () => {
    const rollPath = `/api/commercial/performance/production/${fixture.productionOrderId}/rolls?limit=1`;
    const firstRollPage = await getFor<BusinessPerformanceRollPage>('commercial', rollPath);
    const repeatedRollPage = await getFor<BusinessPerformanceRollPage>('commercial', rollPath);
    expect(firstRollPage).toEqual(repeatedRollPage);
    expect(firstRollPage.items.map(({ id }) => id)).toEqual([fixture.dispatchIds[0]]);
    expect(firstRollPage.nextCursor).toEqual(expect.any(String));

    const secondRollPage = await getFor<BusinessPerformanceRollPage>(
      'commercial',
      `${rollPath}&cursor=${encodeURIComponent(firstRollPage.nextCursor!)}`,
    );
    expect(secondRollPage.items.map(({ id }) => id)).toEqual([fixture.dispatchIds[1]]);
    expect(secondRollPage.nextCursor).toEqual(expect.any(String));
    const thirdRollPage = await getFor<BusinessPerformanceRollPage>(
      'commercial',
      `${rollPath}&cursor=${encodeURIComponent(secondRollPage.nextCursor!)}`,
    );
    expect(thirdRollPage.items.map(({ id }) => id)).toEqual([fixture.dispatchIds[2]]);
    expect(thirdRollPage.nextCursor).toBeNull();

    const firstProblemTraversal = await traverseProblems('commercial', 2);
    const repeatedProblemTraversal = await traverseProblems('commercial', 2);
    expect(firstProblemTraversal.pages).toEqual(repeatedProblemTraversal.pages);
    expect(firstProblemTraversal.pages.length).toBeGreaterThan(1);
    expect(fixtureProblemCohort(firstProblemTraversal.items).map(({ id }) => id)).toEqual([
      fixture.problemIds.overweight,
      fixture.problemIds.machine,
      fixture.problemIds.defectZ,
      fixture.problemIds.defectA,
    ]);
    expectSafeProjection({
      firstRollPage,
      secondRollPage,
      thirdRollPage,
      problemPages: firstProblemTraversal.pages,
    });
  });

  it.each(FORBIDDEN_ACCOUNTS)(
    'denies %s every shared business-performance endpoint',
    async (account) => {
      const paths = [
        `/api/commercial/performance/control?${RANGE_QUERY}&bucket=day`,
        `/api/commercial/performance/finance?${RANGE_QUERY}&limit=10`,
        `/api/commercial/performance/production?${RANGE_QUERY}&limit=10`,
        `/api/commercial/performance/production/${fixture.productionOrderId}/rolls?limit=10`,
        '/api/commercial/performance/warehouse?page=1&pageSize=10',
        '/api/commercial/performance/problems?filter=all&limit=10',
      ];
      for (const path of paths) {
        await http().get(path).set(auth[account].headers).expect(403);
      }
    },
  );
});
