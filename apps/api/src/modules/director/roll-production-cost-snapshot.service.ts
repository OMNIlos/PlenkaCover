import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PRODUCTION_COST_CALCULATION_VERSION,
  PRODUCTION_COST_UNRESOLVED_REASONS,
  type CorrectRollProductionCostInput,
  type PersistedRollProductionCostSnapshotView,
  type ProductionCostUnresolvedReason,
  type ProductionCostPayrollSource,
  type RollProductionCostPendingView,
  type RollProductionCostPlannedPreviewView,
  type RollProductionCostView,
} from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY } from '../../common/audit/audit-actor';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  calculateRollProductionCost,
  type RollProductionCostCalculation,
  type RollProductionCostCalculationInput,
} from '../../common/production-cost/production-cost-calculator';
import {
  buildProductionCostSourceSnapshot,
  type ProductionCostSourceSnapshotInput,
} from '../../common/production-cost/production-cost-source-snapshot';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE } from '../../common/payroll-tariffs/legacy-payroll-tariff-matrix';
import {
  evaluateRollProductionCostEligibility,
  type RollProductionCostEligibilityFact,
} from './roll-production-cost-eligibility';

export const ROLL_PRODUCTION_COST_ASSEMBLER = Symbol('ROLL_PRODUCTION_COST_ASSEMBLER');

export type PreparedRollProductionCost = {
  rollDispatchItemId: string;
  eligibility: RollProductionCostEligibilityFact | null;
  actualInput: RollProductionCostCalculationInput | null;
  pendingInput: RollProductionCostCalculationInput | null;
  plannedInput: RollProductionCostCalculationInput | null;
  sourceSnapshot: ProductionCostSourceSnapshotInput | null;
};

export interface RollProductionCostAssemblerPort {
  prepare(
    rollDispatchItemIds: readonly string[],
    generatedAt: Date,
  ): Promise<Map<string, PreparedRollProductionCost>>;
}

type SnapshotRow = {
  id: string;
  rollDispatchItemId: string;
  version: number;
  supersedesSnapshotId: string | null;
  operationKey: string;
  requestFingerprint: string;
  calculationFingerprint: string;
  calculationVersion: string;
  basis: string;
  basisWeightGrams: number;
  producedAt: Date;
  closedAt: Date;
  status: string;
  materialAmountKopecks: bigint | null;
  spoolAmountKopecks: bigint | null;
  payrollAmountKopecks: bigint | null;
  additionalAmountKopecks: bigint;
  totalAmountKopecks: bigint | null;
  totalKopecksPerKg: bigint | null;
  unresolvedReasons: Prisma.JsonValue;
  sourceSnapshot: Prisma.JsonValue;
  actorId: string | null;
  actorRole: string | null;
  systemActorKey: string | null;
  correctionReason: string | null;
  createdAt: Date;
};

const LEGACY_PAYROLL_POLICY_ID = 'order-8-09-25@2025-09-29';
const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new RangeError(`snapshot ${field} must be non-blank and trimmed`);
  }
  return value;
}

