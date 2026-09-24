/* eslint-disable @typescript-eslint/no-explicit-any */
import { ValidationPipe } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import { projectDomainEvent, type DomainEventRecord } from '../../common/audit/audit-projection';
import { CoveragePhysicalExceptionDto } from '../warehouse/dto/coverage-physical-exception.dto';
import { WarehouseCoverageReservationRecoveryService } from './warehouse-coverage-reservation-recovery.service';

const CLIENT_REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const TASK_UPDATED_AT = '2026-07-24T12:00:00.000Z';
const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  capabilities: ['warehouse_task:read', 'warehouse_coverage:report_physical_exception'],
};

function sqlText(query: { strings?: readonly string[] }): string {
  return (query.strings ?? []).join(' ');
}

function setup(options: { releasedCount?: number; companyStockRollIds?: readonly string[] } = {}) {
  const companyStockRollIds = new Set(options.companyStockRollIds ?? []);
  const matches = [
    { rollId: 'roll-a', coverageFactId: 'fact-a', positionId: 'position-a' },
    { rollId: 'roll-b', coverageFactId: 'fact-b', positionId: 'position-b' },
  ];
  const rolls: any[] = matches.map((match, index) => ({
    id: match.rollId,
    rollCode: `ROLL-${index + 1}`,
    producedForStockOrderId: companyStockRollIds.has(match.rollId) ? 'stock-order-1' : null,
    producedForStockOrder: companyStockRollIds.has(match.rollId)
      ? { requestType: 'stock_reserve' }
      : null,
    currentCoverageFactId: match.coverageFactId,
    reservedForOrderId: 'order-1',
    reservedForPositionId: null,
    reservedByProposalId: null,
    reservedByCoverageDecisionId: 'decision-1',
    reservedAt: new Date('2026-07-24T11:00:00.000Z'),
  }));
  const calculation = {
    id: 'calculation-1',
    orderId: 'order-1',
    generation: 4,
    orderVersion: 1,
    positionVersions: [],
    orderFingerprint: 'a'.repeat(64),
    inventoryEpoch: 7n,
    inventoryFingerprint: 'b'.repeat(64),
    inputFingerprint: 'c'.repeat(64),
    algorithmVersion: 'v1',
    policyVersion: 'warehouse-coverage-policy/v2',
    availability: 'verified_full',
    reasonCodes: ['full_cover_available'],
    requiredRollCount: 2,
    matchedRollCount: 2,
    uncertainRollCount: 0,
    verifiedCandidateRollIds: ['roll-a', 'roll-b'],
    uncertainCandidateRollIds: [],
    systemActorKey: 'warehouse_coverage_engine',
    calculatedAt: new Date('2026-07-24T11:30:00.000Z'),
  };
  const decision = {
    id: 'decision-1',
    orderId: 'order-1',
    calculationId: calculation.id,
    generation: 4,
    kind: 'use_warehouse',
    inputFingerprint: calculation.inputFingerprint,
    sourceInventoryEpoch: 7n,
    committedInventoryEpoch: 7n,
    expectedRollCount: 2,
    actorKind: 'user',
    actorRole: 'finance',
    actorId: 'finance-user',
    systemActorKey: null,
    createdAt: new Date('2026-07-24T11:40:00.000Z'),
  };
  const state: any = {
    orderId: 'order-1',
    state: 'warehouse_reserved',
    stateVersion: 6,
    generation: 4,
    currentCalculationId: calculation.id,
    currentDecisionId: decision.id,
    createdAt: new Date('2026-07-24T11:30:00.000Z'),
    updatedAt: new Date('2026-07-24T11:40:00.000Z'),
    order: {
      warehouseCoverageWorkflowVersion: 2,
      productionOrder: null,
    },
    currentCalculation: calculation,
    currentDecision: decision,
  };
  const task = {
    id: 'task-1',
    mode: 'reserve',
    status: 'open',
    orderId: 'order-1',
    positionId: null,
    proposalId: null,
    coverageDecisionId: decision.id,
    updatedAt: new Date(TASK_UPDATED_AT),
  };
  const scanRow = {
    id: 'scan-row-a',
    taskId: task.id,
    rollCode: 'ROLL-1',
  };
  const resolutionCase = {
    id: 'case-1',
    openScopeKey: 'warehouse_coverage_v2:order-1:decision_linked_physical_exception',
    orderId: 'order-1',
    type: 'warehouse_coverage_physical_exception',
    status: 'open',
    ownerRole: 'warehouse',
    coverageScope: 'warehouse_coverage_v2:order-1',
    coverageOrigin: 'decision_linked_physical_exception',
    sourceCoverageCalculationId: calculation.id,
    sourceCoverageDecisionId: decision.id,
    sourceCoverageStateVersion: 6,
  };
  const memberships: any[] = [];
  const lockTrace: string[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async () => {
      lockTrace.push('command_advisory_key');
      return 1;
    }),
    $queryRaw: jest.fn(async (query: { strings?: readonly string[] }) => {
      const sql = sqlText(query);
      if (sql.includes('warehouse_coverage_inventory_epochs')) {
        lockTrace.push('inventory_epoch');
        return [{ id: 1 }];
      }
      if (sql.includes('warehouse_coverage_states') && !sql.includes('JOIN')) {
        lockTrace.push('coverage_state');
        return [{ orderId: 'order-1' }];
      }
      if (sql.includes('commercial_orders')) {
        lockTrace.push('commercial_order');
        return [{ id: 'order-1' }];
      }
      if (sql.includes('warehouse_coverage_calculations') && !sql.includes('decisions')) {
        lockTrace.push('current_calculation');
        return [{ id: calculation.id }];
      }
      if (sql.includes('warehouse_coverage_decisions')) {
        lockTrace.push('current_decision');
        return [{ id: decision.id }];
      }
      if (sql.includes('order_resolution_cases')) {
        lockTrace.push('recheck_case');
        return [{ id: resolutionCase.id }];
      }
      if (sql.includes('warehouse_acceptance_tasks')) {
        lockTrace.push('warehouse_task');
        return [{ id: task.id }];
      }
      if (sql.includes('scan_rows')) {
        lockTrace.push('scan_row');
        return [{ id: scanRow.id }];
      }
      if (sql.includes('warehouse_coverage_matches')) return matches;
      if (sql.includes('warehouse_rolls')) {
        lockTrace.push('warehouse_rolls_binary');
        return matches.map(({ rollId }) => ({ id: rollId }));
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    warehouseAcceptanceTask: {
      findUnique: jest.fn(async ({ select }: any) => {
        if (select?.rows) {
          return {
            id: task.id,
            status: task.status,
            updatedAt: task.updatedAt,
            coverageDecisionId: decision.id,
            rows: [
              { id: scanRow.id, rollCode: scanRow.rollCode, scanStatus: 'expected' },
              { id: 'scan-row-b', rollCode: 'ROLL-2', scanStatus: 'expected' },
            ],
            coverageDecision: {
              ...decision,
              order: {
                warehouseCoverageWorkflowVersion: 2,
                coverageState: {
                  generation: state.generation,
                  stateVersion: state.stateVersion,
                  currentCalculationId: calculation.id,
                  currentDecisionId: decision.id,
                },
              },
            },
          };
        }
        if (select?.mode) return { ...task };
        return {
          id: task.id,
          orderId: task.orderId,
          coverageDecisionId: decision.id,
          coverageDecision: {
            id: decision.id,
            orderId: decision.orderId,
            calculationId: calculation.id,
          },
        };
      }),
      updateMany: jest.fn(async () => {
        task.status = 'exception';
        task.updatedAt = new Date('2026-07-24T12:01:00.000Z');
        return { count: 1 };
      }),
    },
    warehouseCoverageState: {
      findUnique: jest.fn().mockResolvedValue(state),
      updateMany: jest.fn(async () => {
        state.state = 'recheck_requested';
        state.currentDecisionId = null;
        return { count: 1 };
      }),
    },
    scanRow: {
      findUnique: jest.fn().mockResolvedValue(scanRow),
    },
    orderResolutionCase: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(resolutionCase),
    },
    warehouseRoll: {
      findMany: jest.fn().mockResolvedValue(rolls),
      updateMany: jest.fn(async () => {
        if (options.releasedCount !== undefined) {
          return { count: options.releasedCount };
        }
        for (const roll of rolls) {
          roll.reservedForOrderId = null;
          roll.reservedForPositionId = null;
          roll.reservedByCoverageDecisionId = null;
          roll.reservedAt = null;
        }
        return { count: rolls.length };
      }),
    },
    warehouseCoverageRecheckMembership: {
      createMany: jest.fn(async ({ data }: { data: any[] }) => {
        memberships.push(...data);
        return { count: data.length };
      }),
      findMany: jest.fn().mockImplementation(async () => memberships),
    },
  };
  const prisma: any = {
    warehouseAcceptanceTask: tx.warehouseAcceptanceTask,
    $transaction: jest.fn(async (work: (client: any) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const coverageTransaction = {
    run: jest.fn(async (work: (client: any) => unknown) => work(tx)),
  };
  const commands = {
    acquireRecoveryOrReplay: jest.fn().mockResolvedValue({ kind: 'new', commandId: 'command-1' }),
    appendFinal: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WarehouseCoverageReservationRecoveryService(
    prisma,
    audit as never,
    coverageTransaction as never,
    commands as never,
  );
  return {
    service,
    prisma,
    tx,
    audit,
    commands,
    state,
    decision,
    task,
    rolls,
    matches,
    memberships,
    lockTrace,
    resolutionCase,
  };
}

function dto(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    expectedGeneration: 4,
    expectedStateVersion: 6,
    expectedTaskUpdatedAt: TASK_UPDATED_AT,
    scanRowId: 'scan-row-a',
    kind: 'damaged' as const,
    reason: 'Повреждение подтверждено складом',
    ...overrides,
  };
}

describe('WarehouseCoverageReservationRecoveryService', () => {
  it('cancels the complete decision set and opens one exact physical case', async () => {
    const {
      service,
      rolls,
      task,
      state,
      decision,
      memberships,
      lockTrace,
      commands,
      audit,
      resolutionCase,
      tx,
    } = setup();

    const result = await service.reportPhysicalException(ACTOR, task.id, dto());

    expect(result).toMatchObject({
      state: 'recheck_requested',
      stateVersion: 7,
      generation: 4,
      availability: 'unknown',
      availableActions: [],
      caseId: resolutionCase.id,
    });
    expect(rolls.every((roll) => roll.reservedByCoverageDecisionId === null)).toBe(true);
    expect(task.status).toBe('exception');
    expect(state.currentDecisionId).toBeNull();
    expect(decision.kind).toBe('use_warehouse');
    expect(memberships.map(({ rollId }) => rollId)).toEqual(['roll-a', 'roll-b']);
    expect(lockTrace).toEqual([
      'command_advisory_key',
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'current_decision',
      'recheck_case',
      'warehouse_task',
      'scan_row',
      'warehouse_rolls_binary',
    ]);
    expect(commands.acquireRecoveryOrReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'cancel_reservation',
        scopeTaskId: task.id,
        actor: {
          kind: 'system',
          systemActorKey: 'warehouse_coverage_engine',
        },
      }),
    );
    expect(commands.appendFinal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resultReference: { kind: 'recheck_case', caseId: resolutionCase.id },
      }),
    );
    const auditPayload = JSON.stringify(audit.record.mock.calls);
    expect(auditPayload).not.toContain('ROLL-1');
    expect(auditPayload).not.toContain('roll-a');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_reservation_cancelled',
        detail: expect.objectContaining({
          workflowVersion: 2,
          generation: 4,
          releasedRollCount: 2,
        }),
      }),
      expect.anything(),
    );
    const cancelled = audit.record.mock.calls.find(
      ([input]: any[]) => input.type === 'audit:warehouse_coverage_reservation_cancelled',
    )?.[0];
    if (!cancelled) throw new Error('Reservation cancellation audit event was not recorded');
    const persisted: DomainEventRecord = {
      id: 'event-reservation-cancelled',
      family: 'audit',
      type: cancelled.type,
      objectId: cancelled.objectId ?? null,
      actorKind: 'user',
      actorRole: 'warehouse',
      actorId: ACTOR.userId,
      systemActorKey: null,
      label: cancelled.label ?? null,
      detail: cancelled.detail,
      oldValue: cancelled.oldValue,
      newValue: cancelled.newValue,
      reason: cancelled.reason ?? null,
      sourceSnapshotId: cancelled.sourceSnapshotId ?? null,
      createdAt: new Date('2026-07-25T08:00:00.000Z'),
    };
    for (const audience of ['commercial', 'director'] as const) {
      expect(projectDomainEvent(persisted, audience).detail).toEqual({
        workflowVersion: 2,
        generation: 4,
        rollCount: 2,
      });
    }
    const lockSql: string[] = tx.$queryRaw.mock.calls.map((call: any[]) => sqlText(call[0]));
    expect(lockSql.find((sql) => sql.includes('FROM "order_resolution_cases"'))).toMatch(
      /"sourceCoverageDecisionId"\s*=\s*CAST\(/u,
    );
    expect(lockSql.find((sql) => sql.includes('FROM "warehouse_acceptance_tasks"'))).toMatch(
      /"coverageDecisionId"\s*=\s*CAST\(/u,
    );
  });

  it('fails before task/state mutation when the complete release count mismatches', async () => {
    const { service, task, state, commands } = setup({ releasedCount: 1 });

    await expect(service.reportPhysicalException(ACTOR, task.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'warehouse_coverage_reservation_set_conflict',
      }),
    });
    expect(task.status).toBe('open');
    expect(state.currentDecisionId).toBe('decision-1');
    expect(commands.appendFinal).not.toHaveBeenCalled();
  });

  it('records a safe append-only release event for every physically released stock roll', async () => {
    const { service, task, audit, tx } = setup({
      companyStockRollIds: ['roll-a'],
    });

    await service.reportPhysicalException(ACTOR, task.id, dto());

    const releaseCalls = audit.record.mock.calls.filter(
      ([input]: any[]) => input.type === 'audit:finished_stock_reservation_released',
    );
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toEqual([
      expect.objectContaining({
        type: 'audit:finished_stock_reservation_released',
        objectId: 'roll-a',
        actor: {
          kind: 'user',
          actorRole: ACTOR.role,
          actorId: ACTOR.userId,
        },
        reason: 'Повреждение подтверждено складом',
        detail: {
          orderId: 'order-1',
          sourceStockOrderId: 'stock-order-1',
          decisionId: 'decision-1',
          caseId: 'case-1',
          taskId: 'task-1',
          generation: 4,
        },
      }),
      tx,
    ]);
    const serialized = JSON.stringify(releaseCalls);
    expect(serialized).not.toContain('ROLL-1');
    expect(serialized).not.toContain('rawPayload');
  });

  it('returns the original stored result on exact replay without recovery locks', async () => {
    const { service, task, commands, lockTrace } = setup();
    const replay = {
      workflowVersion: 2 as const,
      state: 'recheck_requested' as const,
      stateVersion: 7,
      generation: 4,
      availability: 'unknown' as const,
      reasonCodes: ['warehouse_recheck_pending' as const],
      nextOwner: 'warehouse' as const,
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 2,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T11:30:00.000Z',
      stale: false,
      caseId: 'original-case',
    };
    commands.acquireRecoveryOrReplay.mockResolvedValue({
      kind: 'replay',
      resultReference: { kind: 'recheck_case', caseId: replay.caseId },
      safeResult: replay,
    });

    await expect(service.reportPhysicalException(ACTOR, task.id, dto())).resolves.toEqual(replay);
    expect(lockTrace).toEqual([]);
    expect(commands.appendFinal).not.toHaveBeenCalled();
  });

  it('exposes exact persisted generation/stateVersion only to warehouse readers', async () => {
    const { service, task } = setup();

    await expect(service.readDecisionTask(ACTOR, task.id)).resolves.toEqual({
      taskId: task.id,
      status: 'open',
      updatedAt: TASK_UPDATED_AT,
      generation: 4,
      stateVersion: 6,
      rows: [
        { scanRowId: 'scan-row-a', rollCode: 'ROLL-1', scanStatus: 'expected' },
        { scanRowId: 'scan-row-b', rollCode: 'ROLL-2', scanStatus: 'expected' },
      ],
    });
    await expect(
      service.readDecisionTask(
        {
          userId: 'finance-user',
          role: 'finance',
          capabilities: ['finance_order:read'],
        },
        task.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a divergent idempotency key replay without later locks', async () => {
    const { service, task, commands, lockTrace } = setup();
    commands.acquireRecoveryOrReplay.mockRejectedValue({
      status: 409,
      response: { code: 'warehouse_coverage_command_key_conflict' },
    });

    await expect(
      service.reportPhysicalException(ACTOR, task.id, dto({ reason: 'Другая причина' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(lockTrace).toEqual([]);
  });

  it('rejects a scan row outside the exact task before reservation mutation', async () => {
    const { service, task, tx } = setup();
    tx.scanRow.findUnique.mockResolvedValue({
      id: 'scan-row-a',
      taskId: 'another-task',
      rollCode: 'ROLL-1',
    });

    await expect(service.reportPhysicalException(ACTOR, task.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'warehouse_coverage_scan_row_conflict',
      }),
    });
    expect(tx.warehouseRoll.updateMany).not.toHaveBeenCalled();
  });

  it('does not let the warehouse choose a downstream route in the DTO', async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    await expect(
      pipe.transform(
        { ...dto(), nextRoute: 'produce_all' },
        {
          type: 'body',
          metatype: CoveragePhysicalExceptionDto,
          data: undefined,
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
