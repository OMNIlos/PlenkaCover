import { ConflictException } from '@nestjs/common';
import type {
  FinanceWarehouseCoverageProjection,
  WarehouseCoverageProjection,
} from '@plenka/contracts';
import {
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from './warehouse-coverage-canonical';
import { COVERAGE_LOCKS_HELD } from './warehouse-coverage-transaction';
import * as coverageTransactionModule from './warehouse-coverage-transaction';
import { WarehouseCoverageRecheckService } from './warehouse-coverage-recheck.service';

describe('WarehouseCoverageRecheckService', () => {
  const financeActor = {
    userId: 'finance-1',
    role: 'finance' as const,
    capabilities: ['finance_order:read' as const, 'warehouse_coverage:request_recheck' as const],
  };
  const clientRequestId = '00000000-0000-4000-8000-000000000013';
  const financeOrderId = 'finance-1';
  const orderId = 'order-1';
  const calculationId = 'calculation-3';
  const autoDecisionId = '00000000-0000-4000-8000-0000000000a3';
  const caseId = 'coverage-case-1';
  const emptySpec = {
    filmType: null,
    actualThicknessMicron: null,
    accountingThicknessMicron: null,
    widthMm: null,
    plannedLengthM: null,
    netKg: null,
    spoolType: null,
    birka: null,
    materialLabel: null,
  };
  const expectedFinanceRolls = [
    {
      rollCode: 'ROLL-Z',
      positionId: 'position-1',
      source: 'legacy' as const,
      locationLabel: 'Свободный резерв',
      availability: 'available' as const,
      batchCode: null,
      receivedAt: null,
      grossKg: null,
      spoolKg: null,
      requested: { ...emptySpec },
      matched: { ...emptySpec },
    },
  ];

  const resultProjection = (
    stateVersion = 8,
  ): FinanceWarehouseCoverageProjection & { caseId: string } => ({
    workflowVersion: 2,
    state: 'recheck_requested',
    stateVersion,
    generation: 3,
    availability: 'unknown',
    reasonCodes: ['warehouse_recheck_pending'],
    nextOwner: 'warehouse',
    availableActions: [],
    requiredRollCount: 1,
    matchedRollCount: 1,
    uncertainRollCount: 1,
    calculatedAt: '2026-07-25T00:00:00.000Z',
    stale: false,
    financeRolls: expectedFinanceRolls,
    caseId,
  });

  function dto(
    overrides: Partial<{
      clientRequestId: string;
      expectedGeneration: number;
      expectedStateVersion: number;
      reason: string;
    }> = {},
  ) {
    return {
      clientRequestId,
      expectedGeneration: 3,
      expectedStateVersion: 7,
      reason: '  Нужна   точная перепроверка  ',
      ...overrides,
    };
  }

  function calculation(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: calculationId,
      orderId,
      generation: 3,
      inventoryEpoch: 4n,
      availability: 'verified_full',
      verifiedCandidateRollIds: ['roll-z'],
      uncertainCandidateRollIds: ['roll-a'],
      ...overrides,
    };
  }

  function harness(
    options: {
      workflowVersion?: 1 | 2;
      state?: string;
      stateVersion?: number;
      currentDecision?: null | {
        id: string;
        orderId: string;
        calculationId: string;
        generation: number;
        kind: 'use_warehouse' | 'produce_all' | 'auto_produce_all';
      };
      productionOrderId?: string | null;
      commandAcquisition?: unknown;
      divergentReplay?: boolean;
      legacyCase?: boolean;
      calculation?: ReturnType<typeof calculation>;
    } = {},
  ) {
    const workflowVersion = options.workflowVersion ?? 2;
    const sourceCalculation = options.calculation ?? calculation();
    let state = {
      orderId,
      state: options.state ?? 'awaiting_finance',
      stateVersion: options.stateVersion ?? 7,
      generation: 3,
      currentCalculationId: calculationId,
      currentDecisionId: options.currentDecision?.id ?? null,
      currentCalculation: sourceCalculation,
      currentDecision: options.currentDecision ?? null,
      order: {
        id: orderId,
        warehouseCoverageWorkflowVersion: workflowVersion,
        productionOrder:
          options.productionOrderId === undefined || options.productionOrderId === null
            ? null
            : { id: options.productionOrderId },
      },
    };
    const exactScope = `warehouse_coverage_v2:${orderId}:finance_request`;
    const legacyCase = options.legacyCase
      ? {
          id: 'legacy-case',
          openScopeKey: `warehouse_cover:${orderId}`,
          coverageScope: null,
          coverageOrigin: null,
          sourceCoverageCalculationId: null,
          sourceCoverageDecisionId: null,
          sourceCoverageStateVersion: null,
        }
      : null;
    let coverageCase: Record<string, unknown> | null = null;
    const memberships: Array<Record<string, unknown>> = [];
    const observedLocks: string[] = [];
    const writes = {
      case: 0,
      membership: 0,
      state: 0,
      audit: 0,
      command: 0,
    };
    const rolls = [
      {
        id: 'roll-a',
        rollCode: 'ROLL-A',
        ownerCounterpartyId: null,
        currentCoverageFactId: 'fact-a',
        currentCoverageFact: {
          id: 'fact-a',
          specVersion: 'warehouse-roll-coverage/v1',
          specFingerprint: 'invalid-fingerprint',
          spec: {
            policyVersion: 'warehouse-coverage-policy/v2',
            ownerCounterpartyId: null,
          },
        },
      },
      {
        id: 'roll-z',
        rollCode: 'ROLL-Z',
        ownerCounterpartyId: 'counterparty-1',
        currentCoverageFactId: 'fact-z',
        currentCoverageFact: {
          id: 'fact-z',
          specVersion: 'warehouse-roll-coverage/v1',
          specFingerprint: 'b'.repeat(64),
          spec: null,
        },
      },
    ];
    const tx = {
      $queryRaw: jest.fn(async () => {
        observedLocks.push('recheck_case');
        return coverageCase ? [{ id: coverageCase.id }] : [];
      }),
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue({ commercialOrderId: orderId }),
      },
      warehouseCoverageState: {
        findUnique: jest.fn(async () => state),
        updateMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const matches =
            where.orderId === state.orderId &&
            where.state === state.state &&
            where.stateVersion === state.stateVersion &&
            where.generation === state.generation &&
            where.currentCalculationId === state.currentCalculationId &&
            where.currentDecisionId === state.currentDecisionId;
          if (!matches) return { count: 0 };
          writes.state += 1;
          state = {
            ...state,
            state: 'recheck_requested',
            stateVersion: state.stateVersion + 1,
            currentDecisionId: null,
            currentDecision: null,
          };
          return { count: 1 };
        }),
      },
      warehouseCoverageInventoryEpoch: {
        findUnique: jest.fn().mockResolvedValue({ epoch: 4n }),
      },
      orderResolutionCase: {
        findUnique: jest.fn(async ({ where }: { where: { openScopeKey: string } }) =>
          where.openScopeKey === exactScope ? coverageCase : legacyCase,
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.case += 1;
          coverageCase = {
            id: caseId,
            version: 1,
            status: 'open',
            ...data,
          };
          return coverageCase;
        }),
      },
      warehouseRoll: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          rolls.filter((roll) => where.id.in.includes(roll.id)),
        ),
      },
      warehouseCoverageRecheckMembership: {
        findMany: jest.fn(async () => memberships),
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          writes.membership += 1;
          memberships.push(
            ...data.map((row, index) => ({
              id: `membership-${index + 1}`,
              ...row,
            })),
          );
          return { count: data.length };
        }),
      },
    };
    const coverageTransaction = {
      run: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const commandAcquisition =
      options.commandAcquisition ??
      (options.divergentReplay
        ? new ConflictException({
            statusCode: 409,
            code: 'warehouse_coverage_command_key_conflict',
          })
        : { kind: 'new', commandId: 'command-13' });
    const commands = {
      acquireOrReplay: jest.fn(async () => {
        if (commandAcquisition instanceof Error) throw commandAcquisition;
        return commandAcquisition;
      }),
      appendFinal: jest.fn(async () => {
        writes.command += 1;
      }),
    };
    const safeProjection = resultProjection(state.stateVersion + 1);
    const projections = {
      readForFinanceLocked: jest.fn(async () => {
        const { caseId: _caseId, ...projection } = safeProjection;
        return projection;
      }),
    };
    const audit = {
      record: jest.fn(async () => {
        writes.audit += 1;
      }),
    };
    const prisma = {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue({
          commercialOrderId: orderId,
          commercialOrder: { warehouseCoverageWorkflowVersion: workflowVersion },
        }),
      },
    };
    jest
      .spyOn(coverageTransactionModule, 'lockCoverageResources')
      .mockImplementation(async (_tx, targets) => {
        observedLocks.push(
          'command_advisory_key',
          'inventory_epoch',
          'coverage_state',
          'commercial_order',
        );
        if (targets.calculationId) observedLocks.push('current_calculation');
        if (targets.decisionId) observedLocks.push('current_decision');
        const rollIds = targets.resolveRollIdsAfterCoreLocks
          ? await targets.resolveRollIdsAfterCoreLocks(tx as never)
          : (targets.rollIds ?? []);
        if (rollIds.length > 0) observedLocks.push('warehouse_rolls_binary');
        return Object.freeze({
          [COVERAGE_LOCKS_HELD]: true as const,
          orderId,
          acquiredLevels: observedLocks.filter((level) => level !== 'recheck_case') as never,
          rollIds: Object.freeze([...rollIds].sort()),
        });
      });
    const service = new WarehouseCoverageRecheckService(
      prisma as never,
      audit as never,
      coverageTransaction as never,
      commands as never,
      projections as never,
      { appendWarehouseCorrection: jest.fn() } as never,
    );
    return {
      service,
      tx,
      commands,
      projections,
      audit,
      writes,
      observedLocks,
      readCase: () => coverageCase,
      membershipRows: () => memberships,
      readState: () => state,
      legacyCase,
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates an order-scoped finance_request case and normalized immutable membership', async () => {
    const test = harness();

    await expect(
      test.service.requestFromFinance(financeActor, financeOrderId, dto()),
    ).resolves.toEqual(resultProjection());

    expect(test.readCase()).toMatchObject({
      coverageOrigin: 'finance_request',
      coverageScope: `warehouse_coverage_v2:${orderId}`,
      openScopeKey: `warehouse_coverage_v2:${orderId}:finance_request`,
      orderId,
      sourceCoverageCalculationId: calculationId,
      sourceCoverageDecisionId: null,
      sourceCoverageStateVersion: 7,
      reason: 'Нужна точная перепроверка',
    });
    expect(test.membershipRows()).toEqual([
      expect.objectContaining({
        orderId,
        rollId: 'roll-a',
        sourceCalculationId: calculationId,
        sourceDecisionId: null,
        sourceCoverageFactId: 'fact-a',
        sourceKind: 'uncertain_candidate',
        reasonCodes: ['roll_facts_incomplete', 'roll_ownership_unverified'],
      }),
      expect.objectContaining({
        orderId,
        rollId: 'roll-z',
        sourceCalculationId: calculationId,
        sourceDecisionId: null,
        sourceCoverageFactId: 'fact-z',
        sourceKind: 'verified_candidate',
        reasonCodes: [],
      }),
    ]);
    expect(test.observedLocks).toEqual([
      'command_advisory_key',
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'recheck_case',
      'warehouse_rolls_binary',
    ]);
    expect(test.readState()).toMatchObject({
      state: 'recheck_requested',
      stateVersion: 8,
      currentDecisionId: null,
    });
    expect(test.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_recheck_requested',
        objectId: orderId,
      }),
      test.tx,
    );
    expect(test.commands.appendFinal).toHaveBeenCalledWith(
      test.tx,
      expect.objectContaining({
        kind: 'request_recheck',
        resultReference: { kind: 'recheck_case', caseId },
        safeResult: resultProjection(),
      }),
    );
  });

  it.each([
    [
      'after explicit use_warehouse',
      {
        state: 'warehouse_reserved',
        currentDecision: {
          id: autoDecisionId,
          orderId,
          calculationId,
          generation: 3,
          kind: 'use_warehouse' as const,
        },
      },
    ],
    [
      'after ProductionOrder',
      {
        state: 'production_required',
        currentDecision: {
          id: autoDecisionId,
          orderId,
          calculationId,
          generation: 3,
          kind: 'auto_produce_all' as const,
        },
        productionOrderId: 'production-order-1',
      },
    ],
    ['V1 order', { workflowVersion: 1 as const }],
  ])('rejects %s before any mutation', async (_label, options) => {
    const test = harness(options);

    await expect(
      test.service.requestFromFinance(financeActor, financeOrderId, dto()),
    ).rejects.toMatchObject({ status: 409 });

    expect(test.writes).toEqual({
      case: 0,
      membership: 0,
      state: 0,
      audit: 0,
      command: 0,
    });
  });

  it('locks then CAS-supersedes a pre-production auto decision without sourcing the case from it', async () => {
    const test = harness({
      state: 'production_required',
      currentDecision: {
        id: autoDecisionId,
        orderId,
        calculationId,
        generation: 3,
        kind: 'auto_produce_all',
      },
      calculation: calculation({
        availability: 'unavailable',
        verifiedCandidateRollIds: ['roll-z'],
        uncertainCandidateRollIds: [],
      }),
    });

    const result = await test.service.requestFromFinance(financeActor, financeOrderId, dto());

    expect(result.caseId).toBe(caseId);
    expect(test.observedLocks).toEqual([
      'command_advisory_key',
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'current_decision',
      'recheck_case',
      'warehouse_rolls_binary',
    ]);
    expect(test.readState()).toMatchObject({
      state: 'recheck_requested',
      currentDecisionId: null,
    });
    expect(test.readCase()).toMatchObject({
      coverageOrigin: 'finance_request',
      sourceCoverageDecisionId: null,
    });
  });

  it('returns the immutable exact replay before any mutable coverage read', async () => {
    const replay = resultProjection();
    const test = harness({
      commandAcquisition: {
        kind: 'replay',
        resultReference: { kind: 'recheck_case', caseId },
        safeResult: replay,
      },
    });

    await expect(
      test.service.requestFromFinance(financeActor, financeOrderId, dto()),
    ).resolves.toEqual(replay);

    expect(test.tx.warehouseCoverageState.findUnique).not.toHaveBeenCalled();
    expect(test.projections.readForFinanceLocked).not.toHaveBeenCalled();
    expect(test.writes).toEqual({
      case: 0,
      membership: 0,
      state: 0,
      audit: 0,
      command: 0,
    });
  });

  it('rejects divergent replay before any business mutation', async () => {
    const test = harness({ divergentReplay: true });

    await expect(
      test.service.requestFromFinance(financeActor, financeOrderId, dto({ expectedGeneration: 4 })),
    ).rejects.toMatchObject({ status: 409 });

    expect(test.writes).toEqual({
      case: 0,
      membership: 0,
      state: 0,
      audit: 0,
      command: 0,
    });
  });

  it('never reuses a legacy OrderResolutionCase with another scope key', async () => {
    const test = harness({ legacyCase: true });

    const result = await test.service.requestFromFinance(financeActor, financeOrderId, dto());

    expect(result.caseId).toBe(caseId);
    expect(result.caseId).not.toBe(test.legacyCase?.id);
    expect(test.tx.orderResolutionCase.findUnique).toHaveBeenCalledWith({
      where: {
        openScopeKey: `warehouse_coverage_v2:${orderId}:finance_request`,
      },
      select: expect.any(Object),
    });
  });
});

