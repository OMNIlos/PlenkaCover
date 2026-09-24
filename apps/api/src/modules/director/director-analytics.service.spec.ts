import type {
  DirectorAnalyticsBigBagEvidencePage,
  DirectorAnalyticsBigBagEvidenceQuery,
  DirectorAnalyticsShiftEvidencePage,
  DirectorAnalyticsShiftEvidenceQuery,
} from '@plenka/contracts';
import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE,
} from '../../common/payroll-tariffs/legacy-payroll-tariff-matrix';
import type { PublishedPayrollTariffOrder } from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';
import {
  attributeBigBagFactsToUsages,
  calculateBigBagBalance,
  DirectorAnalyticsService,
} from './director-analytics.service';
import type { DirectorRollFactSource } from './director-analytics.roll-facts';

const query = {
  from: '2026-07-21',
  to: '2026-07-23',
  bucket: 'day' as const,
};

function publishedOrder(
  id: string,
  effectiveFrom: string,
  primaryRateKopecksPerKg: number,
): PublishedPayrollTariffOrder {
  const matrix = structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
  matrix.ladders.urp12h[0]!.primaryRateKopecksPerKg = primaryRateKopecksPerKg;
  return {
    reference: {
      ...(id === LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id
        ? LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE
        : { id, name: `Приказ ${id}`, effectiveFrom, currency: 'RUB' as const }),
    },
    effectiveFromMs: Date.parse(`${effectiveFrom}T00:00:00+03:00`),
    revision: 1,
    matrix,
    matrixHash: id.padEnd(64, '0').slice(0, 64),
  };
}

const DEFAULT_PAYROLL_SCHEDULE = [
  publishedOrder(
    LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
    LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.effectiveFrom,
    400,
  ),
];

function analyticsService(prisma: unknown): DirectorAnalyticsService {
  return new DirectorAnalyticsService(
    prisma as never,
    { loadPublishedSchedule: jest.fn().mockResolvedValue(DEFAULT_PAYROLL_SCHEDULE) } as never,
    new PayrollTariffResolver(),
  );
}

describe('calculateBigBagBalance', () => {
  it('uses exact gram arithmetic and includes confirmed defect once', () => {
    expect(
      calculateBigBagBalance({
        initialKg: 100.001,
        currentKg: 60,
        producedKg: 35.5,
        confirmedDefectKg: 4.5,
      }),
    ).toEqual({
      actualUsageKg: 40.001,
      calculatedConsumptionKg: 40,
      calculatedRemainderKg: 60.001,
      deviationKg: -0.001,
      deviationPercent: -0.002,
      status: 'ok',
    });
  });

  it('fails closed when a required measurement is absent', () => {
    expect(
      calculateBigBagBalance({
        initialKg: null,
        currentKg: 60,
        producedKg: 35.5,
        confirmedDefectKg: 4.5,
      }),
    ).toEqual({
      actualUsageKg: null,
      calculatedConsumptionKg: null,
      calculatedRemainderKg: null,
      deviationKg: null,
      deviationPercent: null,
      status: 'pending',
    });
  });

  it.each([
    { currentKg: 91, expected: 1 },
    { currentKg: 90, expected: 0 },
    { currentKg: 89, expected: -1 },
  ])('keeps the signed $expected kg remainder deviation exact', ({ currentKg, expected }) => {
    expect(
      calculateBigBagBalance({
        initialKg: 100,
        currentKg,
        producedKg: 8,
        confirmedDefectKg: 2,
      }).deviationKg,
    ).toBe(expected);
  });
});

describe('attributeBigBagFactsToUsages', () => {
  const windows = [
    {
      episodeId: 'episode-a',
      usageId: 'usage-a',
      openedAt: new Date('2026-07-23T08:00:00.000Z'),
      closedAt: new Date('2026-07-23T12:00:00.000Z'),
    },
    {
      episodeId: 'episode-b',
      usageId: 'usage-b',
      openedAt: new Date('2026-07-23T12:00:00.000Z'),
      closedAt: new Date('2026-07-23T18:00:00.000Z'),
    },
  ];

  it('attributes sequential production and confirmed defect facts exactly once', () => {
    const result = attributeBigBagFactsToUsages({
      usageIds: ['usage-a', 'usage-b'],
      windows,
      producedFacts: [
        {
          id: 'roll-a',
          weightKg: 10,
          capturedAt: new Date('2026-07-23T10:00:00.000Z'),
        },
        {
          id: 'roll-b',
          weightKg: 15,
          capturedAt: new Date('2026-07-23T15:00:00.000Z'),
        },
      ],
      confirmedDefectFacts: [
        {
          id: 'defect-b',
          weightKg: 5,
          capturedAt: new Date('2026-07-23T16:00:00.000Z'),
        },
      ],
      unverifiedDefectFacts: [],
    });

    expect(result && Object.fromEntries(result)).toEqual({
      'usage-a': {
        producedKg: 10,
        rollCount: 1,
        confirmedDefectKg: 0,
        defectCount: 0,
        unverifiedDefectCount: 0,
      },
      'usage-b': {
        producedKg: 15,
        rollCount: 1,
        confirmedDefectKg: 5,
        defectCount: 1,
        unverifiedDefectCount: 0,
      },
    });
  });

  it('fails closed for overlapping ownership or a missing capture timestamp', () => {
    const overlapping = [
      windows[0],
      {
        ...windows[1],
        openedAt: new Date('2026-07-23T11:00:00.000Z'),
      },
    ];
    const fact = {
      id: 'roll-ambiguous',
      weightKg: 10,
      capturedAt: new Date('2026-07-23T11:30:00.000Z'),
    };
    const base = {
      usageIds: ['usage-a', 'usage-b'],
      confirmedDefectFacts: [],
      unverifiedDefectFacts: [],
    };

    expect(
      attributeBigBagFactsToUsages({ ...base, windows: overlapping, producedFacts: [fact] }),
    ).toBeNull();
    expect(
      attributeBigBagFactsToUsages({
        ...base,
        windows,
        producedFacts: [{ ...fact, capturedAt: null }],
      }),
    ).toBeNull();
  });
});

function accountingProjectionPrisma() {
  const report = {
    date: new Date('2026-07-21T09:00:00.000Z'),
    outputLines: [
      {
        quantity: { toString: () => '12.5' },
        unitName: 'кг',
        externalId: 'forbidden-output-id',
        rawPayload: { forbidden: true },
        price: 999,
        reportExternalId: 'forbidden-report-id',
        nomenclatureExternalId: 'forbidden-nomenclature-id',
        unitExternalId: 'forbidden-unit-id',
      },
    ],
    materialLines: [
      {
        quantity: { toString: () => '10.25' },
        unitName: 'кг',
        externalId: 'forbidden-material-id',
        cost: 888,
        productExternalId: 'forbidden-product-id',
      },
    ],
    sourceVersion: 'forbidden-source-version',
    organizationExternalId: 'forbidden-organization-id',
    warehouseExternalId: 'forbidden-warehouse-id',
    departmentExternalId: 'forbidden-department-id',
    responsibleUser: 'forbidden-responsible-user',
    Ответственный: 'forbidden-responsible-user',
  };

  return {
    oneCProductionReport: {
      findMany: jest.fn().mockResolvedValue([report]),
      findFirst: jest.fn().mockResolvedValue(report),
    },
    oneCSyncRun: {
      findMany: jest.fn().mockResolvedValue([
        {
          completedAt: new Date('2026-07-24T08:00:00.000Z'),
          counters: {
            production_report: { unchanged: 1 },
            rawPayload: { forbidden: true },
            amount: 777,
          },
        },
      ]),
    },
  };
}

function analyticsLine(lineId: string, planKg: number | null): DirectorRollFactSource['line'] {
  return {
    id: lineId,
    planKg,
    rollDispatchItem: {
      id: `roll-${lineId}`,
      rollCode: `ROLL-${lineId}`,
      productionOrder: {
        commercialOrder: {
          id: `order-${lineId}`,
          orderNumber: `ORDER-${lineId}`,
        },
      },
    },
  };
}

function capture(
  id: string,
  overrides: Partial<DirectorRollFactSource> = {},
): DirectorRollFactSource {
  const operatorRollLineId = overrides.operatorRollLineId ?? 'line-default';
  const netKg = Object.hasOwn(overrides, 'netKg') ? (overrides.netKg ?? null) : 40;

  return {
    id,
    operatorRollLineId,
    postSessionId: null,
    kind: 'roll',
    stable: true,
    grossKg: netKg === null ? null : netKg + 2.4,
    spoolKg: 2.4,
    netKg,
    deviceId: 'scale-1',
    deviceStatus: 'ready',
    actorId: null,
    supersedesCaptureId: null,
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    postSession: null,
    operation: null,
    line: analyticsLine(operatorRollLineId, netKg),
    ...overrides,
  };
}

const captures = [
  capture('capture-outside', {
    operatorRollLineId: 'line-duplicate',
    postSessionId: 'session-old',
    netKg: 10,
    createdAt: new Date('2026-07-20T20:00:00.000Z'),
    line: analyticsLine('line-duplicate', 10),
  }),
  capture('capture-inside-duplicate', {
    operatorRollLineId: 'line-duplicate',
    postSessionId: 'session-1',
    netKg: 99,
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    line: analyticsLine('line-duplicate', 10),
  }),
  capture('capture-a', {
    operatorRollLineId: 'line-1',
    postSessionId: 'session-1',
    netKg: 30,
    createdAt: new Date('2026-07-21T11:00:00.000Z'),
    line: analyticsLine('line-1', 30),
  }),
  capture('capture-z', {
    operatorRollLineId: 'line-1',
    postSessionId: 'session-1',
    netKg: 40,
    createdAt: new Date('2026-07-21T11:00:00.000Z'),
    line: analyticsLine('line-1', 30),
  }),
  capture('capture-line-2', {
    operatorRollLineId: 'line-2',
    postSessionId: 'session-2',
    netKg: 20,
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    line: analyticsLine('line-2', 20),
  }),
  capture('capture-spool', {
    operatorRollLineId: 'line-spool',
    postSessionId: 'session-1',
    kind: 'spool',
    grossKg: 7,
    spoolKg: 7,
    netKg: 7,
    createdAt: new Date('2026-07-22T01:00:00.000Z'),
    line: analyticsLine('line-spool', 7),
  }),
  capture('capture-unstable', {
    operatorRollLineId: 'line-unstable',
    postSessionId: 'session-1',
    stable: false,
    netKg: 8,
    createdAt: new Date('2026-07-22T02:00:00.000Z'),
    line: analyticsLine('line-unstable', 8),
  }),
  capture('capture-null', {
    operatorRollLineId: 'line-null',
    postSessionId: 'session-1',
    netKg: null,
    createdAt: new Date('2026-07-22T03:00:00.000Z'),
    line: analyticsLine('line-null', null),
  }),
];