function snapshotKopecks(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`snapshot ${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function moscowDate(value: unknown, field: string): string {
  const instant = typeof value === 'string' ? new Date(value) : null;
  if (instant === null || !Number.isFinite(instant.getTime())) {
    throw new RangeError(`snapshot ${field} must be a finite timestamp`);
  }
  const parts = new Map(
    MOSCOW_DATE_FORMATTER.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function storedPayrollSource(sourceSnapshot: Prisma.JsonValue): ProductionCostPayrollSource | null {
  if (!isRecord(sourceSnapshot) || sourceSnapshot.payroll === null) return null;
  const payroll = sourceSnapshot.payroll;
  if (payroll === undefined) return null;
  if (!isRecord(payroll)) throw new RangeError('snapshot payroll provenance is invalid');

  const rateKopecksPerKg = snapshotKopecks(payroll.rateKopecksPerKg, 'payroll.rateKopecksPerKg');
  const basisLabel = snapshotText(payroll.basisLabel, 'payroll.basisLabel');
  if ('policyId' in payroll) {
    if (payroll.policyId !== LEGACY_PAYROLL_POLICY_ID) {
      throw new RangeError('unknown legacy payroll policy in production cost snapshot');
    }
    moscowDate(payroll.effectiveAt, 'payroll.effectiveAt');
    return {
      tariffOrderId: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
      tariffOrderName: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.name,
      effectiveFrom: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.effectiveFrom,
      rateKopecksPerKg,
      basisLabel,
    };
  }

  return {
    tariffOrderId: snapshotText(payroll.tariffOrderId, 'payroll.tariffOrderId'),
    tariffOrderName: snapshotText(payroll.tariffOrderName, 'payroll.tariffOrderName'),
    effectiveFrom: moscowDate(payroll.effectiveFrom, 'payroll.effectiveFrom'),
    rateKopecksPerKg,
    basisLabel,
  };
}

function calculatedPayrollSource(
  calculation: RollProductionCostCalculation | null,
): ProductionCostPayrollSource | null {
  const payroll = calculation?.payrollSource;
  if (payroll === null || payroll === undefined) return null;
  return {
    tariffOrderId: payroll.tariffOrderId,
    tariffOrderName: payroll.tariffOrderName,
    effectiveFrom: moscowDate(payroll.effectiveFrom.toISOString(), 'payroll.effectiveFrom'),
    rateKopecksPerKg: payroll.rateKopecksPerKg,
    basisLabel: payroll.basisLabel,
  };
}

function safeNumber(value: bigint | null, field: string): number | null {
  if (value === null) return null;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} is outside the safe integer range`);
  }
  return Number(value);
}

function unresolvedReasons(value: Prisma.JsonValue): ProductionCostUnresolvedReason[] {
  if (!Array.isArray(value)) throw new RangeError('snapshot unresolved reasons must be an array');
  const known = new Set<string>(PRODUCTION_COST_UNRESOLVED_REASONS);
  if (value.some((reason) => typeof reason !== 'string' || !known.has(reason))) {
    throw new RangeError('snapshot contains an unknown unresolved reason');
  }
  const canonical = PRODUCTION_COST_UNRESOLVED_REASONS.filter((reason) => value.includes(reason));
  if (
    canonical.length !== value.length ||
    canonical.some((reason, index) => value[index] !== reason)
  ) {
    throw new RangeError('snapshot unresolved reasons must be unique and canonically ordered');
  }
  return value as ProductionCostUnresolvedReason[];
}

function snapshotView(row: SnapshotRow): PersistedRollProductionCostSnapshotView {
  const reasons = unresolvedReasons(row.unresolvedReasons);
  const common = {
    kind: 'actual_snapshot' as const,
    calculationVersion: row.calculationVersion,
    snapshotId: row.id,
    version: row.version,
    producedAt: row.producedAt.toISOString(),
    closedAt: row.closedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    basis: { kind: 'actual' as const, weightGrams: row.basisWeightGrams },
    materialAmountKopecks: safeNumber(row.materialAmountKopecks, 'materialAmountKopecks'),
    spoolAmountKopecks: safeNumber(row.spoolAmountKopecks, 'spoolAmountKopecks'),
    payrollAmountKopecks: safeNumber(row.payrollAmountKopecks, 'payrollAmountKopecks'),
    payrollSource: storedPayrollSource(row.sourceSnapshot),
    additionalAmountKopecks: safeNumber(
      row.additionalAmountKopecks,
      'additionalAmountKopecks',
    ) as number,
    totalAmountKopecks: safeNumber(row.totalAmountKopecks, 'totalAmountKopecks'),
    totalKopecksPerKg: safeNumber(row.totalKopecksPerKg, 'totalKopecksPerKg'),
  };
  if (
    row.status === 'complete' &&
    reasons.length === 0 &&
    common.materialAmountKopecks !== null &&
    common.spoolAmountKopecks !== null &&
    common.payrollAmountKopecks !== null &&
    common.totalAmountKopecks !== null &&
    common.totalKopecksPerKg !== null
  ) {
    return {
      ...common,
      status: 'complete',
      materialAmountKopecks: common.materialAmountKopecks,
      spoolAmountKopecks: common.spoolAmountKopecks,
      payrollAmountKopecks: common.payrollAmountKopecks,
      totalAmountKopecks: common.totalAmountKopecks,
      totalKopecksPerKg: common.totalKopecksPerKg,
      unresolvedReasons: [],
    };
  }
  if (
    row.status === 'partial' &&
    reasons.length > 0 &&
    common.totalAmountKopecks === null &&
    common.totalKopecksPerKg === null
  ) {
    return {
      ...common,
      status: 'partial',
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: reasons as [
        ProductionCostUnresolvedReason,
        ...ProductionCostUnresolvedReason[],
      ],
    };
  }
  throw new RangeError('persisted production cost snapshot has an impossible state');
}

