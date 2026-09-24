import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  FinanceCoverageRollProjection,
  FinanceWarehouseCoverageProjection,
  Role,
  UtcIsoString,
  UuidString,
  WarehouseCoverageCommandKind,
  WarehouseCoverageProjection,
  WarehouseCoverageRecoveryCommandKind,
} from '@plenka/contracts';
import {
  WAREHOUSE_COVERAGE_ACTIONS,
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_OWNERS,
  WAREHOUSE_COVERAGE_REASON_CODES,
  WAREHOUSE_COVERAGE_ROLL_AVAILABILITIES,
  WAREHOUSE_COVERAGE_ROLL_SOURCES,
  WAREHOUSE_COVERAGE_STATES,
} from '@plenka/contracts';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import type { Actor } from '../../common/auth/actor';
import {
  normalizeCoverageText,
  normalizeIngredients,
  normalizeSpool,
  type CanonicalIngredient,
} from './warehouse-coverage-canonical';
import { lockCoverageCommandAdvisory } from './warehouse-coverage-transaction';

export type CoverageCommandActor =
  | { kind: 'user'; actorRole: Role; actorId: string }
  | { kind: 'system'; systemActorKey: 'warehouse_coverage_engine' };

export function coverageCommandUserActor(
  actor: Actor,
): Extract<CoverageCommandActor, { kind: 'user' }> {
  if (!actor.userId) {
    throw new UnauthorizedException({
      statusCode: 401,
      code: 'warehouse_coverage_authenticated_user_required',
      message: 'Warehouse coverage command requires an authenticated user.',
    });
  }
  return {
    kind: 'user',
    actorRole: actor.role,
    actorId: actor.userId,
  };
}

export interface CanonicalWarehouseCoverageCorrectionCommandSpec {
  filmType: string;
  actualThicknessMilliMicron: number;
  accountingThicknessMilliMicron: number;
  widthMilliMm: number;
  plannedLengthMilliM: number;
  birka: string;
  spoolType: string;
  actualWeightMilliKg: number;
  plannedWeightMilliKg: number;
  recipeId: string | null;
  recipeVersion: string | null;
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeVersionNumber: number | null;
  ingredients: readonly CanonicalIngredient[];
}

export type CanonicalWarehouseCoverageCorrectionCommand = {
  membershipId: string;
  expectedFactVersion: number | null;
} & (
  | {
      ownerCounterpartyId: string;
      spec?: CanonicalWarehouseCoverageCorrectionCommandSpec;
    }
  | {
      ownerCounterpartyId?: string;
      spec: CanonicalWarehouseCoverageCorrectionCommandSpec;
    }
);

export interface CoverageCommandPayloadByKind {
  refresh: {
    expectedGeneration: number | null;
    expectedStateVersion: number;
  };
  decide: {
    expectedGeneration: number;
    expectedStateVersion: number;
    decision: 'use_warehouse' | 'produce_all';
  };
  request_recheck: {
    expectedGeneration: number;
    expectedStateVersion: number;
    reason: string;
  };
  resolve_recheck: {
    expectedCaseVersion: number;
    expectedGeneration: number;
    expectedStateVersion: number;
    reason: string;
    corrections: readonly CanonicalWarehouseCoverageCorrectionCommand[];
  };
  cancel_reservation: {
    expectedGeneration: number;
    expectedStateVersion: number;
    expectedTaskUpdatedAt: UtcIsoString;
    scanRowId: string;
    exceptionKind: 'missing' | 'damaged';
    reason: string;
    evidenceRef?: string;
  };
}

export interface CoverageCommandScopeByKind {
  refresh: { scopeCaseId?: never; scopeTaskId?: never };
  decide: { scopeCaseId?: never; scopeTaskId?: never };
  request_recheck: { scopeCaseId?: never; scopeTaskId?: never };
  resolve_recheck: { scopeCaseId: string; scopeTaskId?: never };
  cancel_reservation: { scopeCaseId?: never; scopeTaskId: string };
}