const usage1 = {
  id: 'usage-1',
  sessionId: 'session-1',
  bigBagId: 'bag-1',
  startKg: 100,
  endKg: 70,
  createdAt: new Date('2026-07-21T07:00:00.000Z'),
  closedAt: new Date('2026-07-21T20:59:59.000Z'),
  session: {
    operator: { id: 'operator-1', displayName: 'Operator One' },
    post: { id: 'post-1', code: 'POST-1', name: 'Machine One' },
    shift: { id: 'shift-1', label: 'Day shift' },
  },
};

const usage2 = {
  id: 'usage-2',
  sessionId: 'session-2',
  bigBagId: 'bag-2',
  startKg: 50,
  endKg: 60,
  createdAt: new Date('2026-07-21T18:00:00.000Z'),
  closedAt: new Date('2026-07-21T21:00:00.000Z'),
  session: {
    operator: { id: 'operator-2', displayName: 'Operator Two' },
    post: { id: 'post-2', code: 'POST-2', name: 'Machine Two' },
    shift: { id: 'shift-2', label: 'Night shift' },
  },
};

const openUsage = {
  id: 'usage-open',
  sessionId: 'session-3',
  bigBagId: 'bag-3',
  startKg: 40,
  endKg: null,
  createdAt: new Date('2026-07-22T05:00:00.000Z'),
  closedAt: null,
  session: {
    operator: { id: 'operator-3', displayName: 'Operator Three' },
    post: { id: 'post-3', code: 'POST-3', name: 'Machine Three' },
    shift: { label: null },
  },
};

const sessions = [
  {
    id: 'session-1',
    status: 'closed',
    startedAt: new Date('2026-07-21T06:00:00.000Z'),
    endedAt: new Date('2026-07-21T20:59:59.000Z'),
    operator: { id: 'operator-1', displayName: 'Operator One' },
    post: { id: 'post-1', code: 'POST-1', name: 'Machine One' },
    shift: { id: 'shift-1', label: 'Day shift' },
    bagUsages: [usage1],
  },
  {
    id: 'session-2',
    status: 'closed',
    startedAt: new Date('2026-07-21T17:00:00.000Z'),
    endedAt: new Date('2026-07-21T21:10:00.000Z'),
    operator: { id: 'operator-2', displayName: 'Operator Two' },
    post: { id: 'post-2', code: 'POST-2', name: 'Machine Two' },
    shift: { id: 'shift-2', label: 'Night shift' },
    bagUsages: [usage2],
  },
  {
    id: 'session-3',
    status: 'closed',
    startedAt: new Date('2026-07-22T04:00:00.000Z'),
    endedAt: new Date('2026-07-22T20:00:00.000Z'),
    operator: { id: 'operator-3', displayName: 'Operator Three' },
    post: { id: 'post-3', code: 'POST-3', name: 'Machine Three' },
    shift: null,
    bagUsages: [openUsage],
  },
];

const bags = [
  {
    id: 'bag-1',
    code: 'BB-001',
    material: 'PE-1',
    materialId: 'material-1',
    status: 'available',
    initialKg: 100,
    currentKg: null,
    lastMeasuredKg: 70,
    lastMeasuredAt: new Date('2026-07-21T20:59:59.000Z'),
    priceKopecksPerKg: 2_500,
    priceEffectiveAt: new Date('2026-07-01T00:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    rawPayload: { shouldNeverEscape: true },
    tokenHash: 'forbidden',
  },
  {
    id: 'bag-2',
    code: 'BB-002',
    material: 'PE-2',
    materialId: 'material-2',
    status: 'consumed',
    initialKg: 50,
    currentKg: 60,
    lastMeasuredKg: 60,
    lastMeasuredAt: new Date('2026-07-21T21:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  },
  {
    id: 'bag-3',
    code: 'BB-003',
    material: 'PE-3',
    materialId: 'material-3',
    status: 'in_use',
    initialKg: 40,
    currentKg: 40,
    lastMeasuredKg: 40,
    lastMeasuredAt: new Date('2026-07-22T05:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  },
  {
    id: 'bag-consumed-after-range',
    code: 'BB-CONSUMED-AFTER',
    material: 'PE-later',
    materialId: 'material-later',
    status: 'consumed',
    initialKg: 80,
    currentKg: 0,
    lastMeasuredKg: 0,
    lastMeasuredAt: new Date('2026-07-25T12:00:00.000Z'),
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  },
  {
    id: 'bag-untouched',
    code: 'BB-OLD',
    material: 'PE-old',
    materialId: null,
    status: 'consumed',
    initialKg: 20,
    currentKg: 0,
    lastMeasuredKg: 0,
    lastMeasuredAt: new Date('2026-06-01T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
  },
  {
    id: 'bag-future',
    code: 'BB-FUTURE',
    material: 'PE-future',
    materialId: null,
    status: 'available',
    initialKg: 20,
    currentKg: 20,
    lastMeasuredKg: 20,
    lastMeasuredAt: new Date('2026-07-25T00:00:00.000Z'),
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
  },
];

function setup() {
  const prisma = {
    ...accountingProjectionPrisma(),
    weightCapture: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([
          { operatorRollLineId: 'line-duplicate' },
          { operatorRollLineId: 'line-1' },
          { operatorRollLineId: 'line-2' },
        ])
        .mockResolvedValueOnce(captures),
    },
    operatorPostSession: { findMany: jest.fn().mockResolvedValue(sessions) },
    shiftBagUsage: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { ...usage1, requestHeaders: { authorization: 'forbidden' } },
          usage2,
          openUsage,
        ]),
    },
    bigBagUnit: { findMany: jest.fn().mockResolvedValue(bags.slice(0, 4)) },
    defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
    domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
    commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, service: analyticsService(prisma) };
}

const aggregateCaptures = [
  capture('spool-over', {
    operatorRollLineId: 'line-over',
    kind: 'spool',
    grossKg: 2.4,
    spoolKg: 2.4,
    netKg: null,
    createdAt: new Date('2026-07-21T08:55:00.000Z'),
    line: analyticsLine('line-over', 40),
  }),
  capture('roll-over', {
    operatorRollLineId: 'line-over',
    postSessionId: 'session-over',
    netKg: 45,
    createdAt: new Date('2026-07-21T09:00:00.000Z'),
    postSession: {
      operator: { id: 'operator-over', displayName: 'Operator Over' },
    },
    line: analyticsLine('line-over', 40),
  }),
  capture('spool-under', {
    operatorRollLineId: 'line-under',
    kind: 'spool',
    grossKg: 2.4,
    spoolKg: 2.4,
    netKg: null,
    createdAt: new Date('2026-07-21T09:55:00.000Z'),
    line: analyticsLine('line-under', 50),
  }),
  capture('roll-under', {
    operatorRollLineId: 'line-under',
    netKg: 40,
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-under', displayName: 'Operator Under' },
    },
    line: analyticsLine('line-under', 50),
  }),
  capture('roll-missing-actor', {
    operatorRollLineId: 'line-missing-actor',
    netKg: 40,
    createdAt: new Date('2026-07-21T11:00:00.000Z'),
    line: analyticsLine('line-missing-actor', 40),
  }),
  capture('roll-missing-plan', {
    operatorRollLineId: 'line-missing-plan',
    postSessionId: 'session-plan-missing',
    netKg: 20,
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    postSession: {
      operator: { id: 'operator-plan-missing', displayName: 'Operator Plan Missing' },
    },
    line: analyticsLine('line-missing-plan', null),
  }),
  capture('roll-month-only', {
    operatorRollLineId: 'line-month-only',
    postSessionId: 'session-month-only',
    netKg: 43,
    createdAt: new Date('2026-07-10T09:00:00.000Z'),
    postSession: {
      operator: { id: 'operator-month-only', displayName: 'Operator Month Only' },
    },
    line: analyticsLine('line-month-only', 40),
  }),
];

const aggregateUsages = [
  {
    id: 'usage-positive',
    sessionId: 'session-usage-positive',
    bigBagId: 'bag-positive',
    startKg: 200,
    endKg: 63,
    createdAt: new Date('2026-07-21T07:00:00.000Z'),
    closedAt: new Date('2026-07-21T15:00:00.000Z'),
    session: {
      operator: { id: 'operator-usage', displayName: 'Operator Usage' },
      post: { id: 'post-usage', code: 'POST-USAGE', name: 'Machine Usage' },
      shift: null,
    },
  },
  {
    id: 'usage-negative',
    sessionId: 'session-usage-negative',
    bigBagId: 'bag-negative',
    startKg: 50,
    endKg: 60,
    createdAt: new Date('2026-07-21T08:00:00.000Z'),
    closedAt: new Date('2026-07-21T16:00:00.000Z'),
    session: {
      operator: { id: 'operator-correction', displayName: 'Operator Correction' },
      post: { id: 'post-correction', code: 'POST-CORRECTION', name: 'Machine Correction' },
      shift: null,
    },
  },
  {
    id: 'usage-open-v2',
    sessionId: 'session-usage-open',
    bigBagId: 'bag-open',
    startKg: 80,
    endKg: null,
    createdAt: new Date('2026-07-21T09:00:00.000Z'),
    closedAt: null,
    session: {
      operator: { id: 'operator-open', displayName: 'Operator Open' },
      post: { id: 'post-open', code: 'POST-OPEN', name: 'Machine Open' },
      shift: null,
    },
  },
];

const aggregateDefects = [
  {
    id: 'defect-verified',
    operatorRollLineId: 'line-over',
    weightKg: 999_999,
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
    weightCapture: {
      id: 'roll-over',
      operatorRollLineId: 'line-over',
      kind: 'roll',
      stable: true,
      netKg: 45,
    },
    spoolStockMovement: { quantity: 1 },
  },
  {
    id: 'defect-unverified-repeat',
    operatorRollLineId: 'line-over',
    weightKg: 888_888,
    createdAt: new Date('2026-07-21T13:00:00.000Z'),
    weightCapture: null,
  },
];

function setupAggregates() {
  const prisma = {
    ...accountingProjectionPrisma(),
    weightCapture: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(
          aggregateCaptures
            .filter(({ kind }) => kind === 'roll')
            .map(({ operatorRollLineId }) => ({ operatorRollLineId })),
        )
        .mockResolvedValueOnce(aggregateCaptures),
    },
    operatorPostSession: { findMany: jest.fn().mockResolvedValue([]) },
    shiftBagUsage: { findMany: jest.fn().mockResolvedValue(aggregateUsages) },
    bigBagUnit: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: { findMany: jest.fn().mockResolvedValue(aggregateDefects) },
    domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
    commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
  };

  return { prisma, service: analyticsService(prisma) };
}

const directApplications = [
  ['direct-six-month', '2026-01-22T21:00:00.000Z'],
  ['direct-three-month', '2026-04-22T21:00:00.000Z'],
  ['direct-month', '2026-06-23T21:00:00.000Z'],
  ['direct-week-start', '2026-07-16T21:00:00.000Z'],
  ['direct-as-of-end', '2026-07-23T20:59:59.999Z'],
].map(([id, createdAt]) => ({
  id,
  requestType: 'client_order',
  createdAt: new Date(createdAt),
}));