function orderedReasons(
  ...groups: readonly ProductionCostUnresolvedReason[][]
): ProductionCostUnresolvedReason[] {
  const present = new Set(groups.flat());
  return PRODUCTION_COST_UNRESOLVED_REASONS.filter((reason) => present.has(reason));
}

function pendingView(
  prepared: PreparedRollProductionCost | undefined,
): RollProductionCostPendingView {
  const eligibility = prepared?.eligibility
    ? evaluateRollProductionCostEligibility(prepared.eligibility)
    : null;
  const input = prepared?.pendingInput ?? prepared?.actualInput;
  const calculation = input ? calculateRollProductionCost(input) : null;
  const reasons = orderedReasons(
    eligibility?.unresolvedReasons ?? [],
    calculation?.unresolvedReasons ?? [],
    eligibility === null && calculation === null ? ['snapshot_pending'] : [],
  );
  if (reasons.length === 0) reasons.push('snapshot_pending');
  return {
    kind: 'actual_pending',
    status: 'pending',
    calculationVersion: PRODUCTION_COST_CALCULATION_VERSION,
    basis: {
      kind: 'actual',
      weightGrams: eligibility?.basisWeightGrams ?? calculation?.basis.weightGrams ?? null,
    },
    materialAmountKopecks: calculation?.materialAmountKopecks ?? null,
    spoolAmountKopecks: calculation?.spoolAmountKopecks ?? null,
    payrollAmountKopecks: calculation?.payrollAmountKopecks ?? null,
    payrollSource: calculatedPayrollSource(calculation),
    additionalAmountKopecks: calculation?.additionalAmountKopecks ?? 0,
    totalAmountKopecks: null,
    totalKopecksPerKg: null,
    unresolvedReasons: reasons as [
      ProductionCostUnresolvedReason,
      ...ProductionCostUnresolvedReason[],
    ],
  };
}

function plannedView(
  input: RollProductionCostCalculationInput,
): RollProductionCostPlannedPreviewView {
  const calculation = calculateRollProductionCost(input);
  if (
    calculation.status === 'complete' &&
    calculation.materialAmountKopecks !== null &&
    calculation.spoolAmountKopecks !== null &&
    calculation.payrollAmountKopecks !== null &&
    calculation.totalAmountKopecks !== null &&
    calculation.totalKopecksPerKg !== null
  ) {
    return {
      kind: 'planned_preview',
      status: 'complete',
      calculationVersion: PRODUCTION_COST_CALCULATION_VERSION,
      basis: { kind: 'planned', weightGrams: input.basis.weightGrams as number },
      materialAmountKopecks: calculation.materialAmountKopecks,
      spoolAmountKopecks: calculation.spoolAmountKopecks,
      payrollAmountKopecks: calculation.payrollAmountKopecks,
      payrollSource: calculatedPayrollSource(calculation),
      additionalAmountKopecks: calculation.additionalAmountKopecks,
      totalAmountKopecks: calculation.totalAmountKopecks,
      totalKopecksPerKg: calculation.totalKopecksPerKg,
      unresolvedReasons: [],
    };
  }
  const reasons =
    calculation.unresolvedReasons.length > 0
      ? calculation.unresolvedReasons
      : (['snapshot_pending'] as ProductionCostUnresolvedReason[]);
  return {
    kind: 'planned_preview',
    status: 'partial',
    calculationVersion: PRODUCTION_COST_CALCULATION_VERSION,
    basis: { kind: 'planned', weightGrams: input.basis.weightGrams as number },
    materialAmountKopecks: calculation.materialAmountKopecks,
    spoolAmountKopecks: calculation.spoolAmountKopecks,
    payrollAmountKopecks: calculation.payrollAmountKopecks,
    payrollSource: calculatedPayrollSource(calculation),
    additionalAmountKopecks: calculation.additionalAmountKopecks,
    totalAmountKopecks: null,
    totalKopecksPerKg: null,
    unresolvedReasons: reasons as [
      ProductionCostUnresolvedReason,
      ...ProductionCostUnresolvedReason[],
    ],
  };
}