export interface CoverageCommandSafeResultByKind {
  refresh: FinanceWarehouseCoverageProjection;
  decide: FinanceWarehouseCoverageProjection;
  request_recheck: FinanceWarehouseCoverageProjection & { caseId: string };
  resolve_recheck: WarehouseCoverageProjection;
  cancel_reservation: WarehouseCoverageProjection & { caseId: string };
}

export interface CoverageCommandResultReferenceByKind {
  refresh: { kind: 'calculation'; calculationId: string };
  decide: { kind: 'decision'; decisionId: string };
  request_recheck: { kind: 'recheck_case'; caseId: string };
  resolve_recheck: { kind: 'calculation'; calculationId: string };
  cancel_reservation: { kind: 'recheck_case'; caseId: string };
}

export type AnyCoverageCommandKind =
  | WarehouseCoverageCommandKind
  | WarehouseCoverageRecoveryCommandKind;

export type CoverageCommandActorByKind<K extends AnyCoverageCommandKind> =
  K extends WarehouseCoverageRecoveryCommandKind
    ? Extract<CoverageCommandActor, { kind: 'system' }>
    : Extract<CoverageCommandActor, { kind: 'user' }>;

export type CoverageCommandInputByKind<K extends AnyCoverageCommandKind> = {
  clientRequestId: UuidString;
  kind: K;
  commercialOrderId: string;
  actor: CoverageCommandActorByKind<K>;
  payload: CoverageCommandPayloadByKind[K];
} & CoverageCommandScopeByKind[K];

export type CoverageCommandAcquisition<K extends AnyCoverageCommandKind> =
  | { kind: 'new'; commandId: string }
  | {
      kind: 'replay';
      resultReference: CoverageCommandResultReferenceByKind[K];
      safeResult: CoverageCommandSafeResultByKind[K];
    };

export type CoverageCommandFinalInput<K extends AnyCoverageCommandKind> =
  CoverageCommandInputByKind<K> & {
    commandId: string;
    resultReference: CoverageCommandResultReferenceByKind[K];
    safeResult: CoverageCommandSafeResultByKind[K];
  };

type StoredCoverageCommand = Awaited<
  ReturnType<Prisma.TransactionClient['warehouseCoverageCommand']['findUnique']>
>;
type PresentStoredCoverageCommand = Exclude<StoredCoverageCommand, null>;

const PROJECTION_KEYS = [
  'workflowVersion',
  'state',
  'stateVersion',
  'generation',
  'availability',
  'reasonCodes',
  'nextOwner',
  'availableActions',
  'requiredRollCount',
  'matchedRollCount',
  'uncertainRollCount',
  'calculatedAt',
  'stale',
] as const;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function commandRequestFingerprint<K extends AnyCoverageCommandKind>(
  input: CoverageCommandInputByKind<K>,
): string {
  return requestFingerprint({
    kind: input.kind,
    commercialOrderId: input.commercialOrderId,
    scopeCaseId: 'scopeCaseId' in input ? (input.scopeCaseId ?? null) : null,
    scopeTaskId: 'scopeTaskId' in input ? (input.scopeTaskId ?? null) : null,
    payload: canonicalPayload(input.kind, input.payload),
  });
}

@Injectable()
export class WarehouseCoverageCommandService {
  async acquireOrReplay<K extends WarehouseCoverageCommandKind>(
    tx: Prisma.TransactionClient,
    input: CoverageCommandInputByKind<K>,
  ): Promise<CoverageCommandAcquisition<K>> {
    assertCanonicalClientRequestId(input.clientRequestId);
    assertRoutineActor(input.actor);
    return this.acquire(tx, input);
  }

  async acquireRecoveryOrReplay(
    tx: Prisma.TransactionClient,
    input: CoverageCommandInputByKind<'cancel_reservation'>,
  ): Promise<CoverageCommandAcquisition<'cancel_reservation'>> {
    assertCanonicalClientRequestId(input.clientRequestId);
    assertRecoveryActor(input.actor);
    return this.acquire(tx, input);
  }

