import {
  validateAllocationDenominator,
  validateProductionOrderSeal,
  type AllocationDenominator,
  type ProductionOrderSealProof,
} from './production-cost-calculator';

type RecipeSnapshotMaterialSourceInput = {
  kind: 'recipe_reference';
  sourceId: string;
  materialDefinitionId: string;
  label: string;
  componentGrams: number;
  shareBasisPoints: number;
  priceKopecksPerKg: number;
  effectiveAt: Date;
  allocatedAmountKopecks: number;
};

type ShiftSnapshotMaterialSourceInput = {
  kind: 'shift_bigbag_allocation';
  usageId: string;
  bigBagId: string;
  materialDefinitionId: string | null;
  label: string;
  totalConsumedGrams: number;
  totalAmountKopecks: number;
  priceKopecksPerKg: number;
  effectiveAt: Date;
  denominator: AllocationDenominator;
  denominatorFingerprint: string;
};

type DirectSnapshotAdditionalSourceInput = {
  kind: 'direct';
  sourceId: string;
  source: string;
  reason: string;
  effectiveAt: Date;
  allocatedAmountKopecks: number;
};

type OrderSnapshotAdditionalSourceInput = {
  kind: 'order_allocation';
  sourceId: string;
  source: string;
  reason: string;
  effectiveAt: Date;
  productionOrderId: string;
  rollDispatchItemId: string;
  totalAmountKopecks: number;
  denominator: AllocationDenominator;
  denominatorFingerprint: string;
  sealProof: ProductionOrderSealProof;
  sealFingerprint: string;
};

type UnresolvedSnapshotAdditionalSourceInput = {
  kind: 'unresolved';
  sourceId: string;
  productionOrderId: string;
  source: string;
  reason: string;
  effectiveAt: Date;
  unresolvedReason: 'order_cost_allocation_unresolved';
  observedRollIds: Array<string | null>;
  safeInputFingerprint: string;
};

export type ProductionCostSourceSnapshotInput = {
  basis: {
    rollDispatchItemId: string;
    basisWeightGrams: number;
    producedAt: Date;
    closedAt: Date;
  };
  eligibility: {
    canonicalCaptureId: string;
    rootCaptureId: string;
    rootPostSessionId: string;
    shiftId: string;
    machineAssignmentId: string;
    dispatchCompletedAt: Date;
    sessionEndedAt: Date;
    shiftEndedAt: Date;
  };
  material:
    | { kind: 'recipe_reference'; sources: RecipeSnapshotMaterialSourceInput[] }
    | { kind: 'shift_bigbag_allocation'; sources: ShiftSnapshotMaterialSourceInput[] }
    | {
        kind: 'unresolved';
        reason: 'material_usage_unresolved' | 'material_price_unresolved';
        sources: Array<{
          usageId: string | null;
          bigBagId: string | null;
          materialDefinitionId: string | null;
        }>;
        safeInputFingerprint: string;
      };
  spool: {
    sourceId: string;
    spoolTypeKey: string;
    spoolTypeLabel: string;
    widthMicrometers: number;
    priceKopecksPerMeter: number;
    effectiveAt: Date;
    allocatedAmountKopecks: number;
  } | null;
  payroll: {
    tariffOrderId: string;
    tariffOrderName: string;
    effectiveFrom: Date;
    rateKopecksPerKg: number;
    basisLabel: string;
    allocatedAmountKopecks: number;
  } | null;
  additional: Array<
    | DirectSnapshotAdditionalSourceInput
    | OrderSnapshotAdditionalSourceInput
    | UnresolvedSnapshotAdditionalSourceInput
  >;
};

type SerializableDenominator = {
  sealed: true;
  algorithmVersion: string;
  rows: Array<{
    rollDispatchItemId: string;
    canonicalCaptureId: string;
    weightGrams: number;
    allocatedGrams?: number;
    allocatedAmountKopecks: number;
  }>;
};