const promotedApplications = [
  'promoted-six-month',
  'promoted-three-month',
  'promoted-month',
  'promoted-week-start',
  'promoted-week-later',
].map((id) => ({ id, requestType: 'stock_reserve' }));

const promotionEvents = [
  ['promotion-six-month', 'promoted-six-month', '2026-03-01T09:00:00.000Z'],
  ['promotion-three-month', 'promoted-three-month', '2026-05-15T09:00:00.000Z'],
  ['promotion-month', 'promoted-month', '2026-07-01T09:00:00.000Z'],
  ['promotion-week-start', 'promoted-week-start', '2026-07-18T09:00:00.000Z'],
  ['promotion-week-later', 'promoted-week-later', '2026-07-20T09:00:00.000Z'],
  ['promotion-week-start-duplicate', 'promoted-week-start', '2026-07-22T09:00:00.000Z'],
].map(([id, objectId, createdAt]) => ({ id, objectId, createdAt: new Date(createdAt) }));

function setupApplications() {
  const prisma = {
    ...accountingProjectionPrisma(),
    weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    operatorPostSession: { findMany: jest.fn().mockResolvedValue([]) },
    shiftBagUsage: { findMany: jest.fn().mockResolvedValue([]) },
    bigBagUnit: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
    domainEvent: { findMany: jest.fn().mockResolvedValue(promotionEvents) },
    commercialOrder: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(directApplications)
        .mockResolvedValueOnce(promotedApplications),
    },
  };

  return { prisma, service: analyticsService(prisma) };
}

const drilldownCaptures = [
  capture('roll-newest', {
    operatorRollLineId: 'line-newest',
    netKg: 50,
    createdAt: new Date('2026-07-23T09:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-newest', displayName: 'Operator Newest' },
    },
    line: analyticsLine('line-newest', 50),
  }),
  capture('roll-newest-future-reweigh', {
    operatorRollLineId: 'line-newest',
    netKg: 999,
    supersedesCaptureId: 'roll-newest',
    createdAt: new Date('2026-07-23T21:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-future', displayName: 'Future Operator' },
    },
    line: analyticsLine('line-newest', 50),
  }),
  capture('roll-a-root', {
    operatorRollLineId: 'line-a',
    postSessionId: 'session-original',
    netKg: 40,
    createdAt: new Date('2026-07-22T10:00:00.000Z'),
    postSession: {
      operator: { id: 'operator-original', displayName: 'Original Operator' },
    },
    line: analyticsLine('line-a', 40),
  }),
  capture('roll-a-reweigh', {
    operatorRollLineId: 'line-a',
    netKg: 45,
    supersedesCaptureId: 'roll-a-root',
    createdAt: new Date('2026-07-23T12:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-reweigh', displayName: 'Reweigh Operator' },
    },
    line: analyticsLine('line-a', 40),
  }),
  capture('roll-b', {
    operatorRollLineId: 'line-b',
    netKg: 32,
    createdAt: new Date('2026-07-22T10:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-b', displayName: 'Operator B' },
    },
    line: analyticsLine('line-b', 30),
  }),
  capture('roll-under', {
    operatorRollLineId: 'line-under-page',
    netKg: 40,
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-under-page', displayName: 'Operator Under Page' },
    },
    line: analyticsLine('line-under-page', 50),
  }),
  capture('roll-missing-plan-page', {
    operatorRollLineId: 'line-missing-plan-page',
    netKg: 20,
    createdAt: new Date('2026-07-21T11:00:00.000Z'),
    operation: {
      status: 'succeeded',
      actor: { id: 'operator-plan-page', displayName: 'Operator Plan Page' },
    },
    line: analyticsLine('line-missing-plan-page', null),
  }),
  capture('roll-missing-actor-page', {
    operatorRollLineId: 'line-missing-actor-page',
    netKg: 42,
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    line: analyticsLine('line-missing-actor-page', 40),
  }),
];

function setupDrilldown() {
  const candidateLineIds = [
    'line-newest',
    'line-a',
    'line-b',
    'line-under-page',
    'line-missing-plan-page',
    'line-missing-actor-page',
  ];
  const prisma = {
    weightCapture: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(
          candidateLineIds.map((operatorRollLineId) => ({ operatorRollLineId })),
        )
        .mockResolvedValueOnce(drilldownCaptures),
    },
  };

  return { prisma, service: analyticsService(prisma) };
}

function testCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