  async appendFinal<K extends AnyCoverageCommandKind>(
    tx: Prisma.TransactionClient,
    input: CoverageCommandFinalInput<K>,
  ): Promise<void> {
    assertCanonicalClientRequestId(input.clientRequestId);
    if (input.kind === 'cancel_reservation') {
      assertRecoveryActor(input.actor);
    } else {
      assertRoutineActor(input.actor);
    }
    const safeResult = parseSafeResult(input.kind, input.safeResult);
    const resultReference = parseResultReference(input.kind, input.resultReference);
    assertCaseSnapshotReference(input.kind, safeResult, resultReference);
    const actorColumns =
      input.actor.kind === 'user'
        ? {
            actorKind: 'user',
            actorRole: input.actor.actorRole,
            actorId: requireOpaqueId(input.actor.actorId, 'actorId'),
            systemActorKey: null,
          }
        : {
            actorKind: 'system',
            actorRole: null,
            actorId: null,
            systemActorKey: input.actor.systemActorKey,
          };
    const referenceColumns = referenceColumnsFor(resultReference);

    await tx.warehouseCoverageCommand.create({
      data: {
        id: requireOpaqueId(input.commandId, 'commandId'),
        clientRequestId: input.clientRequestId,
        kind: input.kind,
        orderId: requireOpaqueId(input.commercialOrderId, 'commercialOrderId'),
        scopeCaseId:
          'scopeCaseId' in input && input.scopeCaseId !== undefined
            ? requireOpaqueId(input.scopeCaseId, 'scopeCaseId')
            : null,
        scopeTaskId:
          'scopeTaskId' in input && input.scopeTaskId !== undefined
            ? requireOpaqueId(input.scopeTaskId, 'scopeTaskId')
            : null,
        requestFingerprint: commandRequestFingerprint(input),
        ...actorColumns,
        safeResultKind:
          input.kind === 'request_recheck' || input.kind === 'cancel_reservation'
            ? 'projection_with_case'
            : 'projection',
        safeResult: safeResult as unknown as Prisma.InputJsonValue,
        ...referenceColumns,
        resultGeneration: safeResult.generation,
        resultStateVersion: safeResult.stateVersion,
      },
    });
  }

  private async acquire<K extends AnyCoverageCommandKind>(
    tx: Prisma.TransactionClient,
    input: CoverageCommandInputByKind<K>,
  ): Promise<CoverageCommandAcquisition<K>> {
    requireOpaqueId(input.commercialOrderId, 'commercialOrderId');
    if ('scopeCaseId' in input && input.scopeCaseId !== undefined) {
      requireOpaqueId(input.scopeCaseId, 'scopeCaseId');
    }
    if ('scopeTaskId' in input && input.scopeTaskId !== undefined) {
      requireOpaqueId(input.scopeTaskId, 'scopeTaskId');
    }
    const fingerprint = commandRequestFingerprint(input);
    await lockCommandKey(tx, input.clientRequestId);
    const existing = await tx.warehouseCoverageCommand.findUnique({
      where: { clientRequestId: input.clientRequestId },
    });
    if (existing === null) return { kind: 'new', commandId: randomUUID() };
    this.assertReplayIdentity(existing, input, fingerprint);
    return {
      kind: 'replay',
      resultReference: parseStoredResultReference(
        input.kind,
        existing,
      ) as CoverageCommandResultReferenceByKind[K],
      safeResult: parseSafeResult(
        input.kind,
        existing.safeResult,
      ) as CoverageCommandSafeResultByKind[K],
    };
  }

  private assertReplayIdentity<K extends AnyCoverageCommandKind>(
    existing: PresentStoredCoverageCommand,
    input: CoverageCommandInputByKind<K>,
    fingerprint: string,
  ): void {
    const expectedScopeCaseId = 'scopeCaseId' in input ? (input.scopeCaseId ?? null) : null;
    const expectedScopeTaskId = 'scopeTaskId' in input ? (input.scopeTaskId ?? null) : null;
    const actorMatches =
      input.actor.kind === 'user'
        ? existing.actorKind === 'user' &&
          existing.actorRole === input.actor.actorRole &&
          existing.actorId === input.actor.actorId &&
          existing.systemActorKey === null
        : existing.actorKind === 'system' &&
          existing.actorRole === null &&
          existing.actorId === null &&
          existing.systemActorKey === input.actor.systemActorKey;

    if (
      existing.kind !== input.kind ||
      existing.orderId !== input.commercialOrderId ||
      existing.scopeCaseId !== expectedScopeCaseId ||
      existing.scopeTaskId !== expectedScopeTaskId ||
      !actorMatches ||
      existing.requestFingerprint !== fingerprint
    ) {
      throw commandKeyConflict();
    }
  }
}