type SerializableProductionOrderSealProof = {
  sealed: true;
  algorithmVersion: string;
  productionOrderId: string;
  rows: Array<{
    rollDispatchItemId: string;
    status: string;
    replacementAttemptId: string | null;
    canonicalCaptureId: string | null;
    weightGrams: number | null;
    hasDefect: boolean;
  }>;
};

export type ProductionCostSourceSnapshot = {
  basis: {
    rollDispatchItemId: string;
    basisWeightGrams: number;
    producedAt: string;
    closedAt: string;
  };
  eligibility: {
    canonicalCaptureId: string;
    rootCaptureId: string;
    rootPostSessionId: string;
    shiftId: string;
    machineAssignmentId: string;
    dispatchCompletedAt: string;
    sessionEndedAt: string;
    shiftEndedAt: string;
  };
  material:
    | {
        kind: 'recipe_reference';
        sources: Array<
          Omit<RecipeSnapshotMaterialSourceInput, 'effectiveAt'> & { effectiveAt: string }
        >;
      }
    | {
        kind: 'shift_bigbag_allocation';
        sources: Array<
          Omit<ShiftSnapshotMaterialSourceInput, 'effectiveAt' | 'denominator'> & {
            effectiveAt: string;
            denominator: SerializableDenominator;
          }
        >;
      }
    | {
        kind: 'unresolved';
        reason: 'material_usage_unresolved' | 'material_price_unresolved';
        sources: Array<{
          usageId: string | null;
          bigBagId: string | null;
          materialDefinitionId: string | null;
        }>;
        safeInputFingerprint: string;
      };
  spool:
    | (Omit<NonNullable<ProductionCostSourceSnapshotInput['spool']>, 'effectiveAt'> & {
        effectiveAt: string;
      })
    | null;
  payroll:
    | (Omit<NonNullable<ProductionCostSourceSnapshotInput['payroll']>, 'effectiveFrom'> & {
        effectiveFrom: string;
      })
    | null;
  additional: Array<
    | (Omit<DirectSnapshotAdditionalSourceInput, 'effectiveAt'> & { effectiveAt: string })
    | (Omit<OrderSnapshotAdditionalSourceInput, 'effectiveAt' | 'denominator' | 'sealProof'> & {
        effectiveAt: string;
        denominator: SerializableDenominator;
        sealProof: SerializableProductionOrderSealProof;
      })
    | (Omit<UnresolvedSnapshotAdditionalSourceInput, 'effectiveAt'> & { effectiveAt: string })
  >;
};

const FORBIDDEN_KEY_PREFIX =
  /^(?:raw|device|gateway|scan|print|weightpayload|password|secret|bearer|accesstoken|refreshtoken|authtoken|token)/iu;

function assertNoForbiddenKeys(value: unknown, path = 'sourceSnapshot'): void {
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/gu, '').toLocaleLowerCase('en-US');
    if (FORBIDDEN_KEY_PREFIX.test(normalized)) {
      throw new RangeError(`forbidden source snapshot key at ${path}.${key}`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function safeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be a safe integer`);
  }
  return value;
}

function iso(value: Date, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${field} must be a finite date`);
  }
  return value.toISOString();
}

function text(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new RangeError(`${field} must be non-blank and trimmed`);
  }
  return value;
}

function nullableText(value: string | null, field: string): string | null {
  return value === null ? null : text(value, field);
}

