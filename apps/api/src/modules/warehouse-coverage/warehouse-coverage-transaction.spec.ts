import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  COVERAGE_LOCK_HIERARCHY,
  COVERAGE_LOCKS_HELD,
  coverageCommandAdvisoryKey,
  lockCoverageCommandAdvisory,
  lockCoverageInventoryEpoch,
  lockCoverageResources,
  runCoverageSerializable,
} from './warehouse-coverage-transaction';

function databaseError(
  code: string,
  metaCode?: string,
): Error & {
  code: string;
  meta?: { code: string };
} {
  return Object.assign(new Error(code), {
    code,
    ...(metaCode ? { meta: { code: metaCode } } : {}),
  });
}

function rawDatabaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function transactionPrisma() {
  return {
    $transaction: jest.fn((operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      operation({} as Prisma.TransactionClient),
    ),
  } as unknown as PrismaService;
}

function fakeRetryRuntime() {
  return {
    sleep: jest.fn().mockResolvedValue(undefined),
    random: jest.fn().mockReturnValue(0),
  };
}

describe('warehouse coverage serializable transaction', () => {
  it.each([
    ['Prisma P2034', databaseError('P2034')],
    ['Prisma P2010/40001', databaseError('P2010', '40001')],
    ['Prisma P2010/40P01', databaseError('P2010', '40P01')],
    ['raw 40001', rawDatabaseError('40001')],
    ['raw 40P01', rawDatabaseError('40P01')],
  ])('retries %s at most three attempts', async (_label, error) => {
    const prisma = transactionPrisma();
    const operation = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');

    await expect(runCoverageSerializable(prisma, operation, fakeRetryRuntime())).resolves.toBe(
      'ok',
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('injects bounded equal jitter and reports only the terminal retry conflict', async () => {
    const prisma = transactionPrisma();
    const sleep = jest.fn().mockResolvedValue(undefined);
    const random = jest.fn().mockReturnValue(0.5);
    const terminalHook = { increment: jest.fn() };
    const operation = jest.fn().mockRejectedValue(databaseError('P2010', '40001'));

    await expect(
      runCoverageSerializable(prisma, operation, { sleep, random }, terminalHook),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_concurrent_state_conflict',
      }),
    });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[7], [15]]);
    expect(terminalHook.increment).toHaveBeenCalledTimes(1);
    expect(terminalHook.increment).toHaveBeenCalledWith('40001');
  });

  it('does not count retried success and counts one terminal coverage-domain conflict', async () => {
    const prisma = transactionPrisma();
    const terminalHook = { increment: jest.fn() };
    const operation = jest
      .fn()
      .mockRejectedValueOnce(databaseError('P2034'))
      .mockResolvedValue('ok');

    await expect(
      runCoverageSerializable(prisma, operation, fakeRetryRuntime(), terminalHook),
    ).resolves.toBe('ok');
    expect(terminalHook.increment).not.toHaveBeenCalled();

    await expect(
      runCoverageSerializable(
        prisma,
        jest.fn().mockRejectedValue(
          new ConflictException({
            code: 'warehouse_coverage_state_conflict',
            message: 'state changed',
          }),
        ),
        fakeRetryRuntime(),
        terminalHook,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(terminalHook.increment).toHaveBeenCalledTimes(1);
    expect(terminalHook.increment).toHaveBeenCalledWith('coverage_conflict');
  });

  it('does not retry or count an unrelated application conflict', async () => {
    const prisma = transactionPrisma();
    const terminalHook = { increment: jest.fn() };
    const operation = jest
      .fn()
      .mockRejectedValue(new ConflictException({ code: 'UNRELATED_CONFLICT' }));

    await expect(
      runCoverageSerializable(prisma, operation, fakeRetryRuntime(), terminalHook),
    ).rejects.toMatchObject({ status: 409 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(terminalHook.increment).not.toHaveBeenCalled();
  });
});

type LockQuery = { sql: string; values: unknown[] };

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function primaryLockTable(sql: string): string | null {
  return (
    [
      'warehouse_coverage_inventory_epochs',
      'warehouse_coverage_states',
      'commercial_orders',
      'warehouse_coverage_calculations',
      'warehouse_coverage_decisions',
      'production_orders',
      'order_resolution_cases',
      'warehouse_acceptance_tasks',
      'scan_rows',
      'warehouse_rolls',
    ].find((table) => sql.includes(`FROM "${table}"`)) ?? null
  );
}

function lockTransaction(
  missingTable?: string,
  rejectQuery?: (query: LockQuery, primaryTable: string | null) => boolean,
) {
  const observed: string[] = [];
  const queries: LockQuery[] = [];
  let advisoryIndex = 0;
  const tx = {
    $executeRaw: jest.fn((query: { sql: string }) => {
      if (query.sql.includes('pg_advisory_xact_lock')) {
        observed.push(
          ['command', 'business:delivery:a', 'business:delivery:z'][advisoryIndex] ??
            'unexpected-advisory',
        );
        advisoryIndex += 1;
      }
      return Promise.resolve(1);
    }),
    $queryRaw: jest.fn((query: LockQuery) => {
      const sql = query.sql;
      queries.push(query);
      const primaryTable = primaryLockTable(sql);
      if ((missingTable && primaryTable === missingTable) || rejectQuery?.(query, primaryTable)) {
        return Promise.resolve([]);
      }
      if (primaryTable === 'warehouse_coverage_inventory_epochs') observed.push('inventory_epoch');
      else if (primaryTable === 'warehouse_coverage_states') observed.push('coverage_state');
      else if (primaryTable === 'commercial_orders') observed.push('commercial_order');
      else if (primaryTable === 'warehouse_coverage_calculations') {
        observed.push('current_calculation');
      } else if (primaryTable === 'warehouse_coverage_decisions') {
        observed.push('current_decision');
      } else if (primaryTable === 'production_orders') observed.push('production_order');
      else if (primaryTable === 'order_resolution_cases') observed.push('recheck_case');
      else if (primaryTable === 'warehouse_acceptance_tasks') observed.push('warehouse_task');
      else if (primaryTable === 'scan_rows') observed.push('scan_row');
      else if (primaryTable === 'warehouse_rolls') observed.push('warehouse_rolls_binary');
      if (primaryTable === 'warehouse_rolls') {
        return Promise.resolve(query.values.map((id) => ({ id })));
      }
      return Promise.resolve([{ id: query.values[0] }]);
    }),
  } as unknown as Prisma.TransactionClient;
  return { tx, observed, queries };
}

describe('warehouse coverage lock hierarchy', () => {
  it('derives one namespaced 64-bit advisory key for every command acquisition path', async () => {
    const keys: bigint[] = [];
    const tx = {
      $executeRaw: jest.fn((query: { values: unknown[] }) => {
        keys.push(query.values[0] as bigint);
        return Promise.resolve(1);
      }),
    } as unknown as Prisma.TransactionClient;
    const id = '123e4567-e89b-12d3-a456-426614174000';

    await lockCoverageCommandAdvisory(tx, id);
    await lockCoverageCommandAdvisory(tx, id);

    expect(keys).toEqual([coverageCommandAdvisoryKey(id)]);
    expect(BigInt.asIntN(64, keys[0])).toBe(keys[0]);
  });

  it('publishes and acquires the one hierarchy with binary-sorted rolls', async () => {
    const { tx, observed } = lockTransaction();
    const held = await lockCoverageResources(tx, {
      clientRequestId: '123e4567-e89b-12d3-a456-426614174000',
      businessAdvisoryScopes: ['delivery:z', 'delivery:a'],
      orderId: 'order-1',
      calculationId: 'calculation-1',
      decisionId: 'decision-1',
      productionOrderId: 'production-1',
      caseId: 'case-1',
      taskId: 'task-1',
      scanRowId: 'scan-1',
      rollIds: ['roll-z', 'roll-A', 'roll-a'],
    });

    expect(observed).toEqual([
      'command',
      'business:delivery:a',
      'business:delivery:z',
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'current_decision',
      'production_order',
      'recheck_case',
      'warehouse_task',
      'scan_row',
      'warehouse_rolls_binary',
    ]);
    expect(COVERAGE_LOCK_HIERARCHY).toHaveLength(12);
    expect(held).toMatchObject({
      orderId: 'order-1',
      acquiredLevels: COVERAGE_LOCK_HIERARCHY,
      rollIds: ['roll-A', 'roll-a', 'roll-z'],
    });
    expect(held[COVERAGE_LOCKS_HELD]).toBe(true);
  });

  it('resolves candidate rolls only after the epoch and requested core rows are locked', async () => {
    const { tx, observed } = lockTransaction();
    const resolveRollIdsAfterCoreLocks = jest.fn(async () => {
      expect(observed).toEqual([
        'inventory_epoch',
        'coverage_state',
        'commercial_order',
        'current_calculation',
        'current_decision',
      ]);
      return ['roll-z', 'roll-a'];
    });

    const held = await lockCoverageResources(tx, {
      orderId: 'order-1',
      calculationId: 'calculation-1',
      decisionId: 'decision-1',
      resolveRollIdsAfterCoreLocks,
    });

    expect(resolveRollIdsAfterCoreLocks).toHaveBeenCalledTimes(1);
    expect(held.rollIds).toEqual(['roll-a', 'roll-z']);
    await expect(
      lockCoverageResources(tx, {
        orderId: 'order-1',
        rollIds: ['roll-a'],
        resolveRollIdsAfterCoreLocks,
      }),
    ).rejects.toThrow('choose static or lazy roll IDs');
  });

  it('offers the shared epoch-only fence to legacy inventory writers', async () => {
    const { tx, observed } = lockTransaction();
    await lockCoverageInventoryEpoch(tx);
    expect(observed).toEqual(['inventory_epoch']);
  });

  it('casts the decision lock parameter before comparing it with the UUID primary key', async () => {
    const { tx, queries } = lockTransaction();

    await lockCoverageResources(tx, {
      orderId: 'order-1',
      decisionId: '123e4567-e89b-12d3-a456-426614174000',
    });

    const decisionLock = queries.find(
      (query) => primaryLockTable(query.sql) === 'warehouse_coverage_decisions',
    );
    expect(decisionLock).toBeDefined();
    expect(normalizeSql((decisionLock as LockQuery).sql)).toContain(
      'decision."id" = CAST(? AS UUID)',
    );
  });

  it('keeps the decision target type-safe in every downstream UUID predicate', async () => {
    const { tx, queries } = lockTransaction();

    await lockCoverageResources(tx, {
      orderId: 'order-1',
      decisionId: '123e4567-e89b-12d3-a456-426614174000',
      productionOrderId: 'production-1',
      caseId: 'case-1',
      taskId: 'task-1',
      scanRowId: 'scan-1',
    });

    const expectedPredicates = new Map([
      [
        'production_orders',
        'production_order."sourceCoverageDecisionId" = CAST(? AS UUID)',
      ],
      ['order_resolution_cases', 'coverage_case."sourceCoverageDecisionId" = CAST(? AS UUID)'],
      ['warehouse_acceptance_tasks', 'decision."id" = CAST(? AS UUID)'],
      ['scan_rows', 'decision."id" = CAST(? AS UUID)'],
    ]);
    for (const [table, predicate] of expectedPredicates) {
      const query = queries.find((candidate) => primaryLockTable(candidate.sql) === table);
      expect(query).toBeDefined();
      expect(normalizeSql((query as LockQuery).sql)).toContain(predicate);
    }
  });

  it('never issues a branded proof when a requested row or roll disappeared', async () => {
    const missingOrder = lockTransaction('commercial_orders');
    await expect(
      lockCoverageResources(missingOrder.tx, { orderId: 'missing-order' }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_lock_target_missing',
      }),
    });

    const missingRoll = lockTransaction('warehouse_rolls');
    await expect(
      lockCoverageResources(missingRoll.tx, {
        orderId: 'order-1',
        rollIds: ['missing-roll'],
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_lock_target_missing',
      }),
    });
  });

  it.each([
    {
      label: 'cross-order calculation',
      targets: { orderId: 'order-1', calculationId: 'calculation-foreign' },
      table: 'warehouse_coverage_calculations',
      predicates: [
        'calculation."orderId" =',
        'coverage_state."currentCalculationId" = calculation."id"',
      ],
    },
    {
      label: 'stale current decision',
      targets: { orderId: 'order-1', decisionId: 'decision-stale' },
      table: 'warehouse_coverage_decisions',
      predicates: [
        'decision."orderId" =',
        'decision."calculationId" = calculation."id"',
        'coverage_state."currentCalculationId" = calculation."id"',
        'coverage_state."currentDecisionId" = decision."id"',
      ],
    },
    {
      label: 'production order with stale coverage parents',
      targets: { orderId: 'order-1', productionOrderId: 'production-stale' },
      table: 'production_orders',
      predicates: [
        'production_order."commercialOrderId" =',
        'production_order."sourceCoverageCalculationId" = coverage_state."currentCalculationId"',
        'production_order."sourceCoverageDecisionId" = coverage_state."currentDecisionId"',
      ],
    },
    {
      label: 'recheck case with a stale parent calculation',
      targets: { orderId: 'order-1', caseId: 'case-stale' },
      table: 'order_resolution_cases',
      predicates: [
        'coverage_case."orderId" =',
        'coverage_case."sourceCoverageCalculationId" = coverage_state."currentCalculationId"',
        'coverage_case."sourceCoverageDecisionId" IS NOT DISTINCT FROM coverage_state."currentDecisionId"',
      ],
    },
    {
      label: 'acceptance task from another decision chain',
      targets: { orderId: 'order-1', taskId: 'task-foreign' },
      table: 'warehouse_acceptance_tasks',
      predicates: [
        'acceptance_task."orderId" =',
        'acceptance_task."coverageDecisionId" = decision."id"',
        'coverage_state."currentCalculationId" = calculation."id"',
        'coverage_state."currentDecisionId" = decision."id"',
      ],
    },
    {
      label: 'scan row from a stale task parent',
      targets: { orderId: 'order-1', scanRowId: 'scan-stale' },
      table: 'scan_rows',
      predicates: [
        'scan_row."taskId" = acceptance_task."id"',
        'acceptance_task."orderId" =',
        'acceptance_task."coverageDecisionId" = decision."id"',
        'coverage_state."currentCalculationId" = calculation."id"',
        'coverage_state."currentDecisionId" = decision."id"',
      ],
    },
  ])('fails closed for $label instead of branding unrelated locks', async (scenario) => {
    const brokenRelation = lockTransaction(undefined, (query, primaryTable) => {
      if (primaryTable !== scenario.table) return false;
      const sql = normalizeSql(query.sql);
      return scenario.predicates.every((predicate) => sql.includes(predicate));
    });

    await expect(lockCoverageResources(brokenRelation.tx, scenario.targets)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_lock_target_missing',
      }),
    });
  });

  it('binds every optional lock to the locked order and exact current parent chain', async () => {
    const { tx, queries } = lockTransaction();
    await lockCoverageResources(tx, {
      orderId: 'order-1',
      calculationId: 'calculation-1',
      decisionId: 'decision-1',
      productionOrderId: 'production-1',
      caseId: 'case-1',
      taskId: 'task-1',
      scanRowId: 'scan-1',
    });

    const queryFor = (table: string) => {
      const query = queries.find((candidate) => primaryLockTable(candidate.sql) === table);
      expect(query).toBeDefined();
      return query as LockQuery;
    };

    expect(queryFor('warehouse_coverage_calculations').values).toEqual(
      expect.arrayContaining(['calculation-1', 'order-1']),
    );
    expect(queryFor('warehouse_coverage_decisions').values).toEqual(
      expect.arrayContaining(['decision-1', 'calculation-1', 'order-1']),
    );
    expect(queryFor('production_orders').values).toEqual(
      expect.arrayContaining(['production-1', 'calculation-1', 'decision-1', 'order-1']),
    );
    expect(queryFor('order_resolution_cases').values).toEqual(
      expect.arrayContaining(['case-1', 'calculation-1', 'decision-1', 'order-1']),
    );
    expect(queryFor('warehouse_acceptance_tasks').values).toEqual(
      expect.arrayContaining(['task-1', 'calculation-1', 'decision-1', 'order-1']),
    );
    expect(queryFor('scan_rows').values).toEqual(
      expect.arrayContaining(['scan-1', 'task-1', 'calculation-1', 'decision-1', 'order-1']),
    );
  });
});