async function lockCommandKey(
  tx: Prisma.TransactionClient,
  clientRequestId: string,
): Promise<void> {
  await lockCoverageCommandAdvisory(tx, clientRequestId);
}

function canonicalPayload<K extends AnyCoverageCommandKind>(
  kind: K,
  payload: CoverageCommandPayloadByKind[K],
): CoverageCommandPayloadByKind[K] {
  if (kind === 'refresh') {
    const value = payload as CoverageCommandPayloadByKind['refresh'];
    return {
      expectedGeneration:
        value.expectedGeneration === null
          ? null
          : requirePositiveInteger(value.expectedGeneration, 'expectedGeneration'),
      expectedStateVersion: requirePositiveInteger(
        value.expectedStateVersion,
        'expectedStateVersion',
      ),
    } as CoverageCommandPayloadByKind[K];
  }
  if (kind === 'decide') {
    const value = payload as CoverageCommandPayloadByKind['decide'];
    if (value.decision !== 'use_warehouse' && value.decision !== 'produce_all') {
      invalidJournal('decision');
    }
    return {
      expectedGeneration: requirePositiveInteger(value.expectedGeneration, 'expectedGeneration'),
      expectedStateVersion: requirePositiveInteger(
        value.expectedStateVersion,
        'expectedStateVersion',
      ),
      decision: value.decision,
    } as CoverageCommandPayloadByKind[K];
  }
  if (kind === 'request_recheck') {
    const value = payload as CoverageCommandPayloadByKind['request_recheck'];
    return {
      expectedGeneration: requirePositiveInteger(value.expectedGeneration, 'expectedGeneration'),
      expectedStateVersion: requirePositiveInteger(
        value.expectedStateVersion,
        'expectedStateVersion',
      ),
      reason: canonicalReason(value.reason),
    } as unknown as CoverageCommandPayloadByKind[K];
  }
  if (kind === 'resolve_recheck') {
    const value = payload as CoverageCommandPayloadByKind['resolve_recheck'];
    return {
      expectedCaseVersion: requirePositiveInteger(value.expectedCaseVersion, 'expectedCaseVersion'),
      expectedGeneration: requirePositiveInteger(value.expectedGeneration, 'expectedGeneration'),
      expectedStateVersion: requirePositiveInteger(
        value.expectedStateVersion,
        'expectedStateVersion',
      ),
      reason: canonicalReason(value.reason),
      corrections: value.corrections.map(canonicalCorrection),
    } as unknown as CoverageCommandPayloadByKind[K];
  }
  if (kind === 'cancel_reservation') {
    const value = payload as CoverageCommandPayloadByKind['cancel_reservation'];
    if (value.exceptionKind !== 'missing' && value.exceptionKind !== 'damaged') {
      invalidJournal('exceptionKind');
    }
    return {
      expectedGeneration: requirePositiveInteger(value.expectedGeneration, 'expectedGeneration'),
      expectedStateVersion: requirePositiveInteger(
        value.expectedStateVersion,
        'expectedStateVersion',
      ),
      expectedTaskUpdatedAt: requireUtcIso(value.expectedTaskUpdatedAt, 'expectedTaskUpdatedAt'),
      scanRowId: requireOpaqueId(value.scanRowId, 'scanRowId'),
      exceptionKind: value.exceptionKind,
      reason: canonicalReason(value.reason),
      ...(value.evidenceRef === undefined
        ? {}
        : { evidenceRef: requireOpaqueId(value.evidenceRef, 'evidenceRef') }),
    } as unknown as CoverageCommandPayloadByKind[K];
  }
  throw new BadRequestException('unsupported warehouse coverage command');
}