describe('DirectorAnalyticsService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T09:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('zero-fills production and keeps only the globally earliest stable roll capture', async () => {
    const { service } = setup();

    const result = await service.getAnalytics(query);

    expect(result.productionSeries).toEqual([
      { bucketStartDate: '2026-07-21', rollCount: 1, producedKg: 30 },
      { bucketStartDate: '2026-07-22', rollCount: 1, producedKg: 20 },
      { bucketStartDate: '2026-07-23', rollCount: 0, producedKg: 0 },
    ]);
    expect(result.range).toEqual({
      timezone: 'Europe/Moscow',
      requested: { from: '2026-07-21', to: '2026-07-23' },
      effective: {
        fromUtc: '2026-07-20T21:00:00.000Z',
        toExclusiveUtc: '2026-07-23T21:00:00.000Z',
      },
      bucket: 'day',
      generatedAt: '2026-07-24T09:00:00.000Z',
    });
  });

  it('adds accounting production without altering physical shift and BigBag rows', async () => {
    const { service } = setup();

    const result = await service.getAnalytics(query);

    expect(result.accountingProduction).toEqual({
      source: {
        sourceKind: '1C',
        label: '1С · Отчет производства за смену',
        latestImportedAt: '2026-07-24T08:00:00.000Z',
        latestDocumentDate: '2026-07-21T09:00:00.000Z',
        stale: false,
      },
      coverage: {
        documentCount: 1,
        excludedOutputLineCount: 0,
        excludedMaterialLineCount: 0,
      },
      productionSeries: [
        { bucketStartDate: '2026-07-21', documentCount: 1, producedKg: 12.5 },
        { bucketStartDate: '2026-07-22', documentCount: 0, producedKg: 0 },
        { bucketStartDate: '2026-07-23', documentCount: 0, producedKg: 0 },
      ],
      materialSeries: [
        { bucketStartDate: '2026-07-21', consumedKg: 10.25 },
        { bucketStartDate: '2026-07-22', consumedKg: 0 },
        { bucketStartDate: '2026-07-23', consumedKg: 0 },
      ],
    });
    expect(
      result.shiftBalances.map(({ sessionId, producedKg, actualUsageKg }) => ({
        sessionId,
        producedKg,
        actualUsageKg,
      })),
    ).toEqual([
      { sessionId: 'session-1', producedKg: 30, actualUsageKg: 30 },
      { sessionId: 'session-2', producedKg: 20, actualUsageKg: -10 },
      { sessionId: 'session-3', producedKg: 0, actualUsageKg: null },
    ]);
    expect(
      result.bigBags.map(({ id, currentSnapshot, usageHistory }) => ({
        id,
        currentSnapshot,
        usageIds: usageHistory.map((usage) => usage.id),
      })),
    ).toEqual([
      {
        id: 'bag-1',
        currentSnapshot: {
          measuredKg: 70,
          measuredAt: '2026-07-21T20:59:59.000Z',
        },
        usageIds: ['usage-1'],
      },
      {
        id: 'bag-2',
        currentSnapshot: {
          measuredKg: 60,
          measuredAt: '2026-07-21T21:00:00.000Z',
        },
        usageIds: ['usage-2'],
      },
      {
        id: 'bag-3',
        currentSnapshot: {
          measuredKg: 40,
          measuredAt: '2026-07-22T05:00:00.000Z',
        },
        usageIds: ['usage-open'],
      },
      {
        id: 'bag-consumed-after-range',
        currentSnapshot: {
          measuredKg: 0,
          measuredAt: '2026-07-25T12:00:00.000Z',
        },
        usageIds: [],
      },
    ]);
  });

  it('does not expose source identifiers, cost, responsible user, or raw payload', async () => {
    const { service } = setup();

    const result = await service.getAnalytics(query);
    const json = JSON.stringify(result.accountingProduction);

    expect(json).not.toMatch(
      /rawPayload|externalId|sourceVersion|reportExternalId|organizationExternalId|warehouseExternalId|departmentExternalId|nomenclatureExternalId|unitExternalId|productExternalId|price|cost|amount|responsibleUser|Ответственный/i,
    );
  });

  it('sums positive over-plan without allowing underweight to cancel it', async () => {
    const { service } = setupAggregates();

    const result = await service.getAnalytics(query);

    expect(result.operatorOverPlan.series).toEqual([
      {
        bucketStartDate: '2026-07-21',
        affectedRollCount: 1,
        affectedOperatorCount: 1,
        overPlanKg: 5,
      },
      {
        bucketStartDate: '2026-07-22',
        affectedRollCount: 0,
        affectedOperatorCount: 0,
        overPlanKg: 0,
      },
      {
        bucketStartDate: '2026-07-23',
        affectedRollCount: 0,
        affectedOperatorCount: 0,
        overPlanKg: 0,
      },
    ]);
    expect(result.operatorOverPlan.totals).toEqual([
      {
        period: 'week',
        fromDate: '2026-07-17',
        toDate: '2026-07-23',
        affectedRollCount: 1,
        affectedOperatorCount: 1,
        overPlanKg: 5,
      },
      {
        period: 'month',
        fromDate: '2026-06-24',
        toDate: '2026-07-23',
        affectedRollCount: 2,
        affectedOperatorCount: 2,
        overPlanKg: 8,
      },
    ]);
    expect(result.operatorOverPlan.topOperators).toEqual([
      {
        operatorId: 'operator-over',
        operatorName: 'Operator Over',
        affectedRollCount: 1,
        overPlanKg: 5,
      },
    ]);
    expect(result.operatorOverPlan.missingPlanCount).toBe(1);
    expect(result.operatorOverPlan.missingActorCount).toBe(1);
  });

  it('counts defect records separately from distinct rolls and ignores legacy defect weight', async () => {
    const { service } = setupAggregates();

    const result = await service.getAnalytics(query);

    expect(result.productionQualitySeries[0]).toEqual({
      id: 'day:2026-07-21',
      bucketStartDate: '2026-07-21',
      producedRollCount: 3,
      producedKg: 125,
      defectRecordCount: 2,
      defectiveRollCount: 1,
      verifiedDefectKg: 45,
      unverifiedDefectCount: 1,
      returnedSpoolCount: 1,
    });
  });

  it('uses only closed BigBag deltas and measured spool evidence for material spend', async () => {
    const { service } = setupAggregates();

    const result = await service.getAnalytics(query);

    expect(result.materialSpendSeries[0]).toEqual({
      bucketStartDate: '2026-07-21',
      consumedGranulesKg: 127,
      recordedSpoolCount: 2,
      recordedSpoolTareKg: 4.8,
      missingSpoolEvidenceCount: 1,
    });
    expect(result.spoolEvidence).toEqual({
      availability: 'measured_evidence_only',
      explanation: expect.any(String),
    });
  });

  it('counts direct and promoted applications by exact submitted timestamps', async () => {
    const { prisma, service } = setupApplications();

    const result = await service.getAnalytics(query);

    expect(result.commercialApplications).toEqual({
      definition: 'submitted',
      asOfDate: '2026-07-23',
      periods: [
        {
          period: 'week',
          fromDate: '2026-07-17',
          toDate: '2026-07-23',
          totalCount: 4,
          clientOrderCount: 2,
          stockReserveCount: 2,
        },
        {
          period: 'month',
          fromDate: '2026-06-24',
          toDate: '2026-07-23',
          totalCount: 6,
          clientOrderCount: 3,
          stockReserveCount: 3,
        },
        {
          period: '3_months',
          fromDate: '2026-04-23',
          toDate: '2026-07-23',
          totalCount: 8,
          clientOrderCount: 4,
          stockReserveCount: 4,
        },
        {
          period: '6_months',
          fromDate: '2026-01-23',
          toDate: '2026-07-23',
          totalCount: 10,
          clientOrderCount: 5,
          stockReserveCount: 5,
        },
      ],
    });
    expect(prisma.commercialOrder.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        draftedAt: null,
        commercialStage: { not: 'draft' },
        createdAt: {
          gte: new Date('2026-01-22T21:00:00.000Z'),
          lt: new Date('2026-07-23T21:00:00.000Z'),
        },
      },
      select: { id: true, requestType: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith({
      where: {
        type: 'audit:commercial_draft_promoted',
        objectId: { not: null },
        createdAt: {
          gte: new Date('2026-01-22T21:00:00.000Z'),
          lt: new Date('2026-07-23T21:00:00.000Z'),
        },
      },
      select: { id: true, objectId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.commercialOrder.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: {
          in: [
            'promoted-six-month',
            'promoted-three-month',
            'promoted-month',
            'promoted-week-start',
            'promoted-week-later',
          ],
        },
      },
      select: { id: true, requestType: true },
      orderBy: [{ id: 'asc' }],
    });
  });

  it('keeps a reweighed roll in the root production bucket', async () => {
    const reweighCaptures = [
      capture('base', {
        operatorRollLineId: 'line-reweigh',
        postSessionId: 'session-old',
        netKg: 10,
        createdAt: new Date('2026-07-20T20:00:00.000Z'),
        line: analyticsLine('line-reweigh', 10),
      }),
      capture('legacy-duplicate', {
        operatorRollLineId: 'line-reweigh',
        postSessionId: 'session-1',
        netKg: 20,
        createdAt: new Date('2026-07-21T09:00:00.000Z'),
        line: analyticsLine('line-reweigh', 10),
      }),
      capture('reweigh', {
        operatorRollLineId: 'line-reweigh',
        postSessionId: 'session-1',
        netKg: 12,
        supersedesCaptureId: 'base',
        createdAt: new Date('2026-07-21T10:00:00.000Z'),
        line: analyticsLine('line-reweigh', 10),
      }),
    ];
    const prisma = {
      ...accountingProjectionPrisma(),
      operatorPostSession: { findMany: jest.fn().mockResolvedValue([]) },
      shiftBagUsage: { findMany: jest.fn().mockResolvedValue([]) },
      bigBagUnit: { findMany: jest.fn().mockResolvedValue([]) },
      defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
      weightCapture: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ operatorRollLineId: 'line-reweigh' }])
          .mockResolvedValueOnce(reweighCaptures),
      },
    };
    const service = analyticsService(prisma);

    const result = await service.getAnalytics({ ...query, from: '2026-07-20' });

    expect(result.productionSeries[0]).toEqual({
      bucketStartDate: '2026-07-20',
      rollCount: 1,
      producedKg: 12,
    });
    expect(result.productionSeries[1]).toEqual({
      bucketStartDate: '2026-07-21',
      rollCount: 0,
      producedKg: 0,
    });
  });

  it('reports one-to-one expected use and only closed-at actual use including negatives', async () => {
    const { service } = setup();

    const result = await service.getAnalytics(query);

    expect(result.materialSeries).toEqual([
      { bucketStartDate: '2026-07-21', expectedUsageKg: 30, actualUsageKg: 30 },
      { bucketStartDate: '2026-07-22', expectedUsageKg: 20, actualUsageKg: -10 },
      { bucketStartDate: '2026-07-23', expectedUsageKg: 0, actualUsageKg: 0 },
    ]);
  });

  it('rounds bucket totals only after summing all canonical facts', async () => {
    const tinyCaptures = ['a', 'b', 'c'].map((suffix) =>
      capture(`capture-${suffix}`, {
        operatorRollLineId: `line-${suffix}`,
        netKg: 0.0004,
        createdAt: new Date('2026-07-21T10:00:00.000Z'),
        line: analyticsLine(`line-${suffix}`, 0.0004),
      }),
    );
    const safeSession = {
      operator: { id: 'operator', displayName: 'Operator' },
      post: { id: 'post', code: 'POST', name: 'Machine' },
      shift: null,
    };
    const tinyUsages = ['a', 'b', 'c'].map((suffix) => ({
      id: `usage-${suffix}`,
      sessionId: 'session-open',
      bigBagId: `bag-${suffix}`,
      startKg: 0.0004,
      endKg: 0,
      createdAt: new Date('2026-07-21T09:00:00.000Z'),
      closedAt: new Date('2026-07-21T10:00:00.000Z'),
      session: safeSession,
    }));
    const prisma = {
      ...accountingProjectionPrisma(),
      operatorPostSession: { findMany: jest.fn().mockResolvedValue([]) },
      shiftBagUsage: { findMany: jest.fn().mockResolvedValue(tinyUsages) },
      bigBagUnit: { findMany: jest.fn().mockResolvedValue([]) },
      defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
      weightCapture: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(
            tinyCaptures.map(({ operatorRollLineId }) => ({ operatorRollLineId })),
          )
          .mockResolvedValueOnce(tinyCaptures),
      },
    };
    const service = analyticsService(prisma);

    const result = await service.getAnalytics({ ...query, to: query.from });

    expect(result.productionSeries[0].producedKg).toBe(0.001);
    expect(result.materialSeries[0]).toEqual({
      bucketStartDate: '2026-07-21',
      expectedUsageKg: 0.001,
      actualUsageKg: 0.001,
    });
  });

  it('uses exact session facts and marks an incomplete closed session pending', async () => {
    const { service } = setup();

    const result = await service.getAnalytics(query);

    expect(result.shiftBalances).toEqual([
      {
        sessionId: 'session-1',
        shiftId: 'shift-1',
        operatorId: 'operator-1',
        operatorName: 'Operator One',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'Machine One',
        shiftLabel: 'Day shift',
        startedAt: '2026-07-21T06:00:00.000Z',
        endedAt: '2026-07-21T20:59:59.000Z',
        rollCount: 1,
        producedKg: 30,
        expectedUsageKg: 30,
        actualUsageKg: 30,
        deviationPercent: 0,
        status: 'ok',
        payroll: {
          status: 'unresolved',
          reasons: ['machine_family_unresolved'],
        },
      },
      {
        sessionId: 'session-2',
        shiftId: 'shift-2',
        operatorId: 'operator-2',
        operatorName: 'Operator Two',
        postId: 'post-2',
        postCode: 'POST-2',
        postName: 'Machine Two',
        shiftLabel: 'Night shift',
        startedAt: '2026-07-21T17:00:00.000Z',
        endedAt: '2026-07-21T21:10:00.000Z',
        rollCount: 1,
        producedKg: 20,
        expectedUsageKg: 20,
        actualUsageKg: -10,
        deviationPercent: -150,
        status: 'mismatch',
        payroll: {
          status: 'unresolved',
          reasons: ['machine_family_unresolved'],
        },
      },
      {
        sessionId: 'session-3',
        shiftId: null,
        operatorId: 'operator-3',
        operatorName: 'Operator Three',
        postId: 'post-3',
        postCode: 'POST-3',
        postName: 'Machine Three',
        shiftLabel: null,
        startedAt: '2026-07-22T04:00:00.000Z',
        endedAt: '2026-07-22T20:00:00.000Z',
        rollCount: 0,
        producedKg: 0,
        expectedUsageKg: 0,
        actualUsageKg: null,
        deviationPercent: null,
        status: 'pending',
        payroll: {
          status: 'unresolved',
          reasons: ['machine_family_unresolved'],
        },
      },
    ]);
  });

  it('treats a closed session without BigBag usages as exact zero actual usage', async () => {
    const emptySession = {
      id: 'session-empty',
      status: 'closed',
      startedAt: new Date('2026-07-21T06:00:00.000Z'),
      endedAt: new Date('2026-07-21T07:00:00.000Z'),
      operator: { id: 'operator-empty', displayName: 'Operator Empty' },
      post: { id: 'post-empty', code: 'POST-EMPTY', name: 'Machine Empty' },
      shift: { id: 'shift-empty', label: 'Empty shift' },
      bagUsages: [],
    };
    const prisma = {
      ...accountingProjectionPrisma(),
      operatorPostSession: { findMany: jest.fn().mockResolvedValue([emptySession]) },
      shiftBagUsage: { findMany: jest.fn().mockResolvedValue([]) },
      bigBagUnit: { findMany: jest.fn().mockResolvedValue([]) },
      defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      commercialOrder: { findMany: jest.fn().mockResolvedValue([]) },
      weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = analyticsService(prisma);

    const result = await service.getAnalytics({ ...query, to: query.from });

    expect(result.shiftBalances).toEqual([
      expect.objectContaining({
        sessionId: 'session-empty',
        producedKg: 0,
        expectedUsageKg: 0,
        actualUsageKg: 0,
        deviationPercent: 0,
        status: 'ok',
      }),
    ]);
  });

  it('prices every Control balance from one schedule by endedAt, including zero usage', async () => {
    jest.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
    const legacy = publishedOrder(
      LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
      LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.effectiveFrom,
      400,
    );
    const next = publishedOrder('payroll-order-next', '2026-08-10', 777);
    const tariffOrders = {
      loadPublishedSchedule: jest.fn().mockResolvedValue([legacy, next]),
    };
    const context = setup();
    Object.assign(context.service, {
      tariffOrders,
      tariffResolver: new PayrollTariffResolver(),
    });

    const makeUsage = (id: string, startKg: number, endKg: number) => ({
      id: `usage-${id}`,
      sessionId: `session-${id}`,
      bigBagId: `bag-${id}`,
      startKg,
      endKg,
      releasedReason: null,
      createdAt: new Date('2026-08-09T15:00:00.000Z'),
      closedAt: new Date('2026-08-09T22:00:00.000Z'),
      episodes: [],
      bigBag: { material: 'ПВД Айка' },
    });
    const beforeUsage = makeUsage('before', 30, 0);
    const boundaryUsage = makeUsage('boundary', 20, 0);
    const zeroUsage = makeUsage('zero', 10, 10);
    const makeSession = (
      id: string,
      startedAt: string,
      endedAt: string,
      bagUsage: ReturnType<typeof makeUsage>,
    ) => ({
      id: `session-${id}`,
      status: 'closed',
      startedAt: new Date(startedAt),
      endedAt: new Date(endedAt),
      operator: { id: `operator-${id}`, displayName: `Operator ${id}` },
      post: { id: 'post-urp', code: 'URP', name: 'УРП' },
      shift: { id: `shift-${id}`, label: `Shift ${id}` },
      bagUsages: [bagUsage],
    });
    const controlSessions = [
      makeSession('before', '2026-08-09T15:00:00.000Z', '2026-08-09T20:59:59.999Z', beforeUsage),
      makeSession(
        'boundary',
        '2026-08-09T15:00:00.000Z',
        '2026-08-09T21:00:00.000Z',
        boundaryUsage,
      ),
      makeSession('zero', '2026-08-09T16:00:00.000Z', '2026-08-09T22:00:00.000Z', zeroUsage),
    ];
    context.prisma.operatorPostSession.findMany.mockResolvedValue(controlSessions);
    context.prisma.shiftBagUsage.findMany.mockResolvedValue(
      controlSessions.map((session) => ({
        ...session.bagUsages[0],
        session: {
          operator: session.operator,
          post: session.post,
          shift: session.shift,
        },
      })),
    );
    const outputCaptures = [
      capture('payroll-before', {
        operatorRollLineId: 'payroll-before',
        postSessionId: 'session-before',
        netKg: 30,
        createdAt: new Date('2026-08-09T18:00:00.000Z'),
      }),
      capture('payroll-boundary', {
        operatorRollLineId: 'payroll-boundary',
        postSessionId: 'session-boundary',
        netKg: 20,
        createdAt: new Date('2026-08-09T20:00:00.000Z'),
      }),
    ];
    context.prisma.weightCapture.findMany
      .mockReset()
      .mockResolvedValueOnce(
        outputCaptures.map(({ operatorRollLineId }) => ({ operatorRollLineId })),
      )
      .mockResolvedValueOnce(outputCaptures);

    const result = await context.service.getAnalytics({
      from: '2026-08-09',
      to: '2026-08-10',
      bucket: 'day',
    });

    expect(tariffOrders.loadPublishedSchedule).toHaveBeenCalledTimes(1);
    expect(tariffOrders.loadPublishedSchedule).toHaveBeenCalledWith(
      new Date('2026-08-09T22:00:00.000Z'),
    );
    expect(result.shiftBalances.map(({ sessionId, payroll }) => ({ sessionId, payroll }))).toEqual([
      {
        sessionId: 'session-before',
        payroll: expect.objectContaining({
          status: 'resolved',
          tariffOrder: legacy.reference,
          rateKopecksPerKg: 400,
          amountKopecks: 12_000,
        }),
      },
      {
        sessionId: 'session-boundary',
        payroll: expect.objectContaining({
          status: 'resolved',
          tariffOrder: next.reference,
          rateKopecksPerKg: 777,
          amountKopecks: 15_540,
        }),
      },
      {
        sessionId: 'session-zero',
        payroll: expect.objectContaining({
          status: 'resolved',
          tariffOrder: next.reference,
          rateKopecksPerKg: 777,
          amountKopecks: 0,
        }),
      },
    ]);
  });

  it('prices mixed output with late reweigh and defects while preserving historical production', async () => {
    jest.setSystemTime(new Date('2026-08-01T09:00:00.000Z'));
    const { prisma, service } = setup();
    const mixedSession = {
      ...sessions[0],
      post: { id: 'post-urp', code: 'URP', name: 'УРП' },
      endedAt: new Date('2026-07-21T18:00:00.000Z'),
    };
    prisma.operatorPostSession.findMany.mockResolvedValue([mixedSession]);
    const mixedCaptures = ['ГОСТ', 'Тех', 'ГОСТ'].map((birka, index) => {
      const lineId = `mixed-${index}`;
      const line = analyticsLine(lineId, 400);
      line.rollDispatchItem.characteristicsSnapshot = { birka };
      if (index === 2) line.defects = [{ createdAt: new Date('2026-07-30T11:00:00.000Z') }];
      return capture(lineId, {
        operatorRollLineId: lineId,
        postSessionId: mixedSession.id,
        netKg: 400,
        line,
      });
    });
    mixedCaptures.push(
      capture('late-reweigh', {
        ...mixedCaptures[0]!,
        id: 'late-reweigh',
        postSessionId: 'different-reweigh-session',
        netKg: 500,
        supersedesCaptureId: mixedCaptures[0]!.id,
        createdAt: new Date('2026-07-31T10:00:00.000Z'),
      }),
    );
    prisma.weightCapture.findMany
      .mockReset()
      .mockResolvedValueOnce(
        mixedCaptures.map(({ operatorRollLineId }) => ({ operatorRollLineId })),
      )
      .mockResolvedValueOnce(mixedCaptures);
    const result = await service.getAnalytics(query);
    expect(result.shiftBalances[0]!.payroll).toMatchObject({
      status: 'resolved',
      amountKopecks: 445_000,
      rateKopecksPerKg: null,
      tariffRule: null,
    });
    expect(result.shiftBalances[0]!.payroll).toHaveProperty(
      'basisLabel',
      'Первичка: 500.000 кг × 4.5 ₽/кг; Вторичка: 400.000 кг × 5.5 ₽/кг',
    );
    expect(result.shiftBalances[0]!.producedKg).toBe(1_200);
  });

  it('separates safe current BigBag snapshots from immutable range-touched history', async () => {
    const { service } = setup();

    const result = await service.getAnalytics(query);

    expect(result.bigBags.map(({ id }) => id)).toEqual([
      'bag-1',
      'bag-2',
      'bag-3',
      'bag-consumed-after-range',
    ]);
    expect(result.bigBags[0]).toEqual({
      id: 'bag-1',
      code: 'BB-001',
      material: 'PE-1',
      materialId: 'material-1',
      status: 'available',
      initialKg: 100,
      priceKopecksPerKg: 2_500,
      totalKopecks: 175_000,
      priceEffectiveAt: '2026-07-01T00:00:00.000Z',
      currentSnapshot: {
        measuredKg: 70,
        measuredAt: '2026-07-21T20:59:59.000Z',
      },
      usageHistory: [
        {
          id: 'usage-1',
          sessionId: 'session-1',
          shiftId: 'shift-1',
          operatorId: 'operator-1',
          operatorName: 'Operator One',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'Machine One',
          shiftLabel: 'Day shift',
          startKg: 100,
          endKg: 70,
          deltaKg: 30,
          openedAt: '2026-07-21T07:00:00.000Z',
          closedAt: '2026-07-21T20:59:59.000Z',
        },
      ],
    });
    expect(result.bigBags[2].usageHistory).toEqual([
      expect.objectContaining({ id: 'usage-open', endKg: null, deltaKg: null, closedAt: null }),
    ]);
    expect(result.bigBags[3]).toEqual(
      expect.objectContaining({
        status: 'consumed',
        currentSnapshot: {
          measuredKg: 0,
          measuredAt: '2026-07-25T12:00:00.000Z',
        },
        usageHistory: [],
      }),
    );
    const unsafeKeys = collectKeys(result).filter((key) =>
      /raw|payload|frame|sourceSnapshot|qr|token|secret|gateway|device|finance|legal|password|headers?/i.test(
        key,
      ),
    );
    expect(unsafeKeys).toEqual([]);
  });

  it('uses explicit constrained selects and half-open range predicates', async () => {
    const { prisma, service } = setup();

    await service.getAnalytics(query);

    expect(prisma.weightCapture.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        OR: [
          {
            createdAt: {
              gte: new Date('2026-06-23T21:00:00.000Z'),
              lt: new Date('2026-07-23T21:00:00.000Z'),
            },
          },
          { postSessionId: { in: ['session-1', 'session-2', 'session-3'] } },
        ],
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    expect(prisma.weightCapture.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        operatorRollLineId: { in: ['line-duplicate', 'line-1', 'line-2'] },
        createdAt: { lte: expect.any(Date) },
      },
      select: {
        id: true,
        operatorRollLineId: true,
        postSessionId: true,
        kind: true,
        stable: true,
        grossKg: true,
        spoolKg: true,
        netKg: true,
        deviceId: true,
        deviceStatus: true,
        actorId: true,
        supersedesCaptureId: true,
        createdAt: true,
        postSession: {
          select: {
            operator: { select: { id: true, displayName: true } },
          },
        },
        operation: {
          select: {
            status: true,
            actor: { select: { id: true, displayName: true } },
          },
        },
        line: {
          select: {
            id: true,
            planKg: true,
            defects: { select: { createdAt: true } },
            rollDispatchItem: {
              select: {
                id: true,
                rollCode: true,
                characteristicsSnapshot: true,
                productionOrder: {
                  select: {
                    commercialOrder: {
                      select: { id: true, orderNumber: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.defectRecord.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          gte: new Date('2026-07-20T21:00:00.000Z'),
          lt: new Date('2026-07-23T21:00:00.000Z'),
        },
      },
      select: {
        id: true,
        operatorRollLineId: true,
        createdAt: true,
        weightCapture: {
          select: {
            operatorRollLineId: true,
            kind: true,
            stable: true,
            netKg: true,
          },
        },
        spoolStockMovement: {
          select: {
            quantity: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.operatorPostSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'closed',
          endedAt: {
            gte: new Date('2026-07-20T21:00:00.000Z'),
            lt: new Date('2026-07-23T21:00:00.000Z'),
          },
        },
        select: expect.objectContaining({
          operator: { select: { id: true, displayName: true } },
          post: { select: { id: true, code: true, name: true } },
          shift: { select: { id: true, label: true } },
        }),
      }),
    );
    expect(prisma.shiftBagUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { lt: new Date('2026-07-23T21:00:00.000Z') },
          OR: [{ closedAt: null }, { closedAt: { gte: new Date('2026-07-20T21:00:00.000Z') } }],
        },
      }),
    );
    expect(prisma.bigBagUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { lt: new Date('2026-07-23T21:00:00.000Z') },
          OR: [
            { status: { in: ['available', 'in_use'] } },
            {
              shiftUsages: {
                some: {
                  OR: [
                    { closedAt: { gte: new Date('2026-07-20T21:00:00.000Z') } },
                    {
                      createdAt: { lt: new Date('2026-07-23T21:00:00.000Z') },
                      closedAt: null,
                    },
                  ],
                },
              },
            },
          ],
        },
        select: {
          id: true,
          code: true,
          material: true,
          materialId: true,
          status: true,
          initialKg: true,
          currentKg: true,
          lastMeasuredKg: true,
          lastMeasuredAt: true,
          priceKopecksPerKg: true,
          priceEffectiveAt: true,
          createdAt: true,
        },
      }),
    );
  });
});