function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

@Injectable()
export class RollProductionCostSnapshotService {
  private reconcileCursorId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ROLL_PRODUCTION_COST_ASSEMBLER)
    private readonly assembler: RollProductionCostAssemblerPort,
    private readonly audit: AuditService,
  ) {}

  async getViewsForRollIds(
    rollDispatchItemIds: readonly string[],
    generatedAt = new Date(),
  ): Promise<Map<string, RollProductionCostView>> {
    const ids = [...new Set(rollDispatchItemIds)].sort();
    if (ids.length === 0) return new Map();
    const latest = await this.findLatest(ids);
    const missing = ids.filter((id) => !latest.has(id));
    const prepared =
      missing.length === 0
        ? new Map<string, PreparedRollProductionCost>()
        : await this.assembler.prepare(missing, generatedAt);
    const result = new Map<string, RollProductionCostView>();
    for (const id of ids) {
      const stored = latest.get(id);
      if (stored) {
        result.set(id, snapshotView(stored));
        continue;
      }
      const inputs = prepared.get(id);
      result.set(
        id,
        inputs?.eligibility === null && inputs.plannedInput
          ? plannedView(inputs.plannedInput)
          : pendingView(inputs),
      );
    }
    return result;
  }

  async reconcileRollIds(rollDispatchItemIds: readonly string[], generatedAt = new Date()) {
    const ids = [...new Set(rollDispatchItemIds)].sort();
    const latest = await this.findLatest(ids);
    const mutableIds = ids.filter((id) => latest.get(id)?.status !== 'complete');
    if (mutableIds.length === 0) {
      return {
        attempted: ids.length,
        created: 0,
        unchanged: 0,
        ineligible: 0,
        skippedComplete: ids.length,
      };
    }
    const prepared = await this.assembler.prepare(mutableIds, generatedAt);
    const result = {
      attempted: ids.length,
      created: 0,
      unchanged: 0,
      ineligible: 0,
      skippedComplete: ids.length - mutableIds.length,
    };
    for (const id of mutableIds) {
      const inputs = prepared.get(id);
      if (!inputs?.eligibility || !inputs.actualInput || !inputs.sourceSnapshot) {
        result.ineligible += 1;
        continue;
      }
      const eligibility = evaluateRollProductionCostEligibility(inputs.eligibility);
      if (
        !eligibility.eligible ||
        eligibility.basisWeightGrams === null ||
        eligibility.producedAt === null ||
        eligibility.closedAt === null
      ) {
        result.ineligible += 1;
        continue;
      }
      const calculation = calculateRollProductionCost(inputs.actualInput);
      const sourceSnapshot = buildProductionCostSourceSnapshot(inputs.sourceSnapshot);
      const calculationFingerprint = requestFingerprint(jsonSafe({ calculation, sourceSnapshot }));
      const predecessor = latest.get(id);
      if (predecessor?.calculationFingerprint === calculationFingerprint) {
        result.unchanged += 1;
        continue;
      }
      try {
        await this.appendAutomatic(
          inputs,
          {
            ...eligibility,
            basisWeightGrams: eligibility.basisWeightGrams,
            producedAt: eligibility.producedAt,
            closedAt: eligibility.closedAt,
          },
          calculation,
          sourceSnapshot,
          calculationFingerprint,
          predecessor,
        );
        result.created += 1;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          result.unchanged += 1;
          continue;
        }
        throw error;
      }
    }
    return result;
  }

  async reconcileNextBatch(limit: number, generatedAt = new Date()) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('production cost reconcile batch must be between 1 and 1000');
    }
    const candidateWhere = {
      status: 'done',
      completedAt: { not: null },
      productionCostSnapshots: { none: { status: 'complete' } },
    } as const;
    const cursor = this.reconcileCursorId;
    const rows = await this.prisma.rollDispatchItem.findMany({
      where: cursor ? { ...candidateWhere, id: { gt: cursor } } : candidateWhere,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    if (cursor && rows.length < limit) {
      rows.push(
        ...(await this.prisma.rollDispatchItem.findMany({
          where: { ...candidateWhere, id: { lte: cursor } },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: limit - rows.length,
        })),
      );
    }
    const result = await this.reconcileRollIds(
      rows.map(({ id }) => id),
      generatedAt,
    );
    this.reconcileCursorId = rows.at(-1)?.id ?? null;
    return result;
  }

  async correct(
    actor: Actor,
    rollDispatchItemId: string,
    input: CorrectRollProductionCostInput,
    generatedAt = new Date(),
  ): Promise<PersistedRollProductionCostSnapshotView> {
    const actorId = actor.userId;
    if (!actorId) {
      throw new UnauthorizedException({
        code: 'PRODUCTION_COST_CORRECTION_USER_REQUIRED',
        message: 'Для исправления себестоимости требуется пользовательская сессия.',
      });
    }
    const rollId = rollDispatchItemId.trim();
    if (!rollId) {
      throw new BadRequestException({
        code: 'PRODUCTION_COST_ROLL_REQUIRED',
        message: 'Не указан рулон для исправления себестоимости.',
      });
    }
    const reason = input.reason.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!reason) {
      throw new BadRequestException({
        code: 'PRODUCTION_COST_CORRECTION_REASON_REQUIRED',
        message: 'Укажите причину исправления себестоимости.',
      });
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new BadRequestException({
        code: 'PRODUCTION_COST_EXPECTED_VERSION_INVALID',
        message: 'Версия себестоимости должна быть положительным целым числом.',
      });
    }
    const command = {
      operationKey: input.operationKey,
      rollDispatchItemId: rollId,
      expectedVersion: input.expectedVersion,
      reason,
    };
    const commandFingerprint = requestFingerprint(command);
    const existing = await this.findByOperationKey(this.prisma, command.operationKey);
    if (existing) return this.replayCorrection(existing, commandFingerprint);

    const prepared = (await this.assembler.prepare([rollId], generatedAt)).get(rollId);
    if (!prepared?.eligibility || !prepared.actualInput || !prepared.sourceSnapshot) {
      throw new ConflictException({
        code: 'PRODUCTION_COST_CORRECTION_INPUTS_UNRESOLVED',
        message: 'Не удалось собрать подтверждённые исходные данные себестоимости.',
      });
    }
    const eligibility = evaluateRollProductionCostEligibility(prepared.eligibility);
    if (
      !eligibility.eligible ||
      eligibility.basisWeightGrams === null ||
      eligibility.producedAt === null ||
      eligibility.closedAt === null
    ) {
      throw new ConflictException({
        code: 'PRODUCTION_COST_CORRECTION_ROLL_INELIGIBLE',
        message: 'Рулон ещё не соответствует условиям фиксации себестоимости.',
      });
    }
    const eligibleFacts = {
      basisWeightGrams: eligibility.basisWeightGrams,
      producedAt: eligibility.producedAt,
      closedAt: eligibility.closedAt,
    } as const;
    const calculation = calculateRollProductionCost(prepared.actualInput);
    const sourceSnapshot = buildProductionCostSourceSnapshot(prepared.sourceSnapshot);
    const calculationFingerprint = requestFingerprint(jsonSafe({ calculation, sourceSnapshot }));

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.findByOperationKey(tx, command.operationKey);
        if (replay) return this.replayCorrection(replay, commandFingerprint);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "roll_production_cost_snapshots"
          WHERE "rollDispatchItemId" = ${rollId}
          ORDER BY "version" DESC
          LIMIT 1
          FOR UPDATE
        `);
        const concurrentReplay = await this.findByOperationKey(tx, command.operationKey);
        if (concurrentReplay) return this.replayCorrection(concurrentReplay, commandFingerprint);
        const predecessor = (await tx.rollProductionCostSnapshot.findFirst({
          where: { rollDispatchItemId: rollId },
          orderBy: { version: 'desc' },
        })) as SnapshotRow | null;
        if (!predecessor) {
          throw new NotFoundException({
            code: 'PRODUCTION_COST_SNAPSHOT_NOT_FOUND',
            message: 'Зафиксированная себестоимость рулона не найдена.',
          });
        }
        if (predecessor.version !== command.expectedVersion) {
          throw new ConflictException({
            code: 'PRODUCTION_COST_VERSION_CONFLICT',
            message: 'Версия себестоимости изменилась. Обновите данные и повторите действие.',
          });
        }
        const version = predecessor.version + 1;
        const created = (await tx.rollProductionCostSnapshot.create({
          data: {
            rollDispatchItemId: rollId,
            version,
            supersedesSnapshotId: predecessor.id,
            operationKey: command.operationKey,
            requestFingerprint: commandFingerprint,
            calculationFingerprint,
            calculationVersion: PRODUCTION_COST_CALCULATION_VERSION,
            basis: 'actual',
            basisWeightGrams: eligibleFacts.basisWeightGrams,
            producedAt: eligibleFacts.producedAt,
            closedAt: eligibleFacts.closedAt,
            status: calculation.status,
            materialAmountKopecks:
              calculation.materialAmountKopecks === null
                ? null
                : BigInt(calculation.materialAmountKopecks),
            spoolAmountKopecks:
              calculation.spoolAmountKopecks === null
                ? null
                : BigInt(calculation.spoolAmountKopecks),
            payrollAmountKopecks:
              calculation.payrollAmountKopecks === null
                ? null
                : BigInt(calculation.payrollAmountKopecks),
            additionalAmountKopecks: BigInt(calculation.additionalAmountKopecks),
            totalAmountKopecks:
              calculation.totalAmountKopecks === null
                ? null
                : BigInt(calculation.totalAmountKopecks),
            totalKopecksPerKg:
              calculation.totalKopecksPerKg === null ? null : BigInt(calculation.totalKopecksPerKg),
            unresolvedReasons: calculation.unresolvedReasons,
            sourceSnapshot: sourceSnapshot as Prisma.InputJsonValue,
            actorId,
            actorRole: actor.role,
            systemActorKey: null,
            correctionReason: reason,
          },
        })) as SnapshotRow;
        await this.audit.record(
          {
            type: 'audit:roll_production_cost_corrected',
            actorRole: actor.role,
            actorId,
            objectId: rollId,
            sourceSnapshotId: created.id,
            reason,
            oldValue: {
              snapshotId: predecessor.id,
              version: predecessor.version,
              status: predecessor.status,
              calculationFingerprint: predecessor.calculationFingerprint,
            },
            newValue: {
              snapshotId: created.id,
              version,
              status: calculation.status,
              calculationFingerprint,
            },
          },
          tx,
        );
        return snapshotView(created);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByOperationKey(this.prisma, command.operationKey);
        if (winner) return this.replayCorrection(winner, commandFingerprint);
        throw new ConflictException({
          code: 'PRODUCTION_COST_CORRECTION_CONFLICT',
          message: 'Себестоимость была изменена конкурентной операцией.',
        });
      }
      throw error;
    }
  }

  fingerprintPreparedForTest(inputs: PreparedRollProductionCost): string {
    if (!inputs.actualInput || !inputs.sourceSnapshot) throw new Error('actual inputs required');
    const calculation = calculateRollProductionCost(inputs.actualInput);
    const sourceSnapshot = buildProductionCostSourceSnapshot(inputs.sourceSnapshot);
    return requestFingerprint(jsonSafe({ calculation, sourceSnapshot }));
  }

  private async findLatest(ids: readonly string[]): Promise<Map<string, SnapshotRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<SnapshotRow[]>(Prisma.sql`
      SELECT DISTINCT ON ("rollDispatchItemId") *
      FROM "roll_production_cost_snapshots"
      WHERE "rollDispatchItemId" IN (${Prisma.join(ids)})
      ORDER BY "rollDispatchItemId", "version" DESC
      LIMIT ${ids.length}
    `);
    if (rows.length > ids.length) {
      throw new RangeError('latest production cost snapshot query exceeded its roll-id bound');
    }
    const latest = new Map<string, SnapshotRow>();
    for (const row of rows) {
      if (!latest.has(row.rollDispatchItemId)) latest.set(row.rollDispatchItemId, row);
    }
    return latest;
  }

  private findByOperationKey(
    client: Pick<Prisma.TransactionClient, 'rollProductionCostSnapshot'>,
    operationKey: string,
  ) {
    return client.rollProductionCostSnapshot.findUnique({
      where: { operationKey },
    }) as Promise<SnapshotRow | null>;
  }

  private replayCorrection(
    row: SnapshotRow,
    commandFingerprint: string,
  ): PersistedRollProductionCostSnapshotView {
    if (row.requestFingerprint !== commandFingerprint || row.systemActorKey !== null) {
      throw new ConflictException({
        code: 'PRODUCTION_COST_CORRECTION_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже использован для другого снимка себестоимости.',
      });
    }
    return snapshotView(row);
  }

  private async appendAutomatic(
    inputs: PreparedRollProductionCost,
    eligibility: ReturnType<typeof evaluateRollProductionCostEligibility> & {
      basisWeightGrams: number;
      producedAt: Date;
      closedAt: Date;
    },
    calculation: RollProductionCostCalculation,
    sourceSnapshot: ReturnType<typeof buildProductionCostSourceSnapshot>,
    calculationFingerprint: string,
    predecessor: SnapshotRow | undefined,
  ): Promise<void> {
    const operationKey = randomUUID();
    const version = (predecessor?.version ?? 0) + 1;
    const fingerprint = requestFingerprint({
      operationKey,
      rollDispatchItemId: inputs.rollDispatchItemId,
      version,
      calculationFingerprint,
    });
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.rollProductionCostSnapshot.create({
        data: {
          rollDispatchItemId: inputs.rollDispatchItemId,
          version,
          supersedesSnapshotId: predecessor?.id ?? null,
          operationKey,
          requestFingerprint: fingerprint,
          calculationFingerprint,
          calculationVersion: PRODUCTION_COST_CALCULATION_VERSION,
          basis: 'actual',
          basisWeightGrams: eligibility.basisWeightGrams,
          producedAt: eligibility.producedAt,
          closedAt: eligibility.closedAt,
          status: calculation.status,
          materialAmountKopecks:
            calculation.materialAmountKopecks === null
              ? null
              : BigInt(calculation.materialAmountKopecks),
          spoolAmountKopecks:
            calculation.spoolAmountKopecks === null ? null : BigInt(calculation.spoolAmountKopecks),
          payrollAmountKopecks:
            calculation.payrollAmountKopecks === null
              ? null
              : BigInt(calculation.payrollAmountKopecks),
          additionalAmountKopecks: BigInt(calculation.additionalAmountKopecks),
          totalAmountKopecks:
            calculation.totalAmountKopecks === null ? null : BigInt(calculation.totalAmountKopecks),
          totalKopecksPerKg:
            calculation.totalKopecksPerKg === null ? null : BigInt(calculation.totalKopecksPerKg),
          unresolvedReasons: calculation.unresolvedReasons,
          sourceSnapshot: sourceSnapshot as Prisma.InputJsonValue,
          actorId: null,
          actorRole: null,
          systemActorKey: PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY,
          correctionReason: null,
        },
      });
      await this.audit.record(
        {
          type: 'audit:roll_production_cost_snapshotted',
          actor: {
            kind: 'system',
            systemActorKey: PRODUCTION_COST_RECONCILER_SYSTEM_ACTOR_KEY,
          },
          objectId: inputs.rollDispatchItemId,
          sourceSnapshotId: created.id,
          newValue: {
            snapshotId: created.id,
            version,
            status: calculation.status,
            calculationFingerprint,
          },
        },
        tx,
      );
    });
  }
}

export class RollProductionCostSnapshotReconciler {
  private active?: ReturnType<RollProductionCostSnapshotService['reconcileNextBatch']>;

  constructor(
    private readonly snapshots: RollProductionCostSnapshotService,
    private readonly batchSize: number,
  ) {}

  reconcileNow(generatedAt = new Date()) {
    if (this.active) return this.active;
    const active = this.snapshots.reconcileNextBatch(this.batchSize, generatedAt).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    this.active = active;
    return active;
  }
}