function canonicalCorrection(
  value: CanonicalWarehouseCoverageCorrectionCommand,
): CanonicalWarehouseCoverageCorrectionCommand {
  const common = {
    membershipId: requireOpaqueId(value.membershipId, 'membershipId'),
    expectedFactVersion:
      value.expectedFactVersion === null
        ? null
        : requirePositiveInteger(value.expectedFactVersion, 'expectedFactVersion'),
  };
  const owner =
    value.ownerCounterpartyId === undefined
      ? {}
      : {
          ownerCounterpartyId: requireOpaqueId(value.ownerCounterpartyId, 'ownerCounterpartyId'),
        };
  const spec = value.spec === undefined ? {} : { spec: canonicalCorrectionSpec(value.spec) };
  if (Object.keys(owner).length === 0 && Object.keys(spec).length === 0) {
    throw new BadRequestException('owner or spec correction required');
  }
  return { ...common, ...owner, ...spec } as CanonicalWarehouseCoverageCorrectionCommand;
}

function canonicalCorrectionSpec(
  value: CanonicalWarehouseCoverageCorrectionCommandSpec,
): CanonicalWarehouseCoverageCorrectionCommandSpec {
  return {
    filmType: normalizeCoverageText(value.filmType),
    actualThicknessMilliMicron: requirePositiveInteger(
      value.actualThicknessMilliMicron,
      'actualThicknessMilliMicron',
    ),
    accountingThicknessMilliMicron: requirePositiveInteger(
      value.accountingThicknessMilliMicron,
      'accountingThicknessMilliMicron',
    ),
    widthMilliMm: requirePositiveInteger(value.widthMilliMm, 'widthMilliMm'),
    plannedLengthMilliM: requirePositiveInteger(value.plannedLengthMilliM, 'plannedLengthMilliM'),
    birka: normalizeCoverageText(value.birka),
    spoolType: normalizeSpool(value.spoolType),
    actualWeightMilliKg: requirePositiveInteger(value.actualWeightMilliKg, 'actualWeightMilliKg'),
    plannedWeightMilliKg: requirePositiveInteger(
      value.plannedWeightMilliKg,
      'plannedWeightMilliKg',
    ),
    recipeId: nullableOpaqueId(value.recipeId, 'recipeId'),
    recipeVersion: nullableOpaqueId(value.recipeVersion, 'recipeVersion'),
    recipeDefinitionId: nullableOpaqueId(value.recipeDefinitionId, 'recipeDefinitionId'),
    recipeDefinitionVersionId: nullableOpaqueId(
      value.recipeDefinitionVersionId,
      'recipeDefinitionVersionId',
    ),
    recipeVersionNumber:
      value.recipeVersionNumber === null
        ? null
        : requirePositiveInteger(value.recipeVersionNumber, 'recipeVersionNumber'),
    ingredients: normalizeIngredients(value.ingredients),
  };
}