function fingerprint(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new RangeError(`${field} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function denominator(
  value: AllocationDenominator,
  fingerprint: string,
  field: string,
  totals: { grams?: number; amountKopecks: number },
): SerializableDenominator {
  validateAllocationDenominator(value, fingerprint, field, totals);
  return {
    sealed: true,
    algorithmVersion: text(value.algorithmVersion, `${field}.algorithmVersion`),
    rows: [...value.rows]
      .sort((left, right) => left.rollDispatchItemId.localeCompare(right.rollDispatchItemId))
      .map((row, index) => ({
        rollDispatchItemId: text(
          row.rollDispatchItemId,
          `${field}.rows[${index}].rollDispatchItemId`,
        ),
        canonicalCaptureId: text(
          row.canonicalCaptureId,
          `${field}.rows[${index}].canonicalCaptureId`,
        ),
        weightGrams: safeInteger(row.weightGrams, `${field}.rows[${index}].weightGrams`, 1),
        ...(row.allocatedGrams === undefined
          ? {}
          : {
              allocatedGrams: safeInteger(
                row.allocatedGrams,
                `${field}.rows[${index}].allocatedGrams`,
              ),
            }),
        allocatedAmountKopecks: safeInteger(
          row.allocatedAmountKopecks,
          `${field}.rows[${index}].allocatedAmountKopecks`,
        ),
      })),
  };
}

function productionOrderSeal(
  value: ProductionOrderSealProof,
  sealFingerprint: string,
  productionOrderId: string,
  allocationDenominator: AllocationDenominator,
  field: string,
): SerializableProductionOrderSealProof {
  validateProductionOrderSeal(
    value,
    sealFingerprint,
    productionOrderId,
    allocationDenominator,
    field,
  );
  return {
    sealed: true,
    algorithmVersion: text(value.algorithmVersion, `${field}.algorithmVersion`),
    productionOrderId: text(value.productionOrderId, `${field}.productionOrderId`),
    rows: [...value.rows]
      .sort((left, right) => left.rollDispatchItemId.localeCompare(right.rollDispatchItemId))
      .map((row, index) => ({
        rollDispatchItemId: text(
          row.rollDispatchItemId,
          `${field}.rows[${index}].rollDispatchItemId`,
        ),
        status: text(row.status, `${field}.rows[${index}].status`),
        replacementAttemptId: nullableText(
          row.replacementAttemptId,
          `${field}.rows[${index}].replacementAttemptId`,
        ),
        canonicalCaptureId: nullableText(
          row.canonicalCaptureId,
          `${field}.rows[${index}].canonicalCaptureId`,
        ),
        weightGrams:
          row.weightGrams === null
            ? null
            : safeInteger(row.weightGrams, `${field}.rows[${index}].weightGrams`, 1),
        hasDefect: row.hasDefect,
      })),
  };
}

export function buildProductionCostSourceSnapshot(
  input: ProductionCostSourceSnapshotInput,
): ProductionCostSourceSnapshot {
  assertNoForbiddenKeys(input);
  const material: ProductionCostSourceSnapshot['material'] =
    input.material.kind === 'unresolved'
      ? {
          kind: 'unresolved',
          reason: input.material.reason,
          sources: [...input.material.sources]
            .map((source, index) => ({
              usageId: nullableText(source.usageId, `material.sources[${index}].usageId`),
              bigBagId: nullableText(source.bigBagId, `material.sources[${index}].bigBagId`),
              materialDefinitionId: nullableText(
                source.materialDefinitionId,
                `material.sources[${index}].materialDefinitionId`,
              ),
            }))
            .sort(
              (left, right) =>
                (left.usageId ?? '').localeCompare(right.usageId ?? '') ||
                (left.bigBagId ?? '').localeCompare(right.bigBagId ?? '') ||
                (left.materialDefinitionId ?? '').localeCompare(right.materialDefinitionId ?? ''),
            ),
          safeInputFingerprint: fingerprint(
            input.material.safeInputFingerprint,
            'material.safeInputFingerprint',
          ),
        }
      : input.material.kind === 'recipe_reference'
        ? {
            kind: 'recipe_reference',
            sources: input.material.sources.map((source, index) => ({
              kind: 'recipe_reference',
              sourceId: text(source.sourceId, `material.sources[${index}].sourceId`),
              materialDefinitionId: text(
                source.materialDefinitionId,
                `material.sources[${index}].materialDefinitionId`,
              ),
              label: text(source.label, `material.sources[${index}].label`),
              componentGrams: safeInteger(
                source.componentGrams,
                `material.sources[${index}].componentGrams`,
              ),
              shareBasisPoints: safeInteger(
                source.shareBasisPoints,
                `material.sources[${index}].shareBasisPoints`,
                1,
              ),
              priceKopecksPerKg: safeInteger(
                source.priceKopecksPerKg,
                `material.sources[${index}].priceKopecksPerKg`,
                1,
              ),
              effectiveAt: iso(source.effectiveAt, `material.sources[${index}].effectiveAt`),
              allocatedAmountKopecks: safeInteger(
                source.allocatedAmountKopecks,
                `material.sources[${index}].allocatedAmountKopecks`,
              ),
            })),
          }
        : {
            kind: 'shift_bigbag_allocation',
            sources: input.material.sources.map((source, index) => ({
              kind: 'shift_bigbag_allocation',
              usageId: text(source.usageId, `material.sources[${index}].usageId`),
              bigBagId: text(source.bigBagId, `material.sources[${index}].bigBagId`),
              materialDefinitionId:
                source.materialDefinitionId === null
                  ? null
                  : text(
                      source.materialDefinitionId,
                      `material.sources[${index}].materialDefinitionId`,
                    ),
              label: text(source.label, `material.sources[${index}].label`),
              totalConsumedGrams: safeInteger(
                source.totalConsumedGrams,
                `material.sources[${index}].totalConsumedGrams`,
                1,
              ),
              totalAmountKopecks: safeInteger(
                source.totalAmountKopecks,
                `material.sources[${index}].totalAmountKopecks`,
              ),
              priceKopecksPerKg: safeInteger(
                source.priceKopecksPerKg,
                `material.sources[${index}].priceKopecksPerKg`,
                1,
              ),
              effectiveAt: iso(source.effectiveAt, `material.sources[${index}].effectiveAt`),
              denominator: denominator(
                source.denominator,
                source.denominatorFingerprint,
                `material.sources[${index}].denominator`,
                {
                  grams: source.totalConsumedGrams,
                  amountKopecks: source.totalAmountKopecks,
                },
              ),
              denominatorFingerprint: source.denominatorFingerprint,
            })),
          };
  const spool = input.spool
    ? {
        sourceId: text(input.spool.sourceId, 'spool.sourceId'),
        spoolTypeKey: text(input.spool.spoolTypeKey, 'spool.spoolTypeKey'),
        spoolTypeLabel: text(input.spool.spoolTypeLabel, 'spool.spoolTypeLabel'),
        widthMicrometers: safeInteger(input.spool.widthMicrometers, 'spool.widthMicrometers', 1),
        priceKopecksPerMeter: safeInteger(
          input.spool.priceKopecksPerMeter,
          'spool.priceKopecksPerMeter',
          1,
        ),
        effectiveAt: iso(input.spool.effectiveAt, 'spool.effectiveAt'),
        allocatedAmountKopecks: safeInteger(
          input.spool.allocatedAmountKopecks,
          'spool.allocatedAmountKopecks',
        ),
      }
    : null;
  const payroll = input.payroll
    ? {
        tariffOrderId: text(input.payroll.tariffOrderId, 'payroll.tariffOrderId'),
        tariffOrderName: text(input.payroll.tariffOrderName, 'payroll.tariffOrderName'),
        effectiveFrom: iso(input.payroll.effectiveFrom, 'payroll.effectiveFrom'),
        rateKopecksPerKg: safeInteger(input.payroll.rateKopecksPerKg, 'payroll.rateKopecksPerKg'),
        basisLabel: text(input.payroll.basisLabel, 'payroll.basisLabel'),
        allocatedAmountKopecks: safeInteger(
          input.payroll.allocatedAmountKopecks,
          'payroll.allocatedAmountKopecks',
        ),
      }
    : null;

  return {
    basis: {
      rollDispatchItemId: text(input.basis.rollDispatchItemId, 'basis.rollDispatchItemId'),
      basisWeightGrams: safeInteger(input.basis.basisWeightGrams, 'basis.basisWeightGrams', 1),
      producedAt: iso(input.basis.producedAt, 'basis.producedAt'),
      closedAt: iso(input.basis.closedAt, 'basis.closedAt'),
    },
    eligibility: {
      canonicalCaptureId: text(
        input.eligibility.canonicalCaptureId,
        'eligibility.canonicalCaptureId',
      ),
      rootCaptureId: text(input.eligibility.rootCaptureId, 'eligibility.rootCaptureId'),
      rootPostSessionId: text(input.eligibility.rootPostSessionId, 'eligibility.rootPostSessionId'),
      shiftId: text(input.eligibility.shiftId, 'eligibility.shiftId'),
      machineAssignmentId: text(
        input.eligibility.machineAssignmentId,
        'eligibility.machineAssignmentId',
      ),
      dispatchCompletedAt: iso(
        input.eligibility.dispatchCompletedAt,
        'eligibility.dispatchCompletedAt',
      ),
      sessionEndedAt: iso(input.eligibility.sessionEndedAt, 'eligibility.sessionEndedAt'),
      shiftEndedAt: iso(input.eligibility.shiftEndedAt, 'eligibility.shiftEndedAt'),
    },
    material,
    spool,
    payroll,
    additional: input.additional.map((source, index) => {
      const common = {
        sourceId: text(source.sourceId, `additional[${index}].sourceId`),
        source: text(source.source, `additional[${index}].source`),
        reason: text(source.reason, `additional[${index}].reason`),
        effectiveAt: iso(source.effectiveAt, `additional[${index}].effectiveAt`),
      };
      if (source.kind === 'direct') {
        return {
          ...common,
          kind: 'direct',
          allocatedAmountKopecks: safeInteger(
            source.allocatedAmountKopecks,
            `additional[${index}].allocatedAmountKopecks`,
          ),
        };
      }
      if (source.kind === 'unresolved') {
        return {
          ...common,
          kind: 'unresolved',
          productionOrderId: text(
            source.productionOrderId,
            `additional[${index}].productionOrderId`,
          ),
          unresolvedReason: source.unresolvedReason,
          observedRollIds: [...source.observedRollIds]
            .map((id, rollIndex) =>
              nullableText(id, `additional[${index}].observedRollIds[${rollIndex}]`),
            )
            .sort((left, right) => (left ?? '').localeCompare(right ?? '')),
          safeInputFingerprint: fingerprint(
            source.safeInputFingerprint,
            `additional[${index}].safeInputFingerprint`,
          ),
        };
      }
      const serializedDenominator = denominator(
        source.denominator,
        source.denominatorFingerprint,
        `additional[${index}].denominator`,
        { amountKopecks: source.totalAmountKopecks },
      );
      return {
        ...common,
        kind: 'order_allocation',
        productionOrderId: text(source.productionOrderId, `additional[${index}].productionOrderId`),
        rollDispatchItemId: text(
          source.rollDispatchItemId,
          `additional[${index}].rollDispatchItemId`,
        ),
        totalAmountKopecks: safeInteger(
          source.totalAmountKopecks,
          `additional[${index}].totalAmountKopecks`,
        ),
        denominator: serializedDenominator,
        denominatorFingerprint: source.denominatorFingerprint,
        sealProof: productionOrderSeal(
          source.sealProof,
          source.sealFingerprint,
          source.productionOrderId,
          source.denominator,
          `additional[${index}].sealProof`,
        ),
        sealFingerprint: fingerprint(
          source.sealFingerprint,
          `additional[${index}].sealFingerprint`,
        ),
      };
    }),
  };
}
