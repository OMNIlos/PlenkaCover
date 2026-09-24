import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import type { Role } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { resolveCanonicalRollCaptures } from '../../common/weight-capture/canonical-roll-capture';
import {
  canonicalDimension,
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  parseKgToMilliKg,
  parseThicknessMilliMicron,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
  type CanonicalRollCoverageSpec,
} from './warehouse-coverage-canonical';

export const WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION = 'warehouse-roll-coverage/v1';

const PRODUCTION_FACT_DISPATCH_SELECT = {
  id: true,
  rollCode: true,
  orderLineId: true,
  widthMm: true,
  plannedLengthM: true,
  plannedWeightKg: true,
  recipeVersion: true,
  createdAt: true,
  characteristicsSnapshot: true,
  productionOrder: {
    select: {
      commercialOrderId: true,
      sourceCoverageCalculationId: true,
      sourceCoverageDecisionId: true,
      sourceCoverageInputFingerprint: true,
      sourceCoverageGeneration: true,
      sourceCoverageCalculation: {
        select: {
          id: true,
          orderId: true,
          generation: true,
          positionVersions: true,
          inputFingerprint: true,
        },
      },
      sourceCoverageDecision: {
        select: {
          id: true,
          orderId: true,
          calculationId: true,
          generation: true,
          kind: true,
          inputFingerprint: true,
        },
      },
      commercialOrder: {
        select: {
          counterpartyId: true,
          positions: {
            select: {
              id: true,
              orderId: true,
              widthMm: true,
              plannedLengthM: true,
              version: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  },
  operatorLine: {
    select: {
      id: true,
      weightCaptures: {
        select: {
          id: true,
          operatorRollLineId: true,
          kind: true,
          stable: true,
          netKg: true,
          actorRole: true,
          actorId: true,
          supersedesCaptureId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  },
} satisfies Prisma.RollDispatchItemSelect;

type ProductionFactDispatch = Prisma.RollDispatchItemGetPayload<{
  select: typeof PRODUCTION_FACT_DISPATCH_SELECT;
}>;

const CURRENT_ROLL_SELECT = {
  id: true,
  rollCode: true,
  ownerCounterpartyId: true,
  currentCoverageFactId: true,
  currentCoverageFact: { select: { id: true, version: true } },
} satisfies Prisma.WarehouseRollSelect;

export interface AppendProductionFactInput {
  rollId: string;
  sourceDispatchItemId: string;
  sourceWeightCaptureId: string | null;
}

export interface CanonicalWarehouseFactCorrection {
  rollId: string;
  expectedFactVersion: number | null;
  nextSpec: CanonicalRollCoverageSpec;
  reason: string;
}

@Injectable()
export class WarehouseRollCoverageFactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Keep production provenance and append a new ownership fact; never rewrite the handover. */
  async releaseCancelledOrderRolls(
    tx: Prisma.TransactionClient,
    orderId: string,
    actor: { userId: string | null; role: Role },
    reason: string,
    rollCode?: string,
  ): Promise<void> {
    const order = await tx.commercialOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { cancellationStatus: true, requestType: true },
    });
    if (order.cancellationStatus !== 'cancelled' || order.requestType === 'stock_reserve') return;
    const dispatches = await tx.rollDispatchItem.findMany({
      where: { productionOrder: { commercialOrderId: orderId }, ...(rollCode ? { rollCode } : {}) },
      select: { rollCode: true },
    });
    const rolls = await tx.warehouseRoll.findMany({
      where: {
        rollCode: { in: dispatches.map((row) => row.rollCode) },
        releasedFromOrderId: null,
        warehouseStatus: { in: ['sent', 'received'] },
      },
      include: { currentCoverageFact: true },
      orderBy: { id: 'asc' },
    });
    for (const roll of rolls) {
      await this.lockRoll(tx, roll.id);
      if (roll.reservedForOrderId && roll.reservedForOrderId !== orderId) {
        throw this.factConflict('Готовый рулон уже зарезервирован другим заказом.');
      }
      const previous = roll.currentCoverageFact;
      let factId: string | null = null;
      if (previous) {
        const oldSpec = canonicalizeRollCoverageSpec(previous.spec);
        if (
          oldSpec.sourceOrderId !== orderId ||
          fingerprintRollFact(oldSpec) !== previous.specFingerprint
        ) {
          throw this.factConflict('Источник готового рулона не совпадает с отменяемым заказом.');
        }
        const spec = canonicalizeRollCoverageSpec({ ...oldSpec, ownerCounterpartyId: null });
        const fact = await tx.warehouseRollCoverageFact.create({
          data: {
            rollId: roll.id,
            version: previous.version + 1,
            source: 'order_cancellation',
            specVersion: WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION,
            specFingerprint: fingerprintRollFact(spec),
            spec: spec as unknown as Prisma.InputJsonValue,
            sourceOrderId: spec.sourceOrderId,
            sourcePositionId: spec.sourcePositionId,
            actorKind: 'user',
            actorRole: actor.role,
            actorId: actor.userId,
            reason,
          },
          select: { id: true },
        });
        factId = fact.id;
      }
      await tx.warehouseRoll.update({
        where: { id: roll.id },
        data: {
          ownerCounterpartyId: null,
          releasedFromOrderId: orderId,
          currentCoverageFactId: factId,
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByProposalId: null,
          reservedByCoverageDecisionId: null,
          reservedAt: null,
        },
      });
      await this.audit.record(
        {
          type: 'audit:finished_stock_released_from_cancelled_order',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: roll.id,
          reason,
          oldValue: {
            ownerCounterpartyId: roll.ownerCounterpartyId,
            factId: roll.currentCoverageFactId,
          },
          newValue: { ownerCounterpartyId: null, factId },
          detail: { orderId, rollCode: roll.rollCode, warehouseStatus: roll.warehouseStatus },
        },
        tx,
      );
    }
  }

  async appendProductionHandoverFact(
    tx: Prisma.TransactionClient,
    input: AppendProductionFactInput,
  ): Promise<{ factId: string; version: number } | null> {
    await this.lockDispatch(tx, input.sourceDispatchItemId);
    const dispatch = await tx.rollDispatchItem.findUnique({
      where: { id: input.sourceDispatchItemId },
      select: PRODUCTION_FACT_DISPATCH_SELECT,
    });
    if (!dispatch) throw this.factConflict('Исходный производственный рулон не найден.');

    await this.lockRoll(tx, input.rollId);
    const roll = await tx.warehouseRoll.findUnique({
      where: { id: input.rollId },
      select: CURRENT_ROLL_SELECT,
    });
    if (!roll || roll.rollCode !== dispatch.rollCode) {
      throw this.factConflict('Источник покрытия не принадлежит указанному складскому рулону.');
    }

    const existing = await tx.warehouseRollCoverageFact.findUnique({
      where: { sourceDispatchItemId: input.sourceDispatchItemId },
      select: {
        id: true,
        rollId: true,
        version: true,
        sourceDispatchItemId: true,
        sourceWeightCaptureId: true,
        specFingerprint: true,
        spec: true,
      },
    });
    if (existing) {
      if (
        existing.rollId !== input.rollId ||
        existing.sourceWeightCaptureId !== input.sourceWeightCaptureId
      ) {
        throw this.factConflict(
          'Производственный источник уже использован с другим фактом покрытия.',
        );
      }
    }
    const spec = productionFactSpec(
      dispatch,
      input.sourceWeightCaptureId,
      existing ? replayFactDimensions(existing, dispatch) : null,
    );
    if (existing) {
      if (!spec || existing.specFingerprint !== fingerprintRollFact(spec)) {
        throw this.factConflict(
          'Производственный источник уже использован с другим фактом покрытия.',
        );
      }
      return { factId: existing.id, version: existing.version };
    }

    if (!spec) {
      await this.clearUnknownFact(tx, roll);
      return null;
    }
    if (roll.currentCoverageFactId !== null) {
      throw this.factConflict('У рулона уже существует другой актуальный факт покрытия.');
    }

    const fingerprint = fingerprintRollFact(spec);
    const canonicalCapture = canonicalProductionCapture(dispatch, input.sourceWeightCaptureId);
    if (!canonicalCapture?.actorId || canonicalCapture.actorRole !== 'operator') {
      await this.clearUnknownFact(tx, roll);
      return null;
    }

    const fact = await tx.warehouseRollCoverageFact.create({
      data: {
        rollId: input.rollId,
        version: 1,
        source: 'production_handover',
        specVersion: WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION,
        specFingerprint: fingerprint,
        spec: spec as unknown as Prisma.InputJsonValue,
        sourceOrderId: spec.sourceOrderId,
        sourcePositionId: spec.sourcePositionId,
        sourceDispatchItemId: input.sourceDispatchItemId,
        sourceWeightCaptureId: input.sourceWeightCaptureId,
        actorKind: 'user',
        actorRole: canonicalCapture.actorRole,
        actorId: canonicalCapture.actorId,
        systemActorKey: null,
        reason: null,
      },
      select: { id: true, version: true },
    });
    const switched = await tx.warehouseRoll.updateMany({
      where: { id: input.rollId, currentCoverageFactId: null },
      data: {
        ownerCounterpartyId: spec.ownerCounterpartyId,
        currentCoverageFactId: fact.id,
      },
    });
    if (switched.count !== 1) {
      throw this.factConflict('Актуальный факт рулона изменился конкурентно.');
    }
    return { factId: fact.id, version: fact.version };
  }

  async appendWarehouseCorrection(
    tx: Prisma.TransactionClient,
    input: CanonicalWarehouseFactCorrection,
    actor: Actor,
  ): Promise<{ factId: string; version: number }> {
    this.assertWarehouseCorrectionActor(actor);
    this.assertCorrectionReason(input.reason);
    const spec = this.canonicalCorrectionSpec(input.nextSpec);

    await this.lockRoll(tx, input.rollId);
    const roll = await tx.warehouseRoll.findUnique({
      where: { id: input.rollId },
      select: CURRENT_ROLL_SELECT,
    });
    if (!roll || roll.rollCode !== spec.rollCode) {
      throw this.factConflict('Исправляемый факт не принадлежит указанному рулону.');
    }
    const actualVersion = roll.currentCoverageFact?.version ?? null;
    if (actualVersion !== input.expectedFactVersion) {
      throw this.factConflict('Версия факта покрытия изменилась. Обновите перепроверку.');
    }

    const latestFact = await tx.warehouseRollCoverageFact.aggregate({
      where: { rollId: input.rollId },
      _max: { version: true },
    });
    const version = (latestFact._max.version ?? 0) + 1;
    const fact = await tx.warehouseRollCoverageFact.create({
      data: {
        rollId: input.rollId,
        version,
        source: 'warehouse_recheck',
        specVersion: WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION,
        specFingerprint: fingerprintRollFact(spec),
        spec: spec as unknown as Prisma.InputJsonValue,
        sourceOrderId: spec.sourceOrderId,
        sourcePositionId: spec.sourcePositionId,
        sourceDispatchItemId: null,
        sourceWeightCaptureId: null,
        actorKind: 'user',
        actorRole: actor.role,
        actorId: actor.userId,
        systemActorKey: null,
        reason: input.reason,
      },
      select: { id: true, version: true },
    });
    const switched = await tx.warehouseRoll.updateMany({
      where: {
        id: input.rollId,
        currentCoverageFactId: roll.currentCoverageFactId,
      },
      data: {
        ownerCounterpartyId: spec.ownerCounterpartyId,
        currentCoverageFactId: fact.id,
      },
    });
    if (switched.count !== 1) {
      throw this.factConflict('Актуальный факт рулона изменился конкурентно.');
    }

    await this.audit.record(
      {
        type: 'audit:warehouse_roll_coverage_fact_corrected',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: input.rollId,
        reason: input.reason,
        oldValue: {
          factId: roll.currentCoverageFactId,
          version: actualVersion,
          ownerCounterpartyId: roll.ownerCounterpartyId,
        },
        newValue: {
          factId: fact.id,
          version: fact.version,
          ownerCounterpartyId: spec.ownerCounterpartyId,
        },
        detail: {
          workflowVersion: 2,
          specFingerprint: fingerprintRollFact(spec),
          sourceOrderId: spec.sourceOrderId,
          sourcePositionId: spec.sourcePositionId,
        },
      },
      tx,
    );
    return { factId: fact.id, version: fact.version };
  }

  private async lockRoll(tx: Prisma.TransactionClient, rollId: string): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "warehouse_rolls" WHERE "id" = ${rollId} FOR UPDATE`,
    );
  }

  private async lockDispatch(
    tx: Prisma.TransactionClient,
    sourceDispatchItemId: string,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
                 WHERE "id" = ${sourceDispatchItemId} FOR UPDATE`,
    );
  }

  private async clearUnknownFact(
    tx: Prisma.TransactionClient,
    roll: Prisma.WarehouseRollGetPayload<{ select: typeof CURRENT_ROLL_SELECT }>,
  ): Promise<void> {
    if (roll.currentCoverageFactId === null) return;
    const cleared = await tx.warehouseRoll.updateMany({
      where: { id: roll.id, currentCoverageFactId: roll.currentCoverageFactId },
      data: { currentCoverageFactId: null },
    });
    if (cleared.count !== 1) {
      throw this.factConflict('Актуальный факт рулона изменился конкурентно.');
    }
  }

  private canonicalCorrectionSpec(spec: CanonicalRollCoverageSpec): CanonicalRollCoverageSpec {
    try {
      return canonicalizeRollCoverageSpec(spec);
    } catch {
      throw this.factConflict('Исправление должно содержать один полный канонический факт.');
    }
  }

  private assertWarehouseCorrectionActor(actor: Actor): void {
    if (actor.role !== 'warehouse' || !actor.userId) {
      throw this.factConflict('Исправлять факт покрытия может только сотрудник склада.');
    }
  }

  private assertCorrectionReason(reason: string): void {
    if (reason !== reason.trim() || reason.length < 3 || reason.length > 500) {
      throw this.factConflict('Для исправления нужна полная причина длиной от 3 до 500 символов.');
    }
  }

  private factConflict(message: string): ConflictException {
    return new ConflictException({
      code: 'WAREHOUSE_ROLL_COVERAGE_FACT_CONFLICT',
      message,
    });
  }
}

function productionFactSpec(
  dispatch: ProductionFactDispatch,
  sourceWeightCaptureId: string | null,
  replayDimensions: { widthMm: number; plannedLengthM: number } | null = null,
): CanonicalRollCoverageSpec | null {
  const capture = canonicalProductionCapture(dispatch, sourceWeightCaptureId);
  const snapshot = record(dispatch.characteristicsSnapshot);
  const commercial = dispatch.productionOrder.commercialOrder;
  if (
    !capture ||
    capture.netKg === null ||
    !snapshot ||
    !commercial ||
    !dispatch.orderLineId ||
    dispatch.plannedWeightKg === null
  ) {
    return null;
  }

  const recipe = record(snapshot.recipe);
  const ingredients = recipeIngredients(snapshot, recipe);
  if (!ingredients) return null;
  const recipeDefinitionId = firstDefined(snapshot.recipeDefinitionId, recipe?.recipeDefinitionId);
  const recipeDefinitionVersionId = firstDefined(
    snapshot.recipeDefinitionVersionId,
    recipe?.recipeDefinitionVersionId,
  );
  const recipeVersionNumber = firstDefined(
    snapshot.recipeVersionNumber,
    recipe?.recipeVersionNumber,
    recipe?.version,
  );
  if (!recipeVersionMatchesNumber(dispatch.recipeVersion, recipeVersionNumber)) return null;
  const unchangedSourcePosition = findUnchangedSourcePosition(dispatch);

  try {
    return canonicalizeRollCoverageSpec({
      rollCode: dispatch.rollCode,
      sourceOrderId: dispatch.productionOrder.commercialOrderId,
      sourcePositionId: dispatch.orderLineId,
      ownerCounterpartyId: commercial.counterpartyId,
      filmType: snapshot.filmType,
      actualThicknessMilliMicron: parseThicknessMilliMicron(
        requireString(snapshot.actualThickness),
      ),
      accountingThicknessMilliMicron: parseThicknessMilliMicron(
        requireString(snapshot.accountingThickness),
      ),
      widthMilliMm: requireCompatibleDimension(
        snapshot.widthMm,
        dispatch.widthMm,
        unchangedSourcePosition?.widthMm,
        replayDimensions?.widthMm,
      ),
      plannedLengthMilliM: requireCompatibleDimension(
        snapshot.plannedLengthM,
        dispatch.plannedLengthM,
        unchangedSourcePosition?.plannedLengthM,
        replayDimensions?.plannedLengthM,
      ),
      birka: snapshot.birka,
      spoolType: snapshot.spoolType,
      actualWeightMilliKg: parseKgToMilliKg(String(capture.netKg)),
      plannedWeightMilliKg: parseKgToMilliKg(String(dispatch.plannedWeightKg)),
      ingredients,
      recipeId: nullableString(firstDefined(snapshot.recipeId, recipe?.id)),
      recipeVersion: nullableString(dispatch.recipeVersion),
      recipeDefinitionId: nullableString(recipeDefinitionId),
      recipeDefinitionVersionId: nullableString(recipeDefinitionVersionId),
      recipeVersionNumber,
      policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
    });
  } catch {
    return null;
  }
}

function replayFactDimensions(
  existing: {
    spec: Prisma.JsonValue;
    specFingerprint: string;
  },
  dispatch: ProductionFactDispatch,
): { widthMm: number; plannedLengthM: number } | null {
  try {
    const spec = canonicalizeRollCoverageSpec(existing.spec);
    if (
      fingerprintRollFact(spec) !== existing.specFingerprint ||
      spec.rollCode !== dispatch.rollCode ||
      spec.sourceOrderId !== dispatch.productionOrder.commercialOrderId ||
      spec.sourcePositionId !== dispatch.orderLineId
    ) {
      return null;
    }
    return {
      widthMm: spec.widthMilliMm / 1_000,
      plannedLengthM: spec.plannedLengthMilliM / 1_000,
    };
  } catch {
    return null;
  }
}

function findUnchangedSourcePosition(dispatch: ProductionFactDispatch) {
  if (!dispatch.orderLineId) return null;
  const calculation = exactLegacyDimensionProvenance(dispatch);
  if (!calculation) return null;
  const position = dispatch.productionOrder.commercialOrder.positions.find(
    (candidate) => candidate.id === dispatch.orderLineId,
  );
  const expectedVersion = sourcePositionVersion(calculation.positionVersions, dispatch.orderLineId);
  if (
    !position ||
    position.orderId !== dispatch.productionOrder.commercialOrderId ||
    expectedVersion === null ||
    position.version !== expectedVersion
  ) {
    return null;
  }
  const sourceUpdatedAt = position.updatedAt.getTime();
  const dispatchCreatedAt = dispatch.createdAt.getTime();
  if (
    !Number.isFinite(sourceUpdatedAt) ||
    !Number.isFinite(dispatchCreatedAt) ||
    sourceUpdatedAt > dispatchCreatedAt
  ) {
    return null;
  }
  return position;
}

function exactLegacyDimensionProvenance(dispatch: ProductionFactDispatch) {
  const production = dispatch.productionOrder;
  const calculation = production.sourceCoverageCalculation;
  const decision = production.sourceCoverageDecision;
  const fingerprint = production.sourceCoverageInputFingerprint;
  const generation = production.sourceCoverageGeneration;
  if (
    !calculation ||
    !decision ||
    !production.sourceCoverageCalculationId ||
    !production.sourceCoverageDecisionId ||
    !fingerprint ||
    generation === null ||
    production.sourceCoverageCalculationId !== calculation.id ||
    production.sourceCoverageDecisionId !== decision.id ||
    production.commercialOrderId !== calculation.orderId ||
    production.commercialOrderId !== decision.orderId ||
    decision.calculationId !== calculation.id ||
    generation !== calculation.generation ||
    generation !== decision.generation ||
    fingerprint !== calculation.inputFingerprint ||
    fingerprint !== decision.inputFingerprint ||
    (decision.kind !== 'produce_all' && decision.kind !== 'auto_produce_all')
  ) {
    return null;
  }
  return calculation;
}

function sourcePositionVersion(positionVersions: Prisma.JsonValue | undefined, positionId: string) {
  if (!Array.isArray(positionVersions)) return null;
  const matches = positionVersions.filter((value) => {
    const candidate = record(value);
    return candidate?.positionId === positionId;
  });
  if (matches.length !== 1) return null;
  const version = record(matches[0])?.version;
  return Number.isSafeInteger(version) && (version as number) > 0 ? (version as number) : null;
}

function requireCompatibleDimension(
  snapshotValue: unknown,
  dispatchValue: unknown,
  unchangedSourceValue: unknown,
  replayValue: unknown,
): number {
  const canonical = [snapshotValue, dispatchValue, unchangedSourceValue, replayValue]
    .filter((value) => value !== null && value !== undefined)
    .map(requireCanonicalDimension);
  const first = canonical[0];
  if (first === undefined || canonical.some((value) => value !== first)) {
    throw new Error('dimension evidence must be complete and consistent');
  }
  return first;
}

function requireCanonicalDimension(value: unknown): number {
  const canonical = canonicalDimension(value);
  if (canonical === null) throw new Error('frozen dimension must be positive and finite');
  return canonical;
}

function canonicalProductionCapture(
  dispatch: ProductionFactDispatch,
  sourceWeightCaptureId: string | null,
) {
  const line = dispatch.operatorLine;
  if (!line || sourceWeightCaptureId === null) return null;
  const eligibleRoots = line.weightCaptures.filter(
    (capture) =>
      capture.operatorRollLineId === line.id &&
      capture.kind === 'roll' &&
      capture.stable &&
      capture.netKg !== null &&
      capture.supersedesCaptureId === null,
  );
  if (eligibleRoots.length !== 1) return null;
  const canonical = resolveCanonicalRollCaptures(line.weightCaptures).filter(
    (capture) => capture.operatorRollLineId === line.id,
  );
  return canonical.length === 1 && canonical[0]?.id === sourceWeightCaptureId ? canonical[0] : null;
}

function recipeIngredients(
  snapshot: Record<string, unknown>,
  recipe: Record<string, unknown> | null,
): Array<{ rawMaterialDefinitionId: unknown; shareBasisPoints: unknown }> | null {
  const source = snapshot.ingredients ?? recipe?.ingredients;
  if (!Array.isArray(source) || source.length === 0) return null;
  return source.map((entry) => {
    const ingredient = record(entry);
    return {
      rawMaterialDefinitionId: ingredient?.rawMaterialDefinitionId,
      shareBasisPoints: ingredient?.shareBasisPoints,
    };
  });
}

function recipeVersionMatchesNumber(recipeVersion: string | null, version: unknown): boolean {
  if (version === null) return true;
  if (!Number.isSafeInteger(version) || (version as number) <= 0) return false;
  if (recipeVersion === null) return false;
  const match = /^v([1-9]\d*)$/u.exec(recipeVersion);
  return match !== null && Number(match[1]) === version;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('frozen field must be a string');
  return value;
}

function nullableString(value: unknown): unknown {
  return value === undefined ? null : value;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined) ?? null;
}