describe('DirectorAnalyticsService operator-roll drilldown', () => {
  const drilldownQuery = { from: '2026-07-21', to: '2026-07-23' };

  it('canonicalizes before deterministic producedAt-desc and rollId-asc pagination', async () => {
    const firstSetup = setupDrilldown();
    const firstPage = await firstSetup.service.getOperatorRollVariances({
      ...drilldownQuery,
      limit: 2,
    });

    expect(firstPage.items.map(({ rollId }) => rollId)).toEqual([
      'roll-line-newest',
      'roll-line-a',
    ]);
    expect(firstPage.items[0]).toEqual({
      operatorId: 'operator-newest',
      operatorName: 'Operator Newest',
      orderId: 'order-line-newest',
      orderNumber: 'ORDER-line-newest',
      rollId: 'roll-line-newest',
      rollCode: 'ROLL-line-newest',
      producedAt: '2026-07-23T09:00:00.000Z',
      actualCapturedAt: '2026-07-23T09:00:00.000Z',
      plannedKg: 50,
      actualKg: 50,
      varianceKg: 0,
      overPlanKg: 0,
      provenance: 'operation_actor',
    });
    expect(firstPage.items[1]).toEqual(
      expect.objectContaining({
        rollId: 'roll-line-a',
        operatorId: 'operator-original',
        operatorName: 'Original Operator',
        producedAt: '2026-07-22T10:00:00.000Z',
        actualCapturedAt: '2026-07-23T12:00:00.000Z',
        actualKg: 45,
        varianceKg: 5,
        overPlanKg: 5,
        provenance: 'post_session',
      }),
    );
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(
      JSON.parse(Buffer.from(firstPage.nextCursor ?? '', 'base64url').toString('utf8')),
    ).toEqual({
      producedAt: '2026-07-22T10:00:00.000Z',
      rollId: 'roll-line-a',
    });

    const secondSetup = setupDrilldown();
    const secondPage = await secondSetup.service.getOperatorRollVariances({
      ...drilldownQuery,
      cursor: firstPage.nextCursor ?? undefined,
      limit: 2,
    });

    expect(secondPage.items.map(({ rollId }) => rollId)).toEqual([
      'roll-line-b',
      'roll-line-under-page',
    ]);
    const firstPageRollIds = new Set(firstPage.items.map(({ rollId }) => rollId));
    expect(secondPage.items.filter(({ rollId }) => firstPageRollIds.has(rollId))).toEqual([]);
    expect(secondPage.items[0].producedAt).toBe(firstPage.items[1].producedAt);
    expect(secondPage.items[1]).toEqual(
      expect.objectContaining({
        plannedKg: 50,
        actualKg: 40,
        varianceKg: -10,
        overPlanKg: 0,
      }),
    );
  });

  it('returns every canonical roll including missing plan and missing actor rows', async () => {
    const seen = [];
    let cursor: string | undefined;

    do {
      const { service } = setupDrilldown();
      const page = await service.getOperatorRollVariances({
        ...drilldownQuery,
        cursor,
        limit: 2,
      });
      seen.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen.map(({ rollId }) => rollId)).toEqual([
      'roll-line-newest',
      'roll-line-a',
      'roll-line-b',
      'roll-line-under-page',
      'roll-line-missing-plan-page',
      'roll-line-missing-actor-page',
    ]);
    expect(seen.find(({ rollId }) => rollId === 'roll-line-missing-plan-page')).toEqual(
      expect.objectContaining({
        plannedKg: null,
        varianceKg: null,
        overPlanKg: null,
        provenance: 'plan_missing',
      }),
    );
    expect(seen.find(({ rollId }) => rollId === 'roll-line-missing-actor-page')).toEqual(
      expect.objectContaining({
        operatorId: null,
        operatorName: null,
        provenance: 'actor_missing',
      }),
    );
  });

  it.each([
    ['non-base64url alphabet', '***'],
    ['cursor longer than the boundary', 'a'.repeat(501)],
    ['padded base64url', `${testCursor({ producedAt: '2026-07-22T10:00:00.000Z', rollId: 'x' })}=`],
    ['invalid JSON', Buffer.from('not-json', 'utf8').toString('base64url')],
    ['empty roll id', testCursor({ producedAt: '2026-07-22T10:00:00.000Z', rollId: '' })],
    ['blank roll id', testCursor({ producedAt: '2026-07-22T10:00:00.000Z', rollId: '   ' })],
    ['invalid date', testCursor({ producedAt: 'not-a-date', rollId: 'roll-1' })],
    ['non-canonical date', testCursor({ producedAt: '2026-07-22', rollId: 'roll-1' })],
    [
      'extra JSON field',
      testCursor({
        producedAt: '2026-07-22T10:00:00.000Z',
        rollId: 'roll-1',
        rawPayload: 'must-not-pass',
      }),
    ],
  ])('rejects a malformed cursor with %s', async (_case, cursor) => {
    const { service } = setupDrilldown();

    await expect(
      service.getOperatorRollVariances({ ...drilldownQuery, cursor }),
    ).rejects.toMatchObject({
      message: 'Invalid analytics cursor',
    });
  });

  it('rejects a provided empty cursor before reading facts', async () => {
    const { prisma, service } = setupDrilldown();

    await expect(
      service.getOperatorRollVariances({ ...drilldownQuery, cursor: '' }),
    ).rejects.toMatchObject({
      message: 'Invalid analytics cursor',
    });
    expect(prisma.weightCapture.findMany).not.toHaveBeenCalled();
  });

  it('reads the final public Moscow date using the internal year-9999 boundary', async () => {
    const prisma = {
      weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = analyticsService(prisma);

    await expect(
      service.getOperatorRollVariances({
        from: '9998-12-31',
        to: '9998-12-31',
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(prisma.weightCapture.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        createdAt: {
          gte: new Date('9998-12-30T21:00:00.000Z'),
          lt: new Date('9998-12-31T21:00:00.000Z'),
        },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
  });

  it('enforces the as-of upper bound and uses only explicit safe capture projections', async () => {
    const { prisma, service } = setupDrilldown();

    const result = await service.getOperatorRollVariances(drilldownQuery);

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rollId: 'roll-line-newest',
        actualKg: 50,
        actualCapturedAt: '2026-07-23T09:00:00.000Z',
      }),
    );
    expect(result.items).toHaveLength(6);
    expect(result.nextCursor).toBeNull();
    expect(prisma.weightCapture.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        kind: 'roll',
        stable: true,
        netKg: { not: null },
        createdAt: {
          gte: new Date('2026-07-20T21:00:00.000Z'),
          lt: new Date('2026-07-23T21:00:00.000Z'),
        },
      },
      select: { operatorRollLineId: true },
      distinct: ['operatorRollLineId'],
    });
    expect(prisma.weightCapture.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          operatorRollLineId: {
            in: [
              'line-newest',
              'line-a',
              'line-b',
              'line-under-page',
              'line-missing-plan-page',
              'line-missing-actor-page',
            ],
          },
          createdAt: { lt: new Date('2026-07-23T21:00:00.000Z') },
        },
        select: expect.any(Object),
      }),
    );
    const captureQuery = (prisma.weightCapture.findMany as jest.Mock).mock.calls[1][0] as {
      select: unknown;
    };
    expect(
      collectKeys(captureQuery.select).filter((key) =>
        /raw|payload|frame|sourceSnapshot|token|secret|headers?/i.test(key),
      ),
    ).toEqual([]);
    expect(
      collectKeys(result).filter((key) =>
        /raw|payload|frame|sourceSnapshot|token|secret|headers?/i.test(key),
      ),
    ).toEqual([]);
  });
});