function parseSafeResult<K extends AnyCoverageCommandKind>(
  kind: K,
  value: unknown,
): CoverageCommandSafeResultByKind[K] {
  const source = requireRecord(value, 'safeResult');
  const finance = kind === 'refresh' || kind === 'decide' || kind === 'request_recheck';
  const withCase = kind === 'request_recheck' || kind === 'cancel_reservation';
  const exactKeys = [
    ...PROJECTION_KEYS,
    ...(finance ? ['financeRolls'] : []),
    ...(withCase ? ['caseId'] : []),
  ];
  assertExactKeys(source, exactKeys);

  const projection: WarehouseCoverageProjection = {
    workflowVersion:
      source.workflowVersion === 1 || source.workflowVersion === 2
        ? source.workflowVersion
        : invalidJournal('workflowVersion'),
    state: requireMember(source.state, WAREHOUSE_COVERAGE_STATES, 'state'),
    stateVersion: requirePositiveInteger(source.stateVersion, 'stateVersion'),
    generation: requirePositiveInteger(source.generation, 'generation'),
    availability:
      source.availability === null
        ? null
        : requireMember(source.availability, WAREHOUSE_COVERAGE_AVAILABILITIES, 'availability'),
    reasonCodes: requireMemberArray(
      source.reasonCodes,
      WAREHOUSE_COVERAGE_REASON_CODES,
      'reasonCodes',
    ),
    nextOwner: requireMember(source.nextOwner, WAREHOUSE_COVERAGE_OWNERS, 'nextOwner'),
    availableActions: requireMemberArray(
      source.availableActions,
      WAREHOUSE_COVERAGE_ACTIONS,
      'availableActions',
    ),
    requiredRollCount: requireNonNegativeInteger(source.requiredRollCount, 'requiredRollCount'),
    matchedRollCount: requireNonNegativeInteger(source.matchedRollCount, 'matchedRollCount'),
    uncertainRollCount: requireNonNegativeInteger(source.uncertainRollCount, 'uncertainRollCount'),
    calculatedAt:
      source.calculatedAt === null ? null : requireUtcIso(source.calculatedAt, 'calculatedAt'),
    stale: requireBoolean(source.stale, 'stale'),
  };
  if (projection.matchedRollCount > projection.requiredRollCount) {
    invalidJournal('matchedRollCount');
  }

  const result: Record<string, unknown> = { ...projection };
  if (finance) result.financeRolls = parseFinanceRolls(source.financeRolls);
  if (withCase) result.caseId = requireOpaqueId(source.caseId, 'caseId');
  return result as unknown as CoverageCommandSafeResultByKind[K];
}

function parseStoredResultReference<K extends AnyCoverageCommandKind>(
  kind: K,
  row: PresentStoredCoverageCommand,
): CoverageCommandResultReferenceByKind[K] {
  const expected = resultKindFor(kind);
  if (
    row.resultKind !== expected ||
    row.safeResultKind !==
      (kind === 'request_recheck' || kind === 'cancel_reservation'
        ? 'projection_with_case'
        : 'projection')
  ) {
    invalidJournal('result discriminator');
  }
  const exactReferenceColumns =
    expected === 'calculation'
      ? row.resultCalculationId !== null &&
        row.resultDecisionId === null &&
        row.resultCaseId === null
      : expected === 'decision'
        ? row.resultCalculationId === null &&
          row.resultDecisionId !== null &&
          row.resultCaseId === null
        : row.resultCalculationId === null &&
          row.resultDecisionId === null &&
          row.resultCaseId !== null;
  if (!exactReferenceColumns) invalidJournal('mixed result references');
  const reference =
    expected === 'calculation'
      ? {
          kind: 'calculation' as const,
          calculationId: requireOpaqueId(row.resultCalculationId, 'resultCalculationId'),
        }
      : expected === 'decision'
        ? {
            kind: 'decision' as const,
            decisionId: requireOpaqueId(row.resultDecisionId, 'resultDecisionId'),
          }
        : {
            kind: 'recheck_case' as const,
            caseId: requireOpaqueId(row.resultCaseId, 'resultCaseId'),
          };
  const safeResult = parseSafeResult(kind, row.safeResult);
  assertCaseSnapshotReference(kind, safeResult, reference);
  if (
    row.resultGeneration !== safeResult.generation ||
    row.resultStateVersion !== safeResult.stateVersion
  ) {
    invalidJournal('result version');
  }
  return reference as CoverageCommandResultReferenceByKind[K];
}

function parseResultReference<K extends AnyCoverageCommandKind>(
  kind: K,
  value: CoverageCommandResultReferenceByKind[K],
): CoverageCommandResultReferenceByKind[K] {
  const source = requireRecord(value, 'resultReference');
  const resultKind = resultKindFor(kind);
  if (source.kind !== resultKind) invalidJournal('resultReference kind');
  if (resultKind === 'calculation') {
    assertExactKeys(source, ['kind', 'calculationId']);
    return {
      kind: 'calculation',
      calculationId: requireOpaqueId(source.calculationId, 'calculationId'),
    } as CoverageCommandResultReferenceByKind[K];
  }
  if (resultKind === 'decision') {
    assertExactKeys(source, ['kind', 'decisionId']);
    return {
      kind: 'decision',
      decisionId: requireOpaqueId(source.decisionId, 'decisionId'),
    } as CoverageCommandResultReferenceByKind[K];
  }
  assertExactKeys(source, ['kind', 'caseId']);
  return {
    kind: 'recheck_case',
    caseId: requireOpaqueId(source.caseId, 'caseId'),
  } as CoverageCommandResultReferenceByKind[K];
}