describe('WarehouseCoverageRecheckService warehouse queue and resolution', () => {
  const orderId = 'order-warehouse-recheck';
  const caseId = 'case-warehouse-recheck';
  const calculationId = 'calculation-warehouse-recheck';
  const membershipId = 'membership-warehouse-recheck';
  const rollId = 'roll-warehouse-recheck';
  const warehouseActor = {
    userId: 'warehouse-1',
    role: 'warehouse' as const,
    capabilities: ['warehouse_task:read' as const, 'warehouse_coverage:resolve_recheck' as const],
  };
  const financeActor = {
    userId: 'finance-1',
    role: 'finance' as const,
    capabilities: ['finance_order:read' as const],
  };
  const canonicalSpec = {
    rollCode: 'ROLL-W-001',
    sourceOrderId: orderId,
    sourcePositionId: 'position-1',
    ownerCounterpartyId: 'counterparty-1',
    filmType: 'пленка полиэтиленовая',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 80_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'полотно',
    spoolType: '76 мм',
    actualWeightMilliKg: 275_000,
    plannedWeightMilliKg: 275_000,
    ingredients: [{ rawMaterialDefinitionId: 'raw-1', shareBasisPoints: 10_000 }],
    recipeId: null,
    recipeVersion: 'v1',
    recipeDefinitionId: 'recipe-definition-1',
    recipeDefinitionVersionId: 'recipe-definition-version-1',
    recipeVersionNumber: 1,
    policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
  };

  function projection(): WarehouseCoverageProjection {
    return {
      workflowVersion: 2,
      state: 'awaiting_finance',
      stateVersion: 9,
      generation: 4,
      availability: 'verified_full',
      reasonCodes: ['full_cover_available'],
      nextOwner: 'finance',
      availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
      requiredRollCount: 1,
      matchedRollCount: 1,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-25T06:00:00.000Z',
      stale: false,
    };
  }

  function caseRow() {
    return {
      id: caseId,
      openScopeKey: `${caseId}:open`,
      orderId,
      type: 'warehouse_coverage_recheck',
      status: 'open',
      ownerRole: 'warehouse',
      version: 1,
      coverageScope: `warehouse_coverage_v2:${orderId}`,
      coverageOrigin: 'finance_request',
      sourceCoverageCalculationId: calculationId,
      sourceCoverageDecisionId: null,
      sourceCoverageStateVersion: 7,
      order: {
        id: orderId,
        warehouseCoverageWorkflowVersion: 2,
      },
    };
  }

  function memberRow() {
    return {
      id: membershipId,
      caseId,
      orderId,
      rollId,
      sourceCalculationId: calculationId,
      sourceDecisionId: null,
      sourceCoverageFactId: 'fact-1',
      sourceKind: 'verified_candidate',
      reasonCodes: [],
      roll: {
        id: rollId,
        rollCode: canonicalSpec.rollCode,
        ownerCounterpartyId: canonicalSpec.ownerCounterpartyId,
        currentCoverageFactId: 'fact-1',
        currentCoverageFact: {
          id: 'fact-1',
          version: 1,
          specVersion: 'warehouse-roll-coverage/v1',
          specFingerprint: fingerprintRollFact(canonicalSpec),
          spec: canonicalSpec,
          sourceOrderId: orderId,
          sourcePositionId: 'position-1',
        },
      },
    };
  }

  function correctionDto(targetMembershipId = membershipId) {
    return {
      clientRequestId: '00000000-0000-4000-8000-000000000014',
      expectedCaseVersion: 1,
      expectedGeneration: 3,
      expectedStateVersion: 8,
      reason: 'Проверено по этикетке и контрольному весу',
      corrections: [
        {
          membershipId: targetMembershipId,
          expectedFactVersion: 1,
          ownerCounterpartyId: 'counterparty-2',
        },
      ],
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('projects membership-only data with exact persisted generation and stateVersion', async () => {
    const row = {
      ...caseRow(),
      version: 12,
      sourceCoverageStateVersion: 3,
      order: {
        id: orderId,
        warehouseCoverageWorkflowVersion: 2,
        coverageState: {
          generation: 41,
          stateVersion: 77,
          currentCalculationId: calculationId,
          currentDecisionId: null,
        },
      },
      coverageMemberships: [memberRow()],
    };
    const prisma = {
      orderResolutionCase: {
        findMany: jest.fn().mockResolvedValue([row]),
      },
    };
    const service = new WarehouseCoverageRecheckService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const [item] = await service.listForWarehouse(warehouseActor);

    expect(item).toMatchObject({
      caseId,
      caseVersion: 12,
      generation: 41,
      stateVersion: 77,
      coverageOrigin: 'finance_request',
      reasonCodes: ['warehouse_recheck_pending'],
    });
    expect(Object.keys(item.members[0]).sort()).toEqual([
      'currentFactVersion',
      'currentSpec',
      'membershipId',
      'ownerVerified',
      'reasonCodes',
      'rollCode',
      'sourceKind',
    ]);
    expect(JSON.stringify(item)).not.toMatch(
      /rawPayload|requestFingerprint|counterpartyId|sourceOrderId|policyVersion/u,
    );
    await expect(service.listForWarehouse(financeActor)).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.orderResolutionCase.findMany).toHaveBeenCalledTimes(1);
  });

  it('lists a decision-linked physical exception through its exact type/origin pair', async () => {
    const physicalCaseId = 'case-physical-1';
    const decisionId = '00000000-0000-4000-8000-0000000000d1';
    const row = {
      ...caseRow(),
      id: physicalCaseId,
      openScopeKey: `${physicalCaseId}:open`,
      type: 'warehouse_coverage_physical_exception',
      coverageOrigin: 'decision_linked_physical_exception',
      sourceCoverageDecisionId: decisionId,
      order: {
        id: orderId,
        warehouseCoverageWorkflowVersion: 2,
        coverageState: {
          generation: 41,
          stateVersion: 77,
          currentCalculationId: calculationId,
          currentDecisionId: null,
        },
      },
      coverageMemberships: [
        {
          ...memberRow(),
          id: 'membership-physical-1',
          caseId: physicalCaseId,
          sourceDecisionId: decisionId,
          sourceKind: 'decision_match',
        },
      ],
    };
    const prisma = {
      orderResolutionCase: {
        findMany: jest.fn().mockResolvedValue([row]),
      },
    };
    const service = new WarehouseCoverageRecheckService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.listForWarehouse(warehouseActor)).resolves.toEqual([
      expect.objectContaining({
        caseId: physicalCaseId,
        coverageOrigin: 'decision_linked_physical_exception',
      }),
    ]);
    expect(prisma.orderResolutionCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              type: 'warehouse_coverage_recheck',
              coverageOrigin: 'finance_request',
            },
            {
              type: 'warehouse_coverage_physical_exception',
              coverageOrigin: 'decision_linked_physical_exception',
            },
          ],
        }),
      }),
    );
  });

  it.each([
    [
      'physical origin on the ordinary type',
      'warehouse_coverage_recheck',
      'decision_linked_physical_exception',
    ],
    [
      'finance origin on the physical type',
      'warehouse_coverage_physical_exception',
      'finance_request',
    ],
  ] as const)('fails closed for %s returned by storage', async (_label, type, coverageOrigin) => {
    const row = {
      ...caseRow(),
      type,
      coverageOrigin,
      sourceCoverageDecisionId:
        coverageOrigin === 'decision_linked_physical_exception'
          ? '00000000-0000-4000-8000-0000000000d1'
          : null,
      order: {
        id: orderId,
        warehouseCoverageWorkflowVersion: 2,
        coverageState: {
          generation: 41,
          stateVersion: 77,
          currentCalculationId: calculationId,
          currentDecisionId: null,
        },
      },
      coverageMemberships: [memberRow()],
    };
    const prisma = {
      orderResolutionCase: {
        findMany: jest.fn().mockResolvedValue([row]),
      },
    };
    const service = new WarehouseCoverageRecheckService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.listForWarehouse(warehouseActor)).rejects.toMatchObject({
      status: 409,
    });
  });

  function resolutionHarness(
    options: {
      coverageOrigin?: 'finance_request' | 'decision_linked_physical_exception' | 'invalid_origin';
      caseType?: 'warehouse_coverage_recheck' | 'warehouse_coverage_physical_exception';
      workflowVersion?: 1 | 2;
      commandAcquisition?: unknown;
    } = {},
  ) {
    const coverageOrigin = options.coverageOrigin ?? 'finance_request';
    const caseType =
      options.caseType ??
      (coverageOrigin === 'decision_linked_physical_exception'
        ? 'warehouse_coverage_physical_exception'
        : 'warehouse_coverage_recheck');
    const sourceDecisionId =
      coverageOrigin === 'decision_linked_physical_exception'
        ? '00000000-0000-4000-8000-0000000000d1'
        : null;
    const currentCase = {
      ...caseRow(),
      type: caseType,
      coverageOrigin,
      sourceCoverageDecisionId: sourceDecisionId,
      order: {
        id: orderId,
        warehouseCoverageWorkflowVersion: options.workflowVersion ?? 2,
      },
    };
    const member = {
      ...memberRow(),
      sourceDecisionId,
      sourceKind:
        coverageOrigin === 'decision_linked_physical_exception'
          ? 'decision_match'
          : 'verified_candidate',
    };
    const state = {
      orderId,
      state: 'recheck_requested',
      stateVersion: 8,
      generation: 3,
      currentCalculationId: calculationId,
      currentDecisionId: null,
      currentCalculation: {
        id: calculationId,
        orderId,
        generation: 3,
        inventoryEpoch: 4n,
        availability: 'verified_full',
        verifiedCandidateRollIds: [rollId],
        uncertainCandidateRollIds: [],
      },
      currentDecision: null,
      order: {
        warehouseCoverageWorkflowVersion: options.workflowVersion ?? 2,
        productionOrder: null,
      },
    };
    const tx = {
      $queryRaw: jest.fn(
        async (query: { strings?: readonly string[] }): Promise<Array<{ id: string }>> => {
          const sql = query.strings?.join(' ') ?? '';
          if (sql.includes('FROM "warehouse_coverage_decisions"')) {
            return sourceDecisionId ? [{ id: sourceDecisionId }] : [];
          }
          if (sql.includes('FROM "order_resolution_cases"')) return [{ id: caseId }];
          return [];
        },
      ),
      orderResolutionCase: {
        findUnique: jest.fn().mockResolvedValue(currentCase),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      warehouseCoverageState: {
        findUnique: jest.fn().mockResolvedValue(state),
      },
      warehouseCoverageRecheckMembership: {
        findMany: jest.fn(async ({ select }: { select: Record<string, unknown> }) =>
          Object.keys(select).length === 1 && select.rollId === true ? [{ rollId }] : [member],
        ),
      },
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: orderId,
          version: 1,
          warehouseCoverageWorkflowVersion: options.workflowVersion ?? 2,
          counterpartyId: 'counterparty-1',
          positions: [],
        }),
      },
    };
    const transaction = {
      run: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const commands = {
      acquireOrReplay: jest
        .fn()
        .mockResolvedValue(options.commandAcquisition ?? { kind: 'new', commandId: 'command-14' }),
      appendFinal: jest.fn(),
    };
    const calculations = {
      calculateLocked: jest.fn().mockResolvedValue({
        calculationId: 'calculation-4',
        projection: projection(),
      }),
    };
    const facts = {
      appendWarehouseCorrection: jest.fn().mockResolvedValue({ factId: 'fact-2', version: 2 }),
    };
    const audit = { record: jest.fn() };
    let lockProof: unknown;
    jest
      .spyOn(coverageTransactionModule, 'lockCoverageResources')
      .mockImplementation(async (_client, targets) => {
        const rollIds = targets.resolveRollIdsAfterCoreLocks
          ? await targets.resolveRollIdsAfterCoreLocks(tx as never)
          : [];
        lockProof = Object.freeze({
          [COVERAGE_LOCKS_HELD]: true as const,
          orderId,
          acquiredLevels: Object.freeze([
            'command_advisory_key',
            'inventory_epoch',
            'coverage_state',
            'commercial_order',
            'current_calculation',
            ...(targets.caseId ? (['recheck_case'] as const) : []),
            'warehouse_rolls_binary',
          ]),
          rollIds: Object.freeze([...rollIds]),
        });
        return lockProof as never;
      });
    const service = new WarehouseCoverageRecheckService(
      {} as never,
      audit as never,
      transaction as never,
      commands as never,
      calculations as never,
      facts as never,
    );
    return {
      service,
      tx,
      commands,
      calculations,
      facts,
      audit,
      getLockProof: () => lockProof,
    };
  }

  it('appends the scoped fact, closes the case, recalculates, audits, and journals', async () => {
    const test = resolutionHarness();

    await expect(
      test.service.resolveFromWarehouse(warehouseActor, caseId, correctionDto()),
    ).resolves.toEqual(projection());

    expect(test.facts.appendWarehouseCorrection).toHaveBeenCalledWith(
      test.tx,
      expect.objectContaining({
        rollId,
        expectedFactVersion: 1,
        reason: 'Проверено по этикетке и контрольному весу',
        nextSpec: expect.objectContaining({
          ownerCounterpartyId: 'counterparty-2',
          rollCode: canonicalSpec.rollCode,
        }),
      }),
      warehouseActor,
    );
    expect(test.tx.orderResolutionCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: caseId, status: 'open', version: 1 }),
        data: expect.objectContaining({ status: 'resolved', version: { increment: 1 } }),
      }),
    );
    expect(test.calculations.calculateLocked).toHaveBeenCalledWith(
      test.tx,
      {
        commercialOrderId: orderId,
        expectedGeneration: 3,
        expectedStateVersion: 8,
      },
      test.getLockProof(),
    );
    expect(test.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_coverage_recheck_resolved',
        objectId: orderId,
      }),
      test.tx,
    );
    expect(test.commands.appendFinal).toHaveBeenCalledWith(
      test.tx,
      expect.objectContaining({
        kind: 'resolve_recheck',
        scopeCaseId: caseId,
        resultReference: {
          kind: 'calculation',
          calculationId: 'calculation-4',
        },
        safeResult: projection(),
      }),
    );
  });

  it('rejects a correction outside normalized membership without mutation', async () => {
    const test = resolutionHarness();

    await expect(
      test.service.resolveFromWarehouse(
        warehouseActor,
        caseId,
        correctionDto('membership-outside-case'),
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(test.facts.appendWarehouseCorrection).not.toHaveBeenCalled();
    expect(test.tx.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    expect(test.calculations.calculateLocked).not.toHaveBeenCalled();
    expect(test.audit.record).not.toHaveBeenCalled();
    expect(test.commands.appendFinal).not.toHaveBeenCalled();
  });

  it('returns an exact immutable replay before state, membership, fact, or calculation reads', async () => {
    const replay = projection();
    const test = resolutionHarness({
      commandAcquisition: {
        kind: 'replay',
        resultReference: { kind: 'calculation', calculationId: 'calculation-4' },
        safeResult: replay,
      },
    });

    await expect(
      test.service.resolveFromWarehouse(warehouseActor, caseId, correctionDto()),
    ).resolves.toEqual(replay);

    expect(test.tx.warehouseCoverageState.findUnique).not.toHaveBeenCalled();
    expect(test.tx.warehouseCoverageRecheckMembership.findMany).not.toHaveBeenCalled();
    expect(test.facts.appendWarehouseCorrection).not.toHaveBeenCalled();
    expect(test.calculations.calculateLocked).not.toHaveBeenCalled();
    expect(test.commands.appendFinal).not.toHaveBeenCalled();
  });

  it('accepts the exact physical origin and includes its immutable source decision lock', async () => {
    const test = resolutionHarness({
      coverageOrigin: 'decision_linked_physical_exception',
    });

    await expect(
      test.service.resolveFromWarehouse(warehouseActor, caseId, correctionDto()),
    ).resolves.toEqual(projection());

    expect(coverageTransactionModule.lockCoverageResources).toHaveBeenCalledWith(
      test.tx,
      expect.objectContaining({
        orderId,
        calculationId,
      }),
    );
    const targets = jest.mocked(coverageTransactionModule.lockCoverageResources).mock.calls[0]?.[1];
    expect(targets?.decisionId).toBeUndefined();
    expect(targets?.caseId).toBeUndefined();
    const physicalLockSql = test.tx.$queryRaw.mock.calls
      .map(([query]) => query.strings?.join(' ') ?? '')
      .filter(
        (sql) =>
          sql.includes('FROM "warehouse_coverage_decisions"') ||
          sql.includes('FROM "order_resolution_cases"'),
      );
    expect(physicalLockSql).toHaveLength(2);
    expect(physicalLockSql[0]).toContain('FROM "warehouse_coverage_decisions"');
    expect(physicalLockSql[0]).toMatch(/decision\."id"\s*=\s*CAST\(/u);
    expect(physicalLockSql[1]).toContain('FROM "order_resolution_cases"');
    expect(physicalLockSql[1]).toMatch(/coverage_case\."sourceCoverageDecisionId"\s*=\s*CAST\(/u);
    expect(test.calculations.calculateLocked.mock.calls[0]?.[2].acquiredLevels).toEqual([
      'command_advisory_key',
      'inventory_epoch',
      'coverage_state',
      'commercial_order',
      'current_calculation',
      'current_decision',
      'recheck_case',
      'warehouse_rolls_binary',
    ]);
  });

  it.each([
    ['an unsupported origin', { coverageOrigin: 'invalid_origin' as const }],
    ['a legacy order', { workflowVersion: 1 as const }],
    [
      'a physical origin on the ordinary case type',
      {
        coverageOrigin: 'decision_linked_physical_exception' as const,
        caseType: 'warehouse_coverage_recheck' as const,
      },
    ],
    [
      'a finance origin on the physical case type',
      {
        coverageOrigin: 'finance_request' as const,
        caseType: 'warehouse_coverage_physical_exception' as const,
      },
    ],
  ])('rejects %s before command or business mutation', async (_label, options) => {
    const test = resolutionHarness(options);

    await expect(
      test.service.resolveFromWarehouse(warehouseActor, caseId, correctionDto()),
    ).rejects.toMatchObject({ status: 409 });

    expect(test.commands.acquireOrReplay).not.toHaveBeenCalled();
    expect(test.facts.appendWarehouseCorrection).not.toHaveBeenCalled();
    expect(test.tx.orderResolutionCase.updateMany).not.toHaveBeenCalled();
    expect(test.calculations.calculateLocked).not.toHaveBeenCalled();
  });
});