describe('DirectorAnalyticsService final public date boundary', () => {
  it('returns the exact half-open upper boundary in aggregate analytics', async () => {
    const { service } = setupApplications();

    const result = await service.getAnalytics({
      from: '9998-12-31',
      to: '9998-12-31',
      bucket: 'day',
    });

    expect(result.range.effective).toEqual({
      fromUtc: '9998-12-30T21:00:00.000Z',
      toExclusiveUtc: '9998-12-31T21:00:00.000Z',
    });
  });
});

const evidenceQuery = {
  from: '2026-07-21',
  to: '2026-07-23',
  bucket: 'day' as const,
};

const evidenceBag = {
  id: 'bag-1',
  code: 'BB-001',
  materialId: 'material-1',
  material: 'PE-1',
  status: 'in_use',
  currentKg: 70,
  lastMeasuredKg: 70,
  lastMeasuredAt: new Date('2026-07-23T18:00:00.000Z'),
  initialKg: 100,
  priceKopecksPerKg: 2_500,
  priceEffectiveAt: new Date('2026-07-20T12:00:00.000Z'),
  rawPayload: { forbidden: true },
};

const evidenceUsage = {
  id: 'usage-1',
  sessionId: 'session-1',
  bigBagId: 'bag-1',
  startKg: 100,
  endKg: 70,
  releasedReason: null,
  createdAt: new Date('2026-07-23T08:00:00.000Z'),
  closedAt: new Date('2026-07-23T18:00:00.000Z'),
  episodes: [
    {
      id: 'episode-1',
      usageId: 'usage-1',
      sequence: 1,
      startKg: 100,
      endKg: 70,
      closeKind: 'shift_closed',
      openedAt: new Date('2026-07-23T08:00:00.000Z'),
      closedAt: new Date('2026-07-23T18:00:00.000Z'),
    },
  ],
  bigBag: evidenceBag,
};

const evidenceSession = {
  id: 'session-1',
  status: 'closed',
  startedAt: new Date('2026-07-23T07:00:00.000Z'),
  endedAt: new Date('2026-07-23T18:00:00.000Z'),
  operator: {
    id: 'operator-1',
    displayName: 'Operator One',
    passwordHash: 'forbidden',
  },
  post: {
    id: 'post-1',
    code: 'POST-1',
    name: 'Machine One',
    gatewayTokenHash: 'forbidden',
  },
  shift: { id: 'shift-1', label: 'Day shift' },
  bagUsages: [evidenceUsage],
};

const evidenceCapture = capture('evidence-roll-1', {
  operatorRollLineId: 'evidence-line-1',
  postSessionId: 'session-1',
  netKg: 25,
  createdAt: new Date('2026-07-23T17:00:00.000Z'),
  postSession: {
    operator: { id: 'operator-1', displayName: 'Operator One' },
  },
  line: analyticsLine('evidence-line-1', 25),
});

const evidenceDefect = {
  id: 'defect-1',
  operatorRollLineId: 'evidence-line-1',
  createdAt: new Date('2026-07-23T17:30:00.000Z'),
  weightCapture: {
    operatorRollLineId: 'evidence-line-1',
    kind: 'roll',
    stable: true,
    netKg: 25,
    createdAt: new Date('2026-07-23T17:00:00.000Z'),
    rawPayload: { forbidden: true },
  },
};

