import type { BigBagStatus, DefectBagStatus, DefectBagType, OperatorStep } from './statuses';

/** One big bag taken into the operator's shift (start/end weights are manual, audited). */
export type OperatorShiftBag = {
  bagId: string;
  code: string;
  material: string;
  materialId: string | null;
  /** «Вес склада» — вес карточки при создании мешка складом. */
  warehouseKg: number | null;
  startKg: number;
  endKg: number | null;
  addedReason: string | null;
  releasedReason: string | null;
  active: boolean;
  releasedAt: string | null;
  sequence: number;
};

/** Raw-material balance of the shift (anti-fraud check, design 2026-07-13 §7). */
export type OperatorShiftBalance = {
  producedKg: number;
  defectKg: number;
  expectedUsageKg: number;
  actualUsageKg: number | null;
  deviationPercent: number | null;
  status: 'pending' | 'ok' | 'mismatch';
};

/** Big bag as the operator sees it in the shift-open picker. */
export type OperatorBigBagView = {
  id: string;
  code: string;
  material: string;
  materialId: string | null;
  warehouseKg: number | null;
  currentKg: number | null;
  status: BigBagStatus;
};

/** Canonical result of one idempotent Big-Bag release from an active operator shift. */
export type OperatorShiftBagReleaseResult = {
  bagId: string;
  code: string;
  startKg: number;
  endKg: number;
  active: false;
  releasedAt: string;
  status: 'available' | 'consumed';
};

export type OperatorShiftDefectBag = {
  id: string;
  code: string;
  status: DefectBagStatus;
  defectType: DefectBagType | null;
  weightKg: number;
  recordedDefectKg: number;
  differenceKg: number;
  labelState: 'not_printed' | 'submitted' | 'failed' | 'delivery_unknown';
  weighedAt: string;
};

/**
 * Operator runtime read-model (V2 S5): the aggregate the operator screen renders. Real domain
 * facts only — cosmetic-only frontend fields (color, sleeve, card size, recipe version…) are
 * overlaid by the frontend adapter from its demo template, never fabricated here.
 */
export type OperatorRuntimeShift = {
  id: string;
  status: 'scheduled' | 'start_missing' | 'active' | 'bag_missing' | 'close_pending' | 'closed';
  operatorName: string;
  workplace: string; // post code
  plannedStartAt?: string;
  plannedEndAt?: string;
  bigBagId?: string;
  startKg?: number;
  endKg?: number;
  expectedEndKg?: number;
  /** Additional material required when the remaining shift plan exceeds the active bag. */
  plannedShortageKg?: number;
  /** Remaining planned roll net weight, accounted one-to-one as raw-material usage. */
  plannedUsageKg?: number;
  actualUsageKg?: number;
  deviationPercent?: number;
  /** All bags taken into this shift (first one mirrors the legacy bigBagId/startKg fields). */
  bags?: OperatorShiftBag[];
  defectBags?: OperatorShiftDefectBag[];
  /** First bag retained for older clients; new clients use defectBags. */
  defectBag?: OperatorShiftDefectBag;
  balance?: OperatorShiftBalance;
  /** Remaining planned roll net weight, without an inferred process-loss multiplier. */
  plannedConsumptionKg?: number;
  /** Compatibility field; one-to-one material accounting always reports 1. */
  yieldRatio?: number;
  estimatedMinutes?: number;
};

export type OperatorRuntimeRecipeIngredient = {
  name: string;
  shareBasisPoints: number;
};

export type OperatorRuntimeRecipe = {
  name: string;
  version: number | null;
  ingredients: OperatorRuntimeRecipeIngredient[];
};

export type OperatorRuntimeRoll = {
  id: string; // rollCode
  dispatchItemId: string;
  /** Null for the planned attempt; set for an immutable retry after a physical defect. */
  replacesDispatchItemId: string | null;
  /** Customer-facing roll number; replacement attempts keep the number of their root roll. */
  sequenceNumber: number;
  /** Physical production attempt within the same logical roll, starting at one. */
  attemptNumber: number;
  /** Stable commercial-position id used to keep multi-roll positions together. */
  orderLineId: string | null;
  /** Roll number inside the commercial position; not a position identifier. */
  positionSequence: number;
  /** Film form/type of this exact commercial position (for example Рукав or Полотно). */
  filmType: string | null;
  rawMaterialId: string | null;
  rawMaterialLabel: string | null;
  recipeVersion: string | null;
  queueRank: number;
  priority: number;
  machineId: string | null;
  machineLabel: string | null;
  plannedLengthM: number | null;
  characteristicsSnapshot: {
    actualThickness?: string | null;
    accountingThickness?: string | null;
    widthMm?: number | null;
    spoolType?: string | null;
    birka?: string | null;
    manualBirka?: string | null;
    comment?: string | null;
    /** Safe immutable recipe facts; internal catalog/source identifiers are intentionally omitted. */
    recipe?: OperatorRuntimeRecipe | null;
    /** Legacy recipe name only; unrelated order terms are intentionally omitted. */
    legacyRecipeName?: string;
  } | null;
  updatedAt: string;
  status: OperatorStep;
  plannedNetKg: number | null;
  /** How the spool tare must be obtained for this immutable production attempt. */
  spoolWeightPolicy: 'standard_700g' | 'physical_measurement';
  spoolKg: number | null;
  /** Physical roll weight with the spool included. */
  grossKg: number | null;
  /** Produced film weight after subtracting the spool tare. */
  netKg: number | null;
  toleranceOk: boolean | null;
  labelState: string;
  warehouseState: string;
};

export type OperatorRollProgress = {
  current: number;
  completed: number;
  total: number;
};

export type OperatorRuntimeOrder = {
  id: string; // orderNumber
  title: string;
  /**
   * General order comment explicitly visible to the operator.
   * Counterparty fields and raw source payload remain excluded from this projection.
   */
  commercialComment?: string | null;
  filmType: string | null;
  status: OperatorStep; // current roll's step, hoisted to the order
  progress: OperatorRollProgress;
  plannedRolls: number;
  completedRolls: number;
  currentRoll: number; // sequenceNumber of the active roll
  /** Exact physical attempt selected for actions when several attempts share a logical number. */
  currentDispatchItemId: string;
  rollPlanKg: number | null;
  spoolKg: number | null;
  rollNetKg: number | null;
  rolls: OperatorRuntimeRoll[];
};

export type OperatorRuntime = {
  shift: OperatorRuntimeShift | null;
  orders: OperatorRuntimeOrder[];
  generatedAt: string;
};
