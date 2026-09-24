import type { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  commandRequestFingerprint,
  coverageCommandUserActor,
  type CoverageCommandInputByKind,
  WarehouseCoverageCommandService,
} from './warehouse-coverage-command.service';

const clientRequestId = '123e4567-e89b-12d3-a456-426614174000';
const orderId = 'order-1';
const actor = { kind: 'user' as const, actorRole: 'finance' as const, actorId: 'finance-1' };

const emptyFinanceRollSpec = {
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

const financeProjection = {
  workflowVersion: 2 as const,
  state: 'recheck_requested' as const,
  stateVersion: 5,
  generation: 2,
  availability: 'unknown' as const,
  reasonCodes: ['warehouse_recheck_pending' as const],
  nextOwner: 'warehouse' as const,
  availableActions: [],
  requiredRollCount: 1,
  matchedRollCount: 0,
  uncertainRollCount: 1,
  calculatedAt: '2026-07-24T10:00:00.000Z',
  stale: false,
  financeRolls: [
    {
      rollCode: 'ROLL-1',
      positionId: 'position-1',
      source: 'legacy' as const,
      locationLabel: 'Свободный резерв',
      availability: 'available' as const,
      batchCode: null,
      receivedAt: null,
      grossKg: null,
      spoolKg: null,
      requested: { ...emptyFinanceRollSpec },
      matched: { ...emptyFinanceRollSpec },
    },
  ],
};

function requestRecheck(
  overrides: Partial<CoverageCommandInputByKind<'request_recheck'>> = {},
): CoverageCommandInputByKind<'request_recheck'> {
  return {
    clientRequestId,
    kind: 'request_recheck',
    commercialOrderId: orderId,
    actor,
    payload: {
      expectedGeneration: 2,
      expectedStateVersion: 4,
      reason: 'Проверить покрытие',
    },
    ...overrides,
  };
}

function storedRequestRecheck() {
  const input = requestRecheck();
  return {
    id: 'command-1',
    clientRequestId,
    kind: input.kind,
    orderId,
    scopeCaseId: null,
    scopeTaskId: null,
    requestFingerprint: commandRequestFingerprint(input),
    actorKind: 'user',
    actorRole: 'finance',
    actorId: 'finance-1',
    systemActorKey: null,
    safeResultKind: 'projection_with_case',
    safeResult: { ...financeProjection, caseId: 'case-1' },
    resultKind: 'recheck_case',
    resultCalculationId: null,
    resultDecisionId: null,
    resultCaseId: 'case-1',
    resultGeneration: 2,
    resultStateVersion: 5,
  };
}

function setup(existing: unknown = null) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    warehouseCoverageCommand: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      update: jest.fn(),
    },
  } as unknown as Prisma.TransactionClient;
  return {
    tx,
    service: new WarehouseCoverageCommandService(),
  };
}