function setupEvidence(input?: {
  sessions?: (typeof evidenceSession)[];
  usages?: Array<typeof evidenceUsage & { session: Omit<typeof evidenceSession, 'bagUsages'> }>;
  captures?: DirectorRollFactSource[];
  defects?: (typeof evidenceDefect)[];
}) {
  const sessions = input?.sessions ?? [evidenceSession];
  const evidenceCaptures = input?.captures ?? [evidenceCapture];
  const evidenceDefects = input?.defects ?? [evidenceDefect];
  const usages = input?.usages ?? [
    {
      ...evidenceUsage,
      session: {
        ...evidenceSession,
        bagUsages: [evidenceUsage],
      },
    },
  ];
  const prisma = {
    operatorPostSession: { findMany: jest.fn().mockResolvedValue(sessions) },
    shiftBagUsage: { findMany: jest.fn().mockResolvedValue(usages) },
    weightCapture: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(
          evidenceCaptures.map(({ operatorRollLineId }) => ({ operatorRollLineId })),
        )
        .mockResolvedValueOnce(evidenceCaptures),
    },
    defectRecord: { findMany: jest.fn().mockResolvedValue(evidenceDefects) },
  };
  return { prisma, service: analyticsService(prisma) };
}

function setupSparseShiftEvidence() {
  const firstChunk = Array.from({ length: 64 }, (_, index) => ({
    ...evidenceSession,
    id: `session-sparse-${String(index + 1).padStart(2, '0')}`,
    startedAt: new Date(evidenceSession.startedAt.getTime() - index * 60_000),
    endedAt: new Date(evidenceSession.endedAt.getTime() - index * 60_000),
    bagUsages: [],
  }));
  const matchingSession = {
    ...evidenceSession,
    id: 'session-match',
    startedAt: new Date(evidenceSession.startedAt.getTime() - 65 * 60_000),
    endedAt: new Date(evidenceSession.endedAt.getTime() - 65 * 60_000),
  };
  const prisma = {
    operatorPostSession: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(firstChunk)
        .mockResolvedValueOnce([matchingSession]),
    },
    shiftBagUsage: { findMany: jest.fn().mockResolvedValue([]) },
    weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
  };

  return { prisma, service: analyticsService(prisma) };
}

type EvidenceService = {
  getShiftBalanceEvidence(
    query: DirectorAnalyticsShiftEvidenceQuery,
  ): Promise<DirectorAnalyticsShiftEvidencePage>;
  getBigBagEvidence(
    query: DirectorAnalyticsBigBagEvidenceQuery,
  ): Promise<DirectorAnalyticsBigBagEvidencePage>;
};

function asEvidenceService(service: DirectorAnalyticsService): EvidenceService {
  return service as unknown as EvidenceService;
}