function referenceColumnsFor(
  reference: CoverageCommandResultReferenceByKind[AnyCoverageCommandKind],
): {
  resultKind: string;
  resultCalculationId: string | null;
  resultDecisionId: string | null;
  resultCaseId: string | null;
} {
  if (reference.kind === 'calculation') {
    return {
      resultKind: reference.kind,
      resultCalculationId: reference.calculationId,
      resultDecisionId: null,
      resultCaseId: null,
    };
  }
  if (reference.kind === 'decision') {
    return {
      resultKind: reference.kind,
      resultCalculationId: null,
      resultDecisionId: reference.decisionId,
      resultCaseId: null,
    };
  }
  return {
    resultKind: reference.kind,
    resultCalculationId: null,
    resultDecisionId: null,
    resultCaseId: reference.caseId,
  };
}

function assertCaseSnapshotReference(
  kind: AnyCoverageCommandKind,
  safeResult: WarehouseCoverageProjection & { caseId?: string },
  reference: CoverageCommandResultReferenceByKind[AnyCoverageCommandKind],
): void {
  if (kind === 'request_recheck' || kind === 'cancel_reservation') {
    if (reference.kind !== 'recheck_case' || safeResult.caseId !== reference.caseId) {
      invalidJournal('caseId');
    }
  }
}

function resultKindFor(kind: AnyCoverageCommandKind): 'calculation' | 'decision' | 'recheck_case' {
  if (kind === 'refresh' || kind === 'resolve_recheck') return 'calculation';
  if (kind === 'decide') return 'decision';
  return 'recheck_case';
}

function parseFinanceRolls(value: unknown): FinanceCoverageRollProjection[] {
  if (!Array.isArray(value)) invalidJournal('financeRolls');
  return value.map((item) => {
    const row = requireRecord(item, 'financeRoll');
    if (hasExactKeys(row, ['rollCode', 'positionId'])) {
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
      return {
        rollCode: requireOpaqueId(row.rollCode, 'rollCode'),
        positionId: requireOpaqueId(row.positionId, 'positionId'),
        source: 'legacy',
        locationLabel: 'Складской резерв',
        availability: 'available',
        batchCode: null,
        receivedAt: null,
        grossKg: null,
        spoolKg: null,
        requested: { ...emptySpec },
        matched: { ...emptySpec },
      };
    }
    assertExactKeys(row, [
      'rollCode',
      'positionId',
      'source',
      'locationLabel',
      'availability',
      'batchCode',
      'receivedAt',
      'grossKg',
      'spoolKg',
      'requested',
      'matched',
    ]);
    return {
      rollCode: requireOpaqueId(row.rollCode, 'rollCode'),
      positionId: requireOpaqueId(row.positionId, 'positionId'),
      source: requireMember(row.source, WAREHOUSE_COVERAGE_ROLL_SOURCES, 'source'),
      locationLabel: requireOpaqueId(row.locationLabel, 'locationLabel'),
      availability: requireMember(
        row.availability,
        WAREHOUSE_COVERAGE_ROLL_AVAILABILITIES,
        'availability',
      ),
      batchCode: nullableOpaqueId(row.batchCode, 'batchCode'),
      receivedAt: row.receivedAt === null ? null : requireUtcIso(row.receivedAt, 'receivedAt'),
      grossKg: nullablePositiveNumber(row.grossKg, 'grossKg'),
      spoolKg: nullablePositiveNumber(row.spoolKg, 'spoolKg'),
      requested: parseFinanceRollSpecification(row.requested, 'requested'),
      matched: parseFinanceRollSpecification(row.matched, 'matched'),
    };
  });
}

