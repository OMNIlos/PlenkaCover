import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  calculateRollProductionCost,
  type RollProductionCostCalculationInput,
} from '../../common/production-cost/production-cost-calculator';
import type { ProductionCostSourceSnapshotInput } from '../../common/production-cost/production-cost-source-snapshot';
import type { RollProductionCostEligibilityFact } from './roll-production-cost-eligibility';
import {
  RollProductionCostSnapshotReconciler,
  RollProductionCostSnapshotService,
  type PreparedRollProductionCost,
} from './roll-production-cost-snapshot.service';

const NOW = new Date('2026-08-04T00:00:00Z');
const FINANCE_ACTOR = {
  userId: 'finance-user-1',
  role: 'finance' as const,
  capabilities: ['production_cost:correct' as const],
};
const CORRECTION = {
  operationKey: '00000000-0000-4000-8000-000000000099',
  expectedVersion: 1,
  reason: 'Исправление справочника',
};

function eligibility(
  overrides: Partial<RollProductionCostEligibilityFact> = {},
): RollProductionCostEligibilityFact {
  return {
    canonicalCaptureId: 'capture-1',
    canonicalCaptureIsLeaf: true,
    basisWeightGrams: 10_000,
    producedAt: new Date('2026-08-02T10:00:00Z'),
    hasDefect: false,
    operatorStep: 'warehouse',
    dispatchStatus: 'done',
    dispatchCompletedAt: new Date('2026-08-02T17:00:00Z'),
    rootPostSessionId: 'session-1',
    rootPostSessionStatus: 'closed',
    rootPostSessionEndedAt: new Date('2026-08-02T17:30:00Z'),
    machineAssignmentId: 'assignment-1',
    machineAssignmentStatus: 'completed',
    shiftId: 'shift-1',
    shiftStatus: 'closed',
    shiftEndedAt: new Date('2026-08-02T18:00:00Z'),
    ...overrides,
  };
}