describe('DirectorAnalyticsService shift and BigBag evidence', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T09:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('scans past 64 sessions that fail the computed status filter', async () => {
    const { prisma, service } = setupSparseShiftEvidence();

    const page = await asEvidenceService(service).getShiftBalanceEvidence({
      ...evidenceQuery,
      status: 'mismatch',
      limit: 1,
    });

    expect(page.items.map(({ sessionId }) => sessionId)).toEqual(['session-match']);
    expect(page.nextCursor).toBeNull();
    expect(prisma.operatorPostSession.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.operatorPostSession.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 64 }),
    );
  });

  it('scans later chunks for a numeric match instead of returning an early raw row', async () => {
    const { service } = setupSparseShiftEvidence();

    const page = await asEvidenceService(service).getShiftBalanceEvidence({
      ...evidenceQuery,
      actualUsageKgMin: 30,
      actualUsageKgMax: 30,
      limit: 1,
    });

    expect(page.items.map(({ sessionId }) => sessionId)).toEqual(['session-match']);
    expect(page.nextCursor).toBeNull();
  });

  it('applies computed filters after deriving canonical session evidence metrics', async () => {
    const { prisma, service } = setupEvidence();

    await expect(
      asEvidenceService(service).getShiftBalanceEvidence({
        ...evidenceQuery,
        producedKgMin: 26,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(prisma.weightCapture.findMany).toHaveBeenCalled();
  });

  it('pushes shift identity searches and Moscow date predicates into Prisma', async () => {
    const { prisma, service } = setupEvidence({ sessions: [], usages: [] });

    await asEvidenceService(service).getShiftBalanceEvidence({
      ...evidenceQuery,
      operatorQuery: 'Operator One',
      postQuery: 'Machine One',
      shiftQuery: 'Day shift',
      startedFrom: '2026-07-22',
      startedTo: '2026-07-22',
      endedFrom: '2026-07-23',
      endedTo: '2026-07-23',
    });

    expect(prisma.operatorPostSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startedAt: {
            gte: new Date('2026-07-21T21:00:00.000Z'),
            lt: new Date('2026-07-22T21:00:00.000Z'),
          },
          endedAt: {
            gte: new Date('2026-07-22T21:00:00.000Z'),
            lt: new Date('2026-07-23T21:00:00.000Z'),
          },
          AND: expect.arrayContaining([
            {
              OR: [
                { operatorId: { contains: 'Operator One', mode: 'insensitive' } },
                {
                  operator: {
                    displayName: { contains: 'Operator One', mode: 'insensitive' },
                  },
                },
              ],
            },
            {
              OR: [
                { postId: { contains: 'Machine One', mode: 'insensitive' } },
                { post: { code: { contains: 'Machine One', mode: 'insensitive' } } },
                { post: { name: { contains: 'Machine One', mode: 'insensitive' } } },
              ],
            },
            {
              OR: [
                { id: { contains: 'Day shift', mode: 'insensitive' } },
                { shiftId: { contains: 'Day shift', mode: 'insensitive' } },
                { shift: { label: { contains: 'Day shift', mode: 'insensitive' } } },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('pushes BigBag material, status and Moscow date predicates into Prisma', async () => {
    const { prisma, service } = setupEvidence({ sessions: [], usages: [] });

    await asEvidenceService(service).getBigBagEvidence({
      ...evidenceQuery,
      bigBagQuery: 'BB-001',
      materialQuery: 'PE-1',
      bigBagStatus: 'in_use',
      openedFrom: '2026-07-22',
      openedTo: '2026-07-22',
      closedFrom: '2026-07-23',
      closedTo: '2026-07-23',
      usageState: 'closed',
    });

    expect(prisma.shiftBagUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-07-21T21:00:00.000Z'),
            lt: new Date('2026-07-22T21:00:00.000Z'),
          },
          closedAt: {
            gte: new Date('2026-07-22T21:00:00.000Z'),
            lt: new Date('2026-07-23T21:00:00.000Z'),
          },
          bigBag: { status: 'in_use' },
          AND: expect.arrayContaining([
            {
              OR: [
                { bigBagId: { contains: 'BB-001', mode: 'insensitive' } },
                { bigBag: { code: { contains: 'BB-001', mode: 'insensitive' } } },
              ],
            },
            {
              OR: [
                { bigBag: { materialId: { contains: 'PE-1', mode: 'insensitive' } } },
                { bigBag: { material: { contains: 'PE-1', mode: 'insensitive' } } },
              ],
            },
            { closedAt: { not: null } },
          ]),
        }),
      }),
    );
  });

  it.each([
    [{ operatorId: 'operator-1' }, { operatorId: 'operator-1' }],
    [{ postId: 'post-1' }, { postId: 'post-1' }],
    [{ shiftId: 'shift-1' }, { shiftId: 'shift-1' }],
    [{ bigBagId: 'bag-1' }, { bagUsages: { some: { bigBagId: 'bag-1' } } }],
  ])('pushes shift filter %j into the bounded database query', async (filter, predicate) => {
    const { prisma, service } = setupEvidence({ sessions: [], usages: [] });

    await asEvidenceService(service).getShiftBalanceEvidence({
      ...evidenceQuery,
      ...filter,
      limit: 7,
    });

    expect(prisma.operatorPostSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining(predicate),
        orderBy: [{ endedAt: 'desc' }, { id: 'asc' }],
        take: 64,
      }),
    );
  });

  it('combines safe search and linkage predicates at the database boundary', async () => {
    const { prisma, service } = setupEvidence();

    const page = await asEvidenceService(service).getShiftBalanceEvidence({
      ...evidenceQuery,
      operatorId: 'operator-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      bigBagId: 'bag-1',
      status: 'mismatch',
      q: 'Machine One',
      limit: 20,
    });

    expect(prisma.operatorPostSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'closed',
          operatorId: 'operator-1',
          postId: 'post-1',
          shiftId: 'shift-1',
          bagUsages: { some: { bigBagId: 'bag-1' } },
          endedAt: {
            gte: new Date('2026-07-20T21:00:00.000Z'),
            lt: new Date('2026-07-23T21:00:00.000Z'),
          },
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                { id: { contains: 'Machine One', mode: 'insensitive' } },
                {
                  operator: {
                    displayName: { contains: 'Machine One', mode: 'insensitive' },
                  },
                },
                {
                  bagUsages: {
                    some: {
                      bigBag: {
                        code: { contains: 'Machine One', mode: 'insensitive' },
                      },
                    },
                  },
                },
              ]),
            },
          ]),
        }),
        take: 80,
      }),
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        shiftId: 'shift-1',
        operatorId: 'operator-1',
        postId: 'post-1',
        startKg: 100,
        endKg: 70,
        currentKg: 70,
        actualUsageKg: 30,
        expectedUsageKg: 25,
        producedKg: 0,
        rollCount: 1,
        defectKg: 25,
        defectCount: 1,
        unverifiedDefectCount: 0,
        deviationKg: 5,
        deviationPercent: 20,
        status: 'mismatch',
        source: {
          usage: 'shift_bag_usage',
          production: 'canonical_roll_weight_capture',
          defects: 'linked_stable_defect_weight_capture',
          latestEvidenceAt: '2026-07-23T18:00:00.000Z',
          freshness: 'fresh',
        },
      }),
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps status filtering server-side and does not return a non-matching candidate page', async () => {
    const { service } = setupEvidence();

    await expect(
      asEvidenceService(service).getShiftBalanceEvidence({
        ...evidenceQuery,
        status: 'ok',
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('uses stable timestamp/id cursors and rejects malformed or cross-endpoint cursors', async () => {
    const secondSession = {
      ...evidenceSession,
      id: 'session-2',
      operator: { ...evidenceSession.operator, id: 'operator-2' },
    };
    const firstSetup = setupEvidence({ sessions: [evidenceSession, secondSession], usages: [] });
    const first = await asEvidenceService(firstSetup.service).getShiftBalanceEvidence({
      ...evidenceQuery,
      limit: 1,
    });

    expect(first.items.map(({ sessionId }) => sessionId)).toEqual(['session-1']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8'))).toEqual({
      kind: 'shift',
      timestamp: '2026-07-23T18:00:00.000Z',
      id: 'session-1',
    });

    const secondSetup = setupEvidence({ sessions: [secondSession], usages: [] });
    await asEvidenceService(secondSetup.service).getShiftBalanceEvidence({
      ...evidenceQuery,
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    expect(secondSetup.prisma.operatorPostSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: [
                { endedAt: { lt: new Date('2026-07-23T18:00:00.000Z') } },
                {
                  endedAt: new Date('2026-07-23T18:00:00.000Z'),
                  id: { gt: 'session-1' },
                },
              ],
            },
          ],
        }),
      }),
    );

    const malformedSetup = setupEvidence({ sessions: [], usages: [] });
    await expect(
      asEvidenceService(malformedSetup.service).getShiftBalanceEvidence({
        ...evidenceQuery,
        cursor: Buffer.from(
          JSON.stringify({
            kind: 'bigbag',
            timestamp: '2026-07-23T18:00:00.000Z',
            id: 'usage-1',
          }),
        ).toString('base64url'),
      }),
    ).rejects.toMatchObject({ message: 'Invalid analytics evidence cursor' });
    expect(malformedSetup.prisma.operatorPostSession.findMany).not.toHaveBeenCalled();
  });

  it('pushes BigBag linkage filters, touched-date boundaries and safe search into one bounded query', async () => {
    const { prisma, service } = setupEvidence();

    const page = await asEvidenceService(service).getBigBagEvidence({
      ...evidenceQuery,
      operatorId: 'operator-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      bigBagId: 'bag-1',
      status: 'mismatch',
      q: 'BB-001',
      limit: 20,
    });

    expect(prisma.shiftBagUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bigBagId: 'bag-1',
          createdAt: { lt: new Date('2026-07-23T21:00:00.000Z') },
          session: {
            is: expect.objectContaining({
              operatorId: 'operator-1',
              postId: 'post-1',
              shiftId: 'shift-1',
            }),
          },
          AND: expect.arrayContaining([
            {
              OR: [{ closedAt: null }, { closedAt: { gte: new Date('2026-07-20T21:00:00.000Z') } }],
            },
            {
              OR: expect.arrayContaining([
                {
                  bigBag: {
                    code: { contains: 'BB-001', mode: 'insensitive' },
                  },
                },
                {
                  session: {
                    operator: {
                      displayName: { contains: 'BB-001', mode: 'insensitive' },
                    },
                  },
                },
              ]),
            },
          ]),
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 80,
      }),
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'usage-1',
        bigBagId: 'bag-1',
        bigBagCode: 'BB-001',
        sessionId: 'session-1',
        shiftId: 'shift-1',
        operatorId: 'operator-1',
        postId: 'post-1',
        startKg: 100,
        endKg: 70,
        currentKg: 70,
        priceKopecksPerKg: 2_500,
        totalKopecks: 175_000,
        priceEffectiveAt: '2026-07-20T12:00:00.000Z',
        bagUsageKg: 30,
        actualUsageKg: 30,
        expectedUsageKg: 25,
        calculatedRemainderKg: 75,
        producedKg: 0,
        rollCount: 1,
        defectKg: 25,
        defectCount: 1,
        deviationKg: -5,
        deviationPercent: -6.667,
        balanceScope: 'usage_episodes',
        status: 'mismatch',
      }),
    ]);
  });

  it('attributes sequential BigBag episode production and confirmed defect facts without smearing', async () => {
    const usageA = {
      ...evidenceUsage,
      id: 'usage-a',
      bigBagId: 'bag-a',
      startKg: 100,
      endKg: 90,
      bigBag: { ...evidenceBag, id: 'bag-a', code: 'BB-A', initialKg: 100, currentKg: 90 },
      episodes: [
        {
          id: 'episode-a',
          usageId: 'usage-a',
          sequence: 1,
          startKg: 100,
          endKg: 90,
          closeKind: 'shift_closed',
          openedAt: new Date('2026-07-23T08:00:00.000Z'),
          closedAt: new Date('2026-07-23T12:00:00.000Z'),
        },
      ],
    };
    const usageB = {
      ...evidenceUsage,
      id: 'usage-b',
      bigBagId: 'bag-b',
      startKg: 200,
      endKg: 180,
      createdAt: new Date('2026-07-23T12:00:00.000Z'),
      bigBag: { ...evidenceBag, id: 'bag-b', code: 'BB-B', initialKg: 200, currentKg: 180 },
      episodes: [
        {
          id: 'episode-b',
          usageId: 'usage-b',
          sequence: 1,
          startKg: 200,
          endKg: 180,
          closeKind: 'shift_closed',
          openedAt: new Date('2026-07-23T12:00:00.000Z'),
          closedAt: new Date('2026-07-23T18:00:00.000Z'),
        },
      ],
    };
    const session = { ...evidenceSession, bagUsages: [usageA, usageB] };
    const captureA = capture('capture-a', {
      operatorRollLineId: 'line-a',
      postSessionId: session.id,
      netKg: 10,
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
    });
    const captureB = capture('capture-b', {
      operatorRollLineId: 'line-b',
      postSessionId: session.id,
      netKg: 15,
      createdAt: new Date('2026-07-23T15:00:00.000Z'),
    });
    const defectCapture = capture('capture-defect-b', {
      operatorRollLineId: 'line-defect-b',
      postSessionId: session.id,
      netKg: 5,
      createdAt: new Date('2026-07-23T16:00:00.000Z'),
    });
    const defect = {
      ...evidenceDefect,
      id: 'defect-b',
      operatorRollLineId: 'line-defect-b',
      createdAt: new Date('2026-07-23T16:00:00.000Z'),
      weightCapture: {
        ...evidenceDefect.weightCapture,
        operatorRollLineId: 'line-defect-b',
        netKg: 5,
        createdAt: new Date('2026-07-23T16:00:00.000Z'),
      },
    };
    const { service } = setupEvidence({
      sessions: [],
      usages: [
        { ...usageA, session },
        { ...usageB, session },
      ] as never,
      captures: [captureA, captureB, defectCapture],
      defects: [defect],
    });

    const page = await asEvidenceService(service).getBigBagEvidence(evidenceQuery);
    const facts = Object.fromEntries(page.items.map((item) => [item.id, item]));

    expect(facts['usage-a']).toEqual(
      expect.objectContaining({
        expectedUsageKg: 10,
        producedKg: 10,
        defectKg: 0,
        deviationKg: 0,
      }),
    );
    expect(facts['usage-b']).toEqual(
      expect.objectContaining({
        expectedUsageKg: 20,
        producedKg: 15,
        defectKg: 5,
        deviationKg: 0,
      }),
    );
  });

  it('uses an independent stable cursor for equal-time BigBag usage rows', async () => {
    const secondUsage = {
      ...evidenceUsage,
      id: 'usage-2',
      bigBagId: 'bag-2',
      bigBag: { ...evidenceBag, id: 'bag-2', code: 'BB-002' },
      session: {
        ...evidenceSession,
        bagUsages: [
          {
            ...evidenceUsage,
            id: 'usage-2',
            bigBagId: 'bag-2',
            bigBag: { ...evidenceBag, id: 'bag-2', code: 'BB-002' },
          },
        ],
      },
    };
    const firstSetup = setupEvidence({
      sessions: [],
      usages: [
        {
          ...evidenceUsage,
          session: { ...evidenceSession, bagUsages: [evidenceUsage] },
        },
        secondUsage,
      ] as never,
    });

    const first = await asEvidenceService(firstSetup.service).getBigBagEvidence({
      ...evidenceQuery,
      limit: 1,
    });

    expect(first.items.map(({ id }) => id)).toEqual(['usage-1']);
    expect(JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8'))).toEqual({
      kind: 'bigbag',
      timestamp: '2026-07-23T08:00:00.000Z',
      id: 'usage-1',
    });

    const secondSetup = setupEvidence({
      sessions: [],
      usages: [secondUsage] as never,
    });
    await asEvidenceService(secondSetup.service).getBigBagEvidence({
      ...evidenceQuery,
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    expect(secondSetup.prisma.shiftBagUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { createdAt: { lt: new Date('2026-07-23T08:00:00.000Z') } },
                {
                  createdAt: new Date('2026-07-23T08:00:00.000Z'),
                  id: { gt: 'usage-1' },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('marks a current measurement older than the usage close fact as stale', async () => {
    const staleBag = {
      ...evidenceBag,
      lastMeasuredAt: new Date('2026-07-23T17:59:59.000Z'),
    };
    const staleUsageRow = {
      ...evidenceUsage,
      bigBag: staleBag,
    };
    const staleSession = {
      ...evidenceSession,
      bagUsages: [staleUsageRow],
    };
    const { service } = setupEvidence({
      sessions: [staleSession],
      usages: [],
    });

    const page = await asEvidenceService(service).getShiftBalanceEvidence(evidenceQuery);

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        bigBags: [
          expect.objectContaining({
            currentMeasuredAt: '2026-07-23T17:59:59.000Z',
            currentFreshness: 'stale',
          }),
        ],
        source: expect.objectContaining({ freshness: 'stale' }),
      }),
    );
  });

  it('returns nullable evidence instead of invented weights and reports stale/unknown sources', async () => {
    const pendingBag = {
      ...evidenceBag,
      id: 'bag-pending',
      code: 'BB-PENDING',
      currentKg: null,
      lastMeasuredKg: null,
      lastMeasuredAt: null,
    };
    const pendingUsageRow = {
      ...evidenceUsage,
      id: 'usage-pending',
      bigBagId: 'bag-pending',
      endKg: null,
      closedAt: null,
      bigBag: pendingBag,
    };
    const pendingUsage = {
      ...pendingUsageRow,
      session: {
        ...evidenceSession,
        status: 'active',
        endedAt: null,
        bagUsages: [pendingUsageRow],
      },
    };
    const { service } = setupEvidence({
      sessions: [],
      usages: [pendingUsage as never],
    });

    const page = await asEvidenceService(service).getBigBagEvidence(evidenceQuery);

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        endKg: null,
        currentKg: null,
        bagUsageKg: null,
        actualUsageKg: null,
        deviationKg: null,
        deviationPercent: null,
        status: 'pending',
        source: expect.objectContaining({
          freshness: 'unknown',
        }),
      }),
    );
  });

  it('projects explicit safe fields without credentials, raw payloads or device diagnostics', async () => {
    const shiftSetup = setupEvidence();
    const bagSetup = setupEvidence();

    const [shiftPage, bagPage] = await Promise.all([
      asEvidenceService(shiftSetup.service).getShiftBalanceEvidence(evidenceQuery),
      asEvidenceService(bagSetup.service).getBigBagEvidence(evidenceQuery),
    ]);
    const unsafe =
      /raw|payload|frame|sourceSnapshot|qr|token|secret|gateway|device|password|headers?/i;

    expect(collectKeys({ shiftPage, bagPage }).filter((key) => unsafe.test(key))).toEqual([]);
    for (const model of [shiftSetup.prisma.operatorPostSession, bagSetup.prisma.shiftBagUsage]) {
      const select = (model.findMany as jest.Mock).mock.calls[0][0].select;
      expect(collectKeys(select).filter((key) => unsafe.test(key))).toEqual([]);
    }
  });
});