function parseFinanceRollSpecification(
  value: unknown,
  field: string,
): FinanceCoverageRollProjection['requested'] {
  const spec = requireRecord(value, field);
  assertExactKeys(spec, [
    'filmType',
    'actualThicknessMicron',
    'accountingThicknessMicron',
    'widthMm',
    'plannedLengthM',
    'netKg',
    'spoolType',
    'birka',
    'materialLabel',
  ]);
  return {
    filmType: nullableOpaqueId(spec.filmType, `${field}.filmType`),
    actualThicknessMicron: nullablePositiveNumber(
      spec.actualThicknessMicron,
      `${field}.actualThicknessMicron`,
    ),
    accountingThicknessMicron: nullablePositiveNumber(
      spec.accountingThicknessMicron,
      `${field}.accountingThicknessMicron`,
    ),
    widthMm: nullablePositiveNumber(spec.widthMm, `${field}.widthMm`),
    plannedLengthM: nullablePositiveNumber(
      spec.plannedLengthM,
      `${field}.plannedLengthM`,
    ),
    netKg: nullablePositiveNumber(spec.netKg, `${field}.netKg`),
    spoolType: nullableOpaqueId(spec.spoolType, `${field}.spoolType`),
    birka: nullableOpaqueId(spec.birka, `${field}.birka`),
    materialLabel: nullableOpaqueId(spec.materialLabel, `${field}.materialLabel`),
  };
}

function assertRoutineActor(
  actor: CoverageCommandActor,
): asserts actor is Extract<CoverageCommandActor, { kind: 'user' }> {
  if (actor.kind !== 'user') {
    throw new BadRequestException('routine coverage command requires a user actor');
  }
  requireOpaqueId(actor.actorId, 'actorId');
}

function assertRecoveryActor(
  actor: CoverageCommandActor,
): asserts actor is Extract<CoverageCommandActor, { kind: 'system' }> {
  if (actor.kind !== 'system' || actor.systemActorKey !== 'warehouse_coverage_engine') {
    throw new BadRequestException('coverage recovery requires the exact system actor');
  }
}

function assertCanonicalClientRequestId(value: string): void {
  if (!CANONICAL_UUID.test(value)) {
    throw new BadRequestException('clientRequestId must be a canonical UUID');
  }
}

function commandKeyConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'warehouse_coverage_command_key_conflict',
    message: 'clientRequestId was already used for a different coverage command',
  });
}

function canonicalReason(value: string): string {
  if (typeof value !== 'string') throw new BadRequestException('reason is required');
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (result.length < 3 || result.length > 500) {
    throw new BadRequestException('reason must contain 3 to 500 characters');
  }
  return result;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidJournal(field);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (!hasExactKeys(value, expected)) {
    invalidJournal('unexpected keys');
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function requireOpaqueId(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /\p{C}/u.test(value)
  ) {
    invalidJournal(field);
  }
  return value;
}

function nullableOpaqueId(value: unknown, field: string): string | null {
  return value === null ? null : requireOpaqueId(value, field);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidJournal(field);
  return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidJournal(field);
  return value as number;
}

function nullablePositiveNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalidJournal(field);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalidJournal(field);
  return value;
}

function requireUtcIso(value: unknown, field: string): UtcIsoString {
  if (
    typeof value !== 'string' ||
    !value.endsWith('Z') ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalidJournal(field);
  }
  return value;
}

function requireMember<T extends string>(
  value: unknown,
  supported: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !supported.includes(value as T)) {
    invalidJournal(field);
  }
  return value as T;
}

function requireMemberArray<T extends string>(
  value: unknown,
  supported: readonly T[],
  field: string,
): T[] {
  if (!Array.isArray(value)) invalidJournal(field);
  return value.map((item) => requireMember(item, supported, field));
}

function invalidJournal(field: string): never {
  throw new InternalServerErrorException({
    statusCode: 500,
    code: 'warehouse_coverage_command_journal_invalid',
    message: `Stored coverage command is invalid: ${field}`,
  });
}