describe('WarehouseCoverageCommandService', () => {
  it('maps only an authenticated user identity into a routine command actor', () => {
    const authenticated: Actor = {
      userId: 'finance-1',
      role: 'finance',
      capabilities: ['warehouse_coverage:refresh'],
    };
    expect(coverageCommandUserActor(authenticated)).toEqual(actor);
    expect(() => coverageCommandUserActor({ ...authenticated, userId: null })).toThrow(
      'authenticated user',
    );
    expect(() => coverageCommandUserActor({ ...authenticated, userId: '' })).toThrow(
      'authenticated user',
    );
  });

  it('returns the original request-recheck response and rejects divergent UUID reuse', async () => {
    const { service, tx } = setup(storedRequestRecheck());
    await expect(service.acquireOrReplay(tx, requestRecheck())).resolves.toEqual({
      kind: 'replay',
      resultReference: { kind: 'recheck_case', caseId: 'case-1' },
      safeResult: { ...financeProjection, caseId: 'case-1' },
    });

    await expect(
      service.acquireOrReplay(
        tx,
        requestRecheck({
          payload: {
            ...requestRecheck().payload,
            expectedGeneration: 3,
          },
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: 'warehouse_coverage_command_key_conflict',
      }),
    });
  });

  it('upgrades the exact legacy roll-code snapshot during replay', async () => {
    const legacy = storedRequestRecheck();
    (legacy.safeResult as unknown as Record<string, unknown>).financeRolls = [
      { rollCode: 'ROLL-1', positionId: 'position-1' },
    ];
    const { service, tx } = setup(legacy);

    const replay = await service.acquireOrReplay(tx, requestRecheck());

    expect(replay).toMatchObject({
      kind: 'replay',
      safeResult: {
        financeRolls: [
          {
            rollCode: 'ROLL-1',
            positionId: 'position-1',
            source: 'legacy',
            locationLabel: 'Складской резерв',
            requested: { filmType: null, widthMm: null, netKg: null },
            matched: { filmType: null, widthMm: null, netKg: null },
          },
        ],
      },
    });
  });

  it('fingerprints the exact command scope and canonical payload', () => {
    const input: CoverageCommandInputByKind<'resolve_recheck'> = {
      clientRequestId,
      kind: 'resolve_recheck',
      commercialOrderId: orderId,
      scopeCaseId: 'case-1',
      actor: { kind: 'user', actorRole: 'warehouse', actorId: 'warehouse-1' },
      payload: {
        expectedCaseVersion: 2,
        expectedGeneration: 2,
        expectedStateVersion: 5,
        reason: 'Проверено',
        corrections: [
          {
            membershipId: 'membership-1',
            expectedFactVersion: 1,
            ownerCounterpartyId: 'counterparty-1',
          },
        ],
      },
    };
    expect(commandRequestFingerprint(input)).toBe(
      requestFingerprint({
        kind: 'resolve_recheck',
        commercialOrderId: orderId,
        scopeCaseId: 'case-1',
        scopeTaskId: null,
        payload: input.payload,
      }),
    );
    expect(commandRequestFingerprint({ ...input, scopeCaseId: 'case-2' })).not.toBe(
      commandRequestFingerprint(input),
    );
  });

  it('excludes undeclared roll and raw-device fields from the request fingerprint', () => {
    const clean = requestRecheck();
    const polluted = {
      ...clean,
      payload: {
        ...clean.payload,
        rollId: 'roll-secret',
        rawPayload: { scanner: 'secret' },
      },
    } as CoverageCommandInputByKind<'request_recheck'>;

    expect(commandRequestFingerprint(polluted)).toBe(commandRequestFingerprint(clean));
  });

  it('short-circuits replay before current case, fact, or state reads', async () => {
    const { service, tx } = setup(storedRequestRecheck());
    await expect(service.acquireOrReplay(tx, requestRecheck())).resolves.toMatchObject({
      kind: 'replay',
    });
    expect(Object.keys(tx)).toEqual(['$executeRaw', 'warehouseCoverageCommand']);
  });

  it('rejects a non-canonical UUID before issuing an advisory lock', async () => {
    const { service, tx } = setup();
    await expect(
      service.acquireOrReplay(tx, {
        ...requestRecheck(),
        clientRequestId: clientRequestId.toUpperCase(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('requires the exact recovery system actor and replays its original case', async () => {
    const recovery: CoverageCommandInputByKind<'cancel_reservation'> = {
      clientRequestId,
      kind: 'cancel_reservation',
      commercialOrderId: orderId,
      scopeTaskId: 'task-1',
      actor: { kind: 'system', systemActorKey: 'warehouse_coverage_engine' },
      payload: {
        expectedGeneration: 2,
        expectedStateVersion: 5,
        expectedTaskUpdatedAt: '2026-07-24T10:00:00.000Z',
        scanRowId: 'scan-1',
        exceptionKind: 'damaged',
        reason: 'Повреждена этикетка',
      },
    };
    const row = {
      ...storedRequestRecheck(),
      kind: recovery.kind,
      scopeTaskId: recovery.scopeTaskId,
      requestFingerprint: commandRequestFingerprint(recovery),
      actorKind: 'system',
      actorRole: null,
      actorId: null,
      systemActorKey: 'warehouse_coverage_engine',
      safeResult: {
        ...financeProjection,
        caseId: 'case-physical',
        financeRolls: undefined,
      },
      resultCaseId: 'case-physical',
    };
    delete (row.safeResult as Record<string, unknown>).financeRolls;
    const { service, tx } = setup(row);

    const expectedRecoveryResult = { ...financeProjection, caseId: 'case-physical' };
    delete (expectedRecoveryResult as Partial<typeof financeProjection>).financeRolls;
    await expect(service.acquireRecoveryOrReplay(tx, recovery)).resolves.toEqual({
      kind: 'replay',
      resultReference: { kind: 'recheck_case', caseId: 'case-physical' },
      safeResult: expectedRecoveryResult,
    });
  });

  it('creates no mutable row on acquisition and appends one exact final snapshot', async () => {
    const { service, tx } = setup();
    const input = requestRecheck();
    const acquisition = await service.acquireOrReplay(tx, input);
    expect(acquisition).toMatchObject({ kind: 'new', commandId: expect.any(String) });
    expect(tx.warehouseCoverageCommand.create).not.toHaveBeenCalled();
    if (acquisition.kind !== 'new') throw new Error('expected a new command');

    await service.appendFinal(tx, {
      ...input,
      commandId: acquisition.commandId,
      resultReference: { kind: 'recheck_case', caseId: 'case-1' },
      safeResult: { ...financeProjection, caseId: 'case-1' },
    });

    expect(tx.warehouseCoverageCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: acquisition.commandId,
        clientRequestId,
        requestFingerprint: commandRequestFingerprint(input),
        safeResultKind: 'projection_with_case',
        resultKind: 'recheck_case',
        resultCaseId: 'case-1',
        resultGeneration: 2,
        resultStateVersion: 5,
      }),
    });
    expect(tx.warehouseCoverageCommand.update).not.toHaveBeenCalled();
  });

  it('rejects raw or unexpected data in a stored safe replay snapshot', async () => {
    const unsafe = storedRequestRecheck();
    unsafe.safeResult = {
      ...unsafe.safeResult,
      rawPayload: { scanner: 'secret' },
    } as typeof unsafe.safeResult;
    const { service, tx } = setup(unsafe);
    await expect(service.acquireOrReplay(tx, requestRecheck())).rejects.toMatchObject({
      status: 500,
    });
  });

  it('rejects mixed stored result references instead of trusting a corrupt journal row', async () => {
    const mixed = {
      ...storedRequestRecheck(),
      resultDecisionId: '123e4567-e89b-12d3-a456-426614174001',
    };
    const { service, tx } = setup(mixed);
    await expect(service.acquireOrReplay(tx, requestRecheck())).rejects.toMatchObject({
      status: 500,
    });
  });

  it('canonicalizes and validates a new request before returning control to business CAS', async () => {
    const { service, tx } = setup();
    await expect(
      service.acquireOrReplay(tx, {
        ...requestRecheck(),
        payload: { ...requestRecheck().payload, reason: '  ' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