function calculation(
  overrides: Partial<RollProductionCostCalculationInput> = {},
): RollProductionCostCalculationInput {
  return {
    basis: { kind: 'actual', weightGrams: 10_000 },
    producedAt: new Date('2026-08-02T10:00:00Z'),
    materialBasis: {
      kind: 'recipe_reference',
      components: [
        {
          rawMaterialDefinitionId: 'material-1',
          label: 'ПНД',
          shareBasisPoints: 10_000,
          prices: [
            {
              id: 'material-price-1',
              priceKopecksPerKg: 2_000,
              source: 'Счёт',
              effectiveFrom: new Date('2026-08-01T00:00:00Z'),
            },
          ],
        },
      ],
    },
    spool: {
      label: 'Шпуля 76 мм',
      knownTypeLabels: ['Шпуля 76 мм'],
      widthMicrometers: 1_500_000,
      prices: [
        {
          id: 'spool-price-1',
          spoolTypeKey: 'шпуля 76 мм',
          spoolTypeLabel: 'Шпуля 76 мм',
          priceKopecksPerMeter: 6_000,
          source: 'Прайс',
          effectiveFrom: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    },
    payroll: {
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      tariffOrderName: 'Приказ № 8-09/25',
      effectiveFrom: new Date('2025-09-28T21:00:00Z'),
      rateKopecksPerKg: 400,
      basisLabel: 'базовая ставка',
    },
    additionalCosts: [],
    ...overrides,
  };
}

function sourceSnapshot(): ProductionCostSourceSnapshotInput {
  return {
    basis: {
      rollDispatchItemId: 'roll-1',
      basisWeightGrams: 10_000,
      producedAt: new Date('2026-08-02T10:00:00Z'),
      closedAt: new Date('2026-08-02T18:00:00Z'),
    },
    eligibility: {
      canonicalCaptureId: 'capture-1',
      rootCaptureId: 'root-capture-1',
      rootPostSessionId: 'session-1',
      shiftId: 'shift-1',
      machineAssignmentId: 'assignment-1',
      dispatchCompletedAt: new Date('2026-08-02T17:00:00Z'),
      sessionEndedAt: new Date('2026-08-02T17:30:00Z'),
      shiftEndedAt: new Date('2026-08-02T18:00:00Z'),
    },
    material: {
      kind: 'recipe_reference',
      sources: [
        {
          kind: 'recipe_reference',
          sourceId: 'material-price-1',
          materialDefinitionId: 'material-1',
          label: 'ПНД',
          componentGrams: 10_000,
          shareBasisPoints: 10_000,
          priceKopecksPerKg: 2_000,
          effectiveAt: new Date('2026-08-01T00:00:00Z'),
          allocatedAmountKopecks: 20_000,
        },
      ],
    },
    spool: {
      sourceId: 'spool-price-1',
      spoolTypeKey: 'шпуля 76 мм',
      spoolTypeLabel: 'Шпуля 76 мм',
      widthMicrometers: 1_500_000,
      priceKopecksPerMeter: 6_000,
      effectiveAt: new Date('2026-08-01T00:00:00Z'),
      allocatedAmountKopecks: 9_000,
    },
    payroll: {
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      tariffOrderName: 'Приказ № 8-09/25',
      effectiveFrom: new Date('2025-09-28T21:00:00Z'),
      rateKopecksPerKg: 400,
      basisLabel: 'базовая ставка',
      allocatedAmountKopecks: 4_000,
    },
    additional: [],
  };
}

function prepared(overrides: Partial<PreparedRollProductionCost> = {}): PreparedRollProductionCost {
  return {
    rollDispatchItemId: 'roll-1',
    eligibility: eligibility(),
    actualInput: calculation(),
    pendingInput: calculation(),
    plannedInput: { ...calculation(), basis: { kind: 'planned', weightGrams: 12_000 } },
    sourceSnapshot: sourceSnapshot(),
    ...overrides,
  };
}

function preparedForRoll(rollDispatchItemId: string): PreparedRollProductionCost {
  const source = sourceSnapshot();
  return prepared({
    rollDispatchItemId,
    sourceSnapshot: {
      ...source,
      basis: { ...source.basis, rollDispatchItemId },
    },
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snapshot-1',
    rollDispatchItemId: 'roll-1',
    version: 1,
    supersedesSnapshotId: null,
    operationKey: '00000000-0000-4000-8000-000000000001',
    requestFingerprint: 'a'.repeat(64),
    calculationFingerprint: 'b'.repeat(64),
    calculationVersion: 'historical-v0',
    basis: 'actual',
    basisWeightGrams: 10_000,
    producedAt: new Date('2026-08-02T10:00:00Z'),
    closedAt: new Date('2026-08-02T18:00:00Z'),
    status: 'complete',
    materialAmountKopecks: 20_000n,
    spoolAmountKopecks: 9_000n,
    payrollAmountKopecks: 4_000n,
    additionalAmountKopecks: 0n,
    totalAmountKopecks: 33_000n,
    totalKopecksPerKg: 3_300n,
    unresolvedReasons: [],
    sourceSnapshot: {},
    actorId: null,
    actorRole: null,
    systemActorKey: 'production_cost_reconciler',
    correctionReason: null,
    createdAt: new Date('2026-08-02T18:00:01Z'),
    ...overrides,
  };
}

function fixture(options: { latest?: unknown[]; prepared?: PreparedRollProductionCost[] } = {}) {
  const create = jest.fn(async ({ data }) =>
    snapshot({
      ...data,
      id: 'created-snapshot',
      createdAt: NOW,
    }),
  );
  const findUnique = jest.fn().mockResolvedValue(null);
  const findFirst = jest.fn().mockResolvedValue(options.latest?.[0] ?? null);
  const tx = {
    rollProductionCostSnapshot: { create, findUnique, findFirst },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const latestQuery = jest.fn().mockResolvedValue(options.latest ?? []);
  const prisma = {
    rollProductionCostSnapshot: {
      findMany: jest.fn().mockResolvedValue(options.latest ?? []),
      findUnique,
    },
    rollDispatchItem: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: latestQuery,
    $transaction: jest.fn(async (callback) => callback(tx)),
  };
  const assembler = {
    prepare: jest
      .fn()
      .mockResolvedValue(
        new Map(
          (options.prepared ?? [prepared()]).map((value) => [value.rollDispatchItemId, value]),
        ),
      ),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  return {
    prisma,
    assembler,
    audit,
    create,
    findUnique,
    findFirst,
    latestQuery,
    tx,
    service: new RollProductionCostSnapshotService(
      prisma as never,
      assembler as never,
      audit as never,
    ),
  };
}

describe('RollProductionCostSnapshotService', () => {
  it('serves opaque historical snapshots in one batch and GET performs zero writes/audits', async () => {
    const context = fixture({ latest: [snapshot()] });
    const result = await context.service.getViewsForRollIds(['roll-1'], NOW);

    expect(result.get('roll-1')).toMatchObject({
      kind: 'actual_snapshot',
      status: 'complete',
      calculationVersion: 'historical-v0',
      snapshotId: 'snapshot-1',
      version: 1,
      totalAmountKopecks: 33_000,
    });
    expect(context.latestQuery).toHaveBeenCalledTimes(1);
    const query = context.latestQuery.mock.calls[0][0];
    const statement = Array.isArray(query?.strings) ? query.strings.join('?') : String(query);
    expect(statement).toMatch(
      /SELECT DISTINCT ON \("rollDispatchItemId"\).*ORDER BY "rollDispatchItemId", "version" DESC.*LIMIT/su,
    );
    expect(query.values).toEqual(['roll-1', 1]);
    expect(context.prisma.rollProductionCostSnapshot.findMany).not.toHaveBeenCalled();
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
    expect(context.create).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
    expect(context.assembler.prepare).not.toHaveBeenCalled();
  });

  it('normalizes the known legacy payroll policy to bootstrap order provenance without a write', async () => {
    const context = fixture({
      latest: [
        snapshot({
          sourceSnapshot: {
            payroll: {
              policyId: 'order-8-09-25@2025-09-29',
              sourceLabel: 'Приказ № 8-09/25',
              effectiveAt: '2025-09-28T21:00:00.000Z',
              rateKopecksPerKg: 400,
              basisLabel: 'УРП · 12 ч · первичка',
              allocatedAmountKopecks: 4_000,
            },
          },
        }),
      ],
    });

    const result = await context.service.getViewsForRollIds(['roll-1'], NOW);

    expect(result.get('roll-1')).toMatchObject({
      payrollSource: {
        tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
        tariffOrderName: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        rateKopecksPerKg: 400,
        basisLabel: 'УРП · 12 ч · первичка',
      },
    });
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
    expect(context.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown legacy payroll policy in persisted storage', async () => {
    const context = fixture({
      latest: [
        snapshot({
          sourceSnapshot: {
            payroll: {
              policyId: 'unknown-policy',
              sourceLabel: 'Неизвестный приказ',
              effectiveAt: '2025-09-28T21:00:00.000Z',
              rateKopecksPerKg: 400,
              basisLabel: 'ставка',
              allocatedAmountKopecks: 4_000,
            },
          },
        }),
      ],
    });

    await expect(context.service.getViewsForRollIds(['roll-1'], NOW)).rejects.toThrow(
      'unknown legacy payroll policy',
    );
  });

  it('fails closed when the latest-per-roll query returns more rows than requested ids', async () => {
    const context = fixture({
      latest: [snapshot({ version: 2 }), snapshot({ id: 'snapshot-old', version: 1 })],
    });

    await expect(context.service.getViewsForRollIds(['roll-1'], NOW)).rejects.toThrow(
      'latest production cost snapshot query exceeded its roll-id bound',
    );
  });

  it.each([
    {
      label: 'duplicate',
      reasons: ['spool_price_unresolved', 'spool_price_unresolved'],
    },
    {
      label: 'non-canonical order',
      reasons: ['snapshot_pending', 'spool_price_unresolved'],
    },
  ])('rejects $label unresolved reasons in persisted snapshots', async ({ reasons }) => {
    const context = fixture({
      latest: [
        snapshot({
          status: 'partial',
          spoolAmountKopecks: null,
          totalAmountKopecks: null,
          totalKopecksPerKg: null,
          unresolvedReasons: reasons,
        }),
      ],
    });

    await expect(context.service.getViewsForRollIds(['roll-1'], NOW)).rejects.toThrow(
      'snapshot unresolved reasons must be unique and canonically ordered',
    );
  });

  it('returns live planned and explicit actual pending views without persistence', async () => {
    const actualPending = prepared({ eligibility: eligibility({ dispatchCompletedAt: null }) });
    const plannedOnly = prepared({
      rollDispatchItemId: 'roll-2',
      eligibility: null,
      actualInput: null,
      pendingInput: null,
      sourceSnapshot: null,
    });
    const context = fixture({ prepared: [actualPending, plannedOnly] });

    const result = await context.service.getViewsForRollIds(['roll-1', 'roll-2'], NOW);
    expect(result.get('roll-1')).toMatchObject({
      kind: 'actual_pending',
      status: 'pending',
      unresolvedReasons: ['dispatch_not_completed'],
    });
    expect(result.get('roll-2')).toMatchObject({ kind: 'planned_preview' });
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('serves provisional components without weakening the strict actual snapshot input', async () => {
    const strictInput = calculation({
      materialBasis: { kind: 'unresolved', reason: 'material_usage_unresolved' },
      payroll: null,
    });
    const actualPending = {
      ...prepared({
        eligibility: eligibility({
          dispatchStatus: 'ready_for_warehouse',
          dispatchCompletedAt: null,
          rootPostSessionStatus: 'active',
          rootPostSessionEndedAt: null,
          machineAssignmentId: null,
          machineAssignmentStatus: null,
          shiftStatus: 'open',
          shiftEndedAt: null,
        }),
        actualInput: strictInput,
      }),
      pendingInput: calculation(),
    } satisfies PreparedRollProductionCost;
    const context = fixture({ prepared: [actualPending] });

    const result = await context.service.getViewsForRollIds(['roll-1'], NOW);

    expect(result.get('roll-1')).toMatchObject({
      kind: 'actual_pending',
      materialAmountKopecks: 20_000,
      spoolAmountKopecks: 9_000,
      payrollAmountKopecks: 4_000,
      additionalAmountKopecks: 0,
      unresolvedReasons: [
        'dispatch_not_completed',
        'post_session_not_closed',
        'machine_assignment_not_completed',
        'shift_not_closed',
      ],
    });
    expect(calculateRollProductionCost(actualPending.actualInput!)).toMatchObject({
      status: 'partial',
      unresolvedReasons: ['material_usage_unresolved', 'payroll_unresolved'],
    });
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('never reassembles or supersedes an existing complete snapshot', async () => {
    const context = fixture({ latest: [snapshot()] });
    await expect(context.service.reconcileRollIds(['roll-1'], NOW)).resolves.toMatchObject({
      created: 0,
      skippedComplete: 1,
    });
    expect(context.assembler.prepare).not.toHaveBeenCalled();
    expect(context.create).not.toHaveBeenCalled();
  });

  it('appends one exact snapshot and one system audit fact in the same transaction', async () => {
    const context = fixture();
    const result = await context.service.reconcileRollIds(['roll-1'], NOW);

    expect(result).toMatchObject({ created: 1, skippedComplete: 0 });
    expect(context.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rollDispatchItemId: 'roll-1',
        version: 1,
        status: 'complete',
        materialAmountKopecks: 20_000n,
        spoolAmountKopecks: 9_000n,
        payrollAmountKopecks: 4_000n,
        totalAmountKopecks: 33_000n,
        systemActorKey: 'production_cost_reconciler',
        actorId: null,
      }),
    });
    expect(context.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_production_cost_snapshotted',
        actor: { kind: 'system', systemActorKey: 'production_cost_reconciler' },
      }),
      expect.anything(),
    );
  });

  it('does not append an unchanged partial fingerprint but appends a changed v2', async () => {
    const probe = fixture();
    const fingerprint = probe.service.fingerprintPreparedForTest(prepared());
    const unchanged = fixture({
      latest: [
        snapshot({
          status: 'partial',
          calculationFingerprint: fingerprint,
          spoolAmountKopecks: null,
          totalAmountKopecks: null,
          totalKopecksPerKg: null,
          unresolvedReasons: ['spool_price_unresolved'],
        }),
      ],
    });
    await unchanged.service.reconcileRollIds(['roll-1'], NOW);
    expect(unchanged.create).not.toHaveBeenCalled();

    const changed = fixture({
      latest: [
        snapshot({
          status: 'partial',
          calculationFingerprint: 'c'.repeat(64),
          spoolAmountKopecks: null,
          totalAmountKopecks: null,
          totalKopecksPerKg: null,
          unresolvedReasons: ['spool_price_unresolved'],
        }),
      ],
    });
    await changed.service.reconcileRollIds(['roll-1'], NOW);
    expect(changed.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 2,
        supersedesSnapshotId: 'snapshot-1',
      }),
    });
  });

  it('keeps ineligible close/intake orderings pending until both facts become eligible', async () => {
    const first = fixture({
      prepared: [prepared({ eligibility: eligibility({ dispatchCompletedAt: null }) })],
    });
    await first.service.reconcileRollIds(['roll-1'], NOW);
    expect(first.create).not.toHaveBeenCalled();

    first.assembler.prepare.mockResolvedValueOnce(new Map([['roll-1', prepared()]]));
    await first.service.reconcileRollIds(['roll-1'], NOW);
    expect(first.create).toHaveBeenCalledTimes(1);

    const reverse = fixture({
      prepared: [prepared({ eligibility: eligibility({ shiftEndedAt: null }) })],
    });
    await reverse.service.reconcileRollIds(['roll-1'], NOW);
    expect(reverse.create).not.toHaveBeenCalled();
    reverse.assembler.prepare.mockResolvedValueOnce(new Map([['roll-1', prepared()]]));
    await reverse.service.reconcileRollIds(['roll-1'], NOW);
    expect(reverse.create).toHaveBeenCalledTimes(1);
  });

  it('excludes complete rows and rotates past unchanged partials with a bounded keyset wrap', async () => {
    const rollOne = preparedForRoll('roll-1');
    const rollTwo = preparedForRoll('roll-2');
    const context = fixture({ prepared: [rollOne, rollTwo] });
    const unchangedFingerprint = context.service.fingerprintPreparedForTest(rollOne);
    const snapshotsByRoll = new Map([
      [
        'roll-0-complete',
        snapshot({
          id: 'snapshot-complete',
          rollDispatchItemId: 'roll-0-complete',
        }),
      ],
      [
        'roll-1',
        snapshot({
          status: 'partial',
          calculationFingerprint: unchangedFingerprint,
          spoolAmountKopecks: null,
          totalAmountKopecks: null,
          totalKopecksPerKg: null,
          unresolvedReasons: ['spool_price_unresolved'],
        }),
      ],
    ]);
    context.latestQuery.mockImplementation(async (query: { values: unknown[] }) =>
      query.values.flatMap((id) => {
        if (typeof id !== 'string') return [];
        const row = snapshotsByRoll.get(id);
        return row ? [row] : [];
      }),
    );
    const candidates = [
      { id: 'roll-0-complete', complete: true },
      { id: 'roll-1', complete: false },
      { id: 'roll-2', complete: false },
    ];
    context.prisma.rollDispatchItem.findMany.mockImplementation(
      async (query: {
        where: {
          id?: { gt?: string; lte?: string };
          productionCostSnapshots?: { none?: { status?: string } };
        };
        take: number;
      }) => {
        let rows = candidates;
        if (query.where.productionCostSnapshots?.none?.status === 'complete') {
          rows = rows.filter(({ complete }) => !complete);
        }
        if (query.where.id?.gt) rows = rows.filter(({ id }) => id > query.where.id!.gt!);
        if (query.where.id?.lte) rows = rows.filter(({ id }) => id <= query.where.id!.lte!);
        return rows.slice(0, query.take).map(({ id }) => ({ id }));
      },
    );

    await expect(context.service.reconcileNextBatch(1, NOW)).resolves.toMatchObject({
      unchanged: 1,
    });
    await expect(context.service.reconcileNextBatch(1, NOW)).resolves.toMatchObject({ created: 1 });
    await expect(context.service.reconcileNextBatch(1, NOW)).resolves.toMatchObject({
      unchanged: 1,
    });

    expect(context.assembler.prepare.mock.calls.map(([ids]) => ids)).toEqual([
      ['roll-1'],
      ['roll-2'],
      ['roll-1'],
    ]);
    expect(context.prisma.rollDispatchItem.findMany.mock.calls.map(([query]) => query)).toEqual([
      expect.objectContaining({
        where: {
          status: 'done',
          completedAt: { not: null },
          productionCostSnapshots: { none: { status: 'complete' } },
        },
        orderBy: { id: 'asc' },
        take: 1,
      }),
      expect.objectContaining({
        where: expect.objectContaining({ id: { gt: 'roll-1' } }),
        orderBy: { id: 'asc' },
        take: 1,
      }),
      expect.objectContaining({
        where: expect.objectContaining({ id: { gt: 'roll-2' } }),
        orderBy: { id: 'asc' },
        take: 1,
      }),
      expect.objectContaining({
        where: expect.objectContaining({ id: { lte: 'roll-2' } }),
        orderBy: { id: 'asc' },
        take: 1,
      }),
    ]);
  });

  it('runs a configurable batch only on demand and coalesces concurrent reconciliation', async () => {
    jest.useFakeTimers();
    try {
      const context = fixture();
      let release!: () => void;
      const discovery = new Promise<{ id: string }[]>((resolve) => {
        release = () => resolve([]);
      });
      context.prisma.rollDispatchItem.findMany.mockImplementation(() => discovery);
      const reconciler = new RollProductionCostSnapshotReconciler(context.service, 37);

      await jest.advanceTimersByTimeAsync(86_400_000);
      expect(context.prisma.rollDispatchItem.findMany).not.toHaveBeenCalled();

      const first = reconciler.reconcileNow(NOW);
      const second = reconciler.reconcileNow(new Date('2026-08-05T00:00:00Z'));
      expect(second).toBe(first);
      expect(context.prisma.rollDispatchItem.findMany).toHaveBeenCalledTimes(1);
      expect(context.prisma.rollDispatchItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 37 }),
      );

      release();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      await reconciler.reconcileNow(NOW);
      expect(context.prisma.rollDispatchItem.findMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('appends a Finance correction version with optimistic history and one audit fact', async () => {
    const context = fixture({ latest: [snapshot()] });

    const result = await context.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW);

    expect(result).toMatchObject({
      kind: 'actual_snapshot',
      snapshotId: 'created-snapshot',
      version: 2,
      status: 'complete',
    });
    expect(context.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(context.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rollDispatchItemId: 'roll-1',
        version: 2,
        supersedesSnapshotId: 'snapshot-1',
        operationKey: CORRECTION.operationKey,
        actorId: 'finance-user-1',
        actorRole: 'finance',
        systemActorKey: null,
        correctionReason: CORRECTION.reason,
      }),
    });
    expect(context.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_production_cost_corrected',
        actorRole: 'finance',
        actorId: 'finance-user-1',
        oldValue: expect.objectContaining({ snapshotId: 'snapshot-1', version: 1 }),
        newValue: expect.objectContaining({ snapshotId: 'created-snapshot', version: 2 }),
      }),
      context.tx,
    );
  });

  it('replays an exact correction and conflicts on changed operation reuse', async () => {
    const context = fixture({ latest: [snapshot()] });
    const first = await context.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW);
    const created = await context.create.mock.results[0].value;
    context.findUnique.mockResolvedValue(created);

    await expect(
      context.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW),
    ).resolves.toEqual(first);
    await expect(
      context.service.correct(
        FINANCE_ACTOR,
        'roll-1',
        { ...CORRECTION, reason: 'Другая причина' },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(context.create).toHaveBeenCalledTimes(1);
    expect(context.audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale expected version before appending a correction', async () => {
    const context = fixture({ latest: [snapshot({ version: 2 })] });

    await expect(
      context.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(context.create).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('replays the concurrent correction winner observed only after the history lock', async () => {
    const context = fixture({ latest: [snapshot()] });
    const probe = fixture({ latest: [snapshot()] });
    const expected = await probe.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW);
    const winner = await probe.create.mock.results[0].value;
    context.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);

    await expect(
      context.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW),
    ).resolves.toEqual(expected);
    expect(context.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(context.create).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('returns the concurrent correction winner after P2002 without a duplicate event', async () => {
    const context = fixture({ latest: [snapshot()] });
    context.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique conflict', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const probe = fixture({ latest: [snapshot()] });
    const expected = await probe.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW);
    const winner = await probe.create.mock.results[0].value;
    context.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);

    await expect(
      context.service.correct(FINANCE_ACTOR, 'roll-1', CORRECTION, NOW),
    ).resolves.toEqual(expected);
    expect(context.create).toHaveBeenCalledTimes(1);
    expect(context.audit.record).not.toHaveBeenCalled();
  });
});
