export const WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS = [1, 2] as const;

export const WAREHOUSE_COVERAGE_FACT_SOURCES = [
  'production_handover',
  'warehouse_recheck',
  'migration_backfill',
  'order_cancellation',
] as const;

export const WAREHOUSE_COVERAGE_AVAILABILITIES = [
  'verified_full',
  'unavailable',
  'unknown',
] as const;

export const WAREHOUSE_COVERAGE_STATES = [
  'calculating',
  'awaiting_finance',
  'production_required',
  'unknown',
  'recheck_requested',
  'warehouse_reserved',
  'stale',
  'order_spec_changed',
] as const;

export const WAREHOUSE_COVERAGE_DECISIONS = [
  'use_warehouse',
  'produce_all',
  'auto_produce_all',
] as const;

export const WAREHOUSE_COVERAGE_COMMANDS = [
  'refresh',
  'decide',
  'request_recheck',
  'resolve_recheck',
] as const;

export const WAREHOUSE_COVERAGE_RECOVERY_COMMANDS = ['cancel_reservation'] as const;

export const WAREHOUSE_COVERAGE_RECHECK_ORIGINS = [
  'finance_request',
  'decision_linked_physical_exception',
] as const;

export const WAREHOUSE_COVERAGE_OWNERS = ['finance', 'commercial', 'warehouse', 'system'] as const;

export const WAREHOUSE_COVERAGE_ACTIONS = [
  'use_warehouse',
  'produce_all',
  'request_recheck',
  'correct_order_spec',
  'resolve_recheck',
  'refresh',
  'report_physical_exception',
] as const;

export const WAREHOUSE_COVERAGE_ROLL_SOURCES = ['platform', 'production', 'legacy'] as const;

export const WAREHOUSE_COVERAGE_ROLL_AVAILABILITIES = ['available', 'reserved'] as const;

export const WAREHOUSE_COVERAGE_REASON_CODES = [
  'full_cover_available',
  'no_compatible_rolls',
  'only_partial_cover',
  'order_spec_incomplete',
  'roll_facts_incomplete',
  'roll_ownership_unverified',
  'unsupported_policy_version',
  'inventory_changed',
  'warehouse_recheck_pending',
] as const;

export type WarehouseCoverageWorkflowVersion =
  (typeof WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS)[number];
export type WarehouseCoverageFactSource = (typeof WAREHOUSE_COVERAGE_FACT_SOURCES)[number];
export type WarehouseCoverageAvailability = (typeof WAREHOUSE_COVERAGE_AVAILABILITIES)[number];
export type WarehouseCoverageState = (typeof WAREHOUSE_COVERAGE_STATES)[number];
export type WarehouseCoverageDecisionKind = (typeof WAREHOUSE_COVERAGE_DECISIONS)[number];
export type WarehouseCoverageCommandKind = (typeof WAREHOUSE_COVERAGE_COMMANDS)[number];
export type WarehouseCoverageRecoveryCommandKind =
  (typeof WAREHOUSE_COVERAGE_RECOVERY_COMMANDS)[number];
export type WarehouseCoverageRecheckOrigin = (typeof WAREHOUSE_COVERAGE_RECHECK_ORIGINS)[number];
export type WarehouseCoverageOwner = (typeof WAREHOUSE_COVERAGE_OWNERS)[number];
export type WarehouseCoverageAction = (typeof WAREHOUSE_COVERAGE_ACTIONS)[number];
export type WarehouseCoverageReasonCode = (typeof WAREHOUSE_COVERAGE_REASON_CODES)[number];
export type WarehouseCoverageRollSource = (typeof WAREHOUSE_COVERAGE_ROLL_SOURCES)[number];
export type WarehouseCoverageRollAvailability =
  (typeof WAREHOUSE_COVERAGE_ROLL_AVAILABILITIES)[number];

export type UuidString = string;
export type UtcIsoString = string;
export type DecimalKgString = string;

export interface WarehouseCoverageProjection {
  workflowVersion: WarehouseCoverageWorkflowVersion;
  state: WarehouseCoverageState;
  stateVersion: number;
  generation: number | null;
  availability: WarehouseCoverageAvailability | null;
  reasonCodes: WarehouseCoverageReasonCode[];
  nextOwner: WarehouseCoverageOwner;
  availableActions: WarehouseCoverageAction[];
  requiredRollCount: number;
  matchedRollCount: number;
  uncertainRollCount: number;
  calculatedAt: UtcIsoString | null;
  stale: boolean;
}

export interface WarehouseCoverageTypeSpecification {
  filmType: string | null;
  actualThicknessMicron: number | null;
  accountingThicknessMicron: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  weightKg: number | null;
  spoolType: string | null;
  birka: string | null;
  recipeName: string | null;
  ingredients: Array<{ name: string; shareBasisPoints: number }>;
}

export interface WarehouseCoverageTypeProjection {
  positionId: string;
  label: string;
  requiredRollCount: number;
  matchedRollCount: number;
  uncertainRollCount: number;
  requested: WarehouseCoverageTypeSpecification;
  matched: Omit<WarehouseCoverageTypeSpecification, 'weightKg'> & {
    weightKg: { min: number; max: number; total: number } | null;
  };
  comparison: {
    filmType: boolean;
    actualThickness: boolean;
    accountingThickness: boolean;
    width: boolean;
    plannedLength: boolean;
    weightTolerance: boolean;
    spoolType: boolean;
    birka: boolean;
    ingredients: boolean;
  };
}

export interface CommercialWarehouseCoverageProjection extends WarehouseCoverageProjection {
  typeCoverage: WarehouseCoverageTypeProjection[];
}

export const REQUIRED_WAREHOUSE_COVERAGE_PROJECTION_FIELDS = [
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
] as const satisfies readonly (keyof WarehouseCoverageProjection)[];

export interface WarehouseCoverageRollSpecificationProjection {
  filmType: string | null;
  actualThicknessMicron: number | null;
  accountingThicknessMicron: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  netKg: number | null;
  spoolType: string | null;
  birka: string | null;
  materialLabel: string | null;
}

export interface FinanceCoverageRollProjection {
  rollCode: string;
  positionId: string;
  source: WarehouseCoverageRollSource;
  locationLabel: string;
  availability: WarehouseCoverageRollAvailability;
  batchCode: string | null;
  receivedAt: UtcIsoString | null;
  grossKg: number | null;
  spoolKg: number | null;
  requested: WarehouseCoverageRollSpecificationProjection;
  matched: WarehouseCoverageRollSpecificationProjection;
}

export interface FinanceWarehouseCoverageProjection extends WarehouseCoverageProjection {
  financeRolls: FinanceCoverageRollProjection[];
}
