export const WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS = [1, 2] as const;
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

const WAREHOUSE_COVERAGE_KEYS = [
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
const COVERAGE_ORIGINS = ['finance_request', 'decision_linked_physical_exception'] as const;
const COVERAGE_MEMBER_SOURCE_KINDS = [
  'verified_candidate',
  'uncertain_candidate',
  'decision_match',
] as const;
const COVERAGE_DECISION_TASK_STATUSES = ['open', 'partial', 'closed', 'exception'] as const;
const COVERAGE_SCAN_STATUSES = [
  'expected',
  'scanned',
  'accepted',
  'missing',
  'excess',
  'duplicate',
  'wrong',
  'damaged',
  'reserved',
] as const;
const COVERAGE_ROLL_SOURCES = ['platform', 'production', 'legacy'] as const;
const COVERAGE_ROLL_AVAILABILITIES = ['available', 'reserved'] as const;

export type WarehouseCoverageWorkflowVersion =
  (typeof WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS)[number];
export type WarehouseCoverageAvailability = (typeof WAREHOUSE_COVERAGE_AVAILABILITIES)[number];
export type WarehouseCoverageState = (typeof WAREHOUSE_COVERAGE_STATES)[number];
export type WarehouseCoverageOwner = (typeof WAREHOUSE_COVERAGE_OWNERS)[number];
export type WarehouseCoverageAction = (typeof WAREHOUSE_COVERAGE_ACTIONS)[number];
export type WarehouseCoverageReasonCode = (typeof WAREHOUSE_COVERAGE_REASON_CODES)[number];
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

export type WarehouseCoverageView = WarehouseCoverageProjection;
export interface WarehouseCoverageTypeSpecificationView {
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
export type WarehouseCoverageMatchedTypeSpecificationView = Omit<
  WarehouseCoverageTypeSpecificationView,
  'weightKg'
> & {
  weightKg: { min: number; max: number; total: number } | null;
};
export interface WarehouseCoverageTypeProjectionView {
  positionId: string;
  label: string;
  requiredRollCount: number;
  matchedRollCount: number;
  uncertainRollCount: number;
  requested: WarehouseCoverageTypeSpecificationView;
  matched: WarehouseCoverageMatchedTypeSpecificationView;
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
export type CommercialWarehouseCoverageView = WarehouseCoverageView & {
  typeCoverage: WarehouseCoverageTypeProjectionView[];
};
export type CommercialWarehouseCoverageEnvelopeView =
  | CommercialWarehouseCoverageView
  | (WarehouseCoverageView & { typeCoverage?: never });
export type WarehouseCoverageRollSpecificationView = {
  filmType: string | null;
  actualThicknessMicron: number | null;
  accountingThicknessMicron: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  netKg: number | null;
  spoolType: string | null;
  birka: string | null;
  materialLabel: string | null;
};
export type FinanceWarehouseCoverageRollView = {
  rollCode: string;
  positionId: string;
  source: (typeof COVERAGE_ROLL_SOURCES)[number];
  locationLabel: string;
  availability: (typeof COVERAGE_ROLL_AVAILABILITIES)[number];
  batchCode: string | null;
  receivedAt: UtcIsoString | null;
  grossKg: number | null;
  spoolKg: number | null;
  requested: WarehouseCoverageRollSpecificationView;
  matched: WarehouseCoverageRollSpecificationView;
};
export type FinanceWarehouseCoverageView = WarehouseCoverageView & {
  financeRolls: FinanceWarehouseCoverageRollView[];
};
export type WarehouseCoverageWithCaseView = WarehouseCoverageView & {
  caseId: string;
};
export type FinanceWarehouseCoverageWithCaseView = FinanceWarehouseCoverageView & {
  caseId: string;
};

export interface WarehouseCoverageCorrectionSpecView {
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm: number;
  plannedLengthM: number;
  birka: string;
  spoolType: string;
  actualWeightKg: DecimalKgString;
  plannedWeightKg: DecimalKgString;
  recipeId: string | null;
  recipeVersion: string | null;
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeVersionNumber: number | null;
  ingredients: Array<{
    rawMaterialDefinitionId: string;
    shareBasisPoints: number;
  }>;
}

export interface WarehouseCoverageRecheckMemberView {
  membershipId: string;
  rollCode: string;
  sourceKind: (typeof COVERAGE_MEMBER_SOURCE_KINDS)[number];
  reasonCodes: WarehouseCoverageReasonCode[];
  currentFactVersion: number | null;
  ownerVerified: boolean;
  currentSpec: WarehouseCoverageCorrectionSpecView | null;
}

export interface WarehouseCoverageRecheckItem {
  caseId: string;
  coverageOrigin: (typeof COVERAGE_ORIGINS)[number];
  caseVersion: number;
  stateVersion: number;
  generation: number;
  reasonCodes: WarehouseCoverageReasonCode[];
  members: WarehouseCoverageRecheckMemberView[];
}

export interface WarehouseCoverageDecisionTaskRowView {
  scanRowId: string;
  rollCode: string;
  scanStatus: (typeof COVERAGE_SCAN_STATUSES)[number];
}

export interface WarehouseCoverageDecisionTaskView {
  taskId: string;
  status: (typeof COVERAGE_DECISION_TASK_STATUSES)[number];
  generation: number;
  stateVersion: number;
  updatedAt: UtcIsoString;
  rows: WarehouseCoverageDecisionTaskRowView[];
}

export interface RefreshWarehouseCoverageDto {
  clientRequestId: UuidString;
  expectedGeneration: number | null;
  expectedStateVersion: number;
}

export interface DecideWarehouseCoverageDto {
  clientRequestId: UuidString;
  expectedGeneration: number;
  expectedStateVersion: number;
  decision: 'use_warehouse' | 'produce_all';
}

export interface RequestWarehouseCoverageRecheckDto {
  clientRequestId: UuidString;
  expectedGeneration: number;
  expectedStateVersion: number;
  reason: string;
}

export type WarehouseCoverageFactCorrectionDto = {
  membershipId: string;
  expectedFactVersion: number | null;
} & (
  | {
      ownerCounterpartyId: string;
      spec?: WarehouseCoverageCorrectionSpecView;
    }
  | {
      ownerCounterpartyId?: string;
      spec: WarehouseCoverageCorrectionSpecView;
    }
);

export interface ResolveWarehouseCoverageRecheckDto {
  clientRequestId: UuidString;
  expectedCaseVersion: number;
  expectedGeneration: number;
  expectedStateVersion: number;
  reason: string;
  corrections: WarehouseCoverageFactCorrectionDto[];
}

export interface CoveragePhysicalExceptionDto {
  clientRequestId: UuidString;
  expectedGeneration: number;
  expectedStateVersion: number;
  expectedTaskUpdatedAt: UtcIsoString;
  scanRowId: string;
  kind: 'missing' | 'damaged';
  reason: string;
  evidenceRef?: string;
}

const COVERAGE_REASON_LABELS: Record<WarehouseCoverageReasonCode, string> = {
  full_cover_available: 'Полное покрытие доступно',
  no_compatible_rolls: 'Совместимые рулоны не найдены',
  only_partial_cover: 'Доступно только частичное покрытие',
  order_spec_incomplete: 'Не хватает данных заказа',
  roll_facts_incomplete: 'Не хватает данных рулонов',
  roll_ownership_unverified: 'Владелец рулона не подтверждён',
  unsupported_policy_version: 'Требуется безопасная проверка данных',
  inventory_changed: 'Остатки изменились',
  warehouse_recheck_pending: 'Склад перепроверяет остатки',
};

export function coverageReasonLabel(code: WarehouseCoverageReasonCode | string): string {
  return (
    COVERAGE_REASON_LABELS[code as WarehouseCoverageReasonCode] ??
    'Требуется безопасная проверка данных'
  );
}

export function normalizeWarehouseCoverage(input: unknown): WarehouseCoverageView {
  const record = requireRecord(input, 'warehouse coverage');
  return {
    workflowVersion: requireEnum(
      record.workflowVersion,
      WAREHOUSE_COVERAGE_WORKFLOW_VERSIONS,
      'workflowVersion',
    ),
    state: requireEnum(record.state, WAREHOUSE_COVERAGE_STATES, 'state'),
    stateVersion: requireNonnegativeInteger(record.stateVersion, 'stateVersion'),
    generation: requireNullableNonnegativeInteger(record.generation, 'generation'),
    availability: requireNullableEnum(
      record.availability,
      WAREHOUSE_COVERAGE_AVAILABILITIES,
      'availability',
    ),
    reasonCodes: requireEnumArray(
      record.reasonCodes,
      WAREHOUSE_COVERAGE_REASON_CODES,
      'reasonCodes',
    ),
    nextOwner: requireEnum(record.nextOwner, WAREHOUSE_COVERAGE_OWNERS, 'nextOwner'),
    availableActions: requireEnumArray(
      record.availableActions,
      WAREHOUSE_COVERAGE_ACTIONS,
      'availableActions',
    ),
    requiredRollCount: requireNonnegativeInteger(record.requiredRollCount, 'requiredRollCount'),
    matchedRollCount: requireNonnegativeInteger(record.matchedRollCount, 'matchedRollCount'),
    uncertainRollCount: requireNonnegativeInteger(record.uncertainRollCount, 'uncertainRollCount'),
    calculatedAt: requireNullableUtcIso(record.calculatedAt, 'calculatedAt'),
    stale: requireBoolean(record.stale, 'stale'),
  };
}

export function normalizeCommercialWarehouseCoverage(
  input: unknown,
): CommercialWarehouseCoverageEnvelopeView {
  const record = requireRecord(input, 'commercial warehouse coverage');
  const coverage = normalizeWarehouseCoverage(record);
  if (!Object.prototype.hasOwnProperty.call(record, 'typeCoverage')) return coverage;
  return {
    ...coverage,
    typeCoverage: requireArray(record.typeCoverage, 'typeCoverage', normalizeTypeCoverageRow),
  };
}

function normalizeTypeCoverageRow(
  input: unknown,
  index: number,
): WarehouseCoverageTypeProjectionView {
  const path = `typeCoverage[${index}]`;
  const row = requireRecord(input, path);
  return {
    positionId: requireNonemptyString(row.positionId, `${path}.positionId`),
    label: requireNonemptyString(row.label, `${path}.label`),
    requiredRollCount: requireNonnegativeInteger(
      row.requiredRollCount,
      `${path}.requiredRollCount`,
    ),
    matchedRollCount: requireNonnegativeInteger(row.matchedRollCount, `${path}.matchedRollCount`),
    uncertainRollCount: requireNonnegativeInteger(
      row.uncertainRollCount,
      `${path}.uncertainRollCount`,
    ),
    requested: normalizeTypeSpecification(row.requested, `${path}.requested`),
    matched: normalizeMatchedTypeSpecification(row.matched, `${path}.matched`),
    comparison: normalizeTypeComparison(row.comparison, `${path}.comparison`),
  };
}

function normalizeTypeSpecification(
  input: unknown,
  path: string,
): WarehouseCoverageTypeSpecificationView {
  const specification = requireRecord(input, path);
  return {
    ...normalizeTypeSpecificationFields(specification, path),
    weightKg: requireNullableFiniteNumber(specification.weightKg, `${path}.weightKg`),
  };
}

function normalizeMatchedTypeSpecification(
  input: unknown,
  path: string,
): WarehouseCoverageMatchedTypeSpecificationView {
  const specification = requireRecord(input, path);
  const weight = specification.weightKg;
  return {
    ...normalizeTypeSpecificationFields(specification, path),
    weightKg: weight === null ? null : normalizeMatchedWeight(weight, `${path}.weightKg`),
  };
}

function normalizeTypeSpecificationFields(
  specification: Record<string, unknown>,
  path: string,
): Omit<WarehouseCoverageTypeSpecificationView, 'weightKg'> {
  return {
    filmType: requireNullableNonemptyString(specification.filmType, `${path}.filmType`),
    actualThicknessMicron: requireNullableFiniteNumber(
      specification.actualThicknessMicron,
      `${path}.actualThicknessMicron`,
    ),
    accountingThicknessMicron: requireNullableFiniteNumber(
      specification.accountingThicknessMicron,
      `${path}.accountingThicknessMicron`,
    ),
    widthMm: requireNullableFiniteNumber(specification.widthMm, `${path}.widthMm`),
    plannedLengthM: requireNullableFiniteNumber(
      specification.plannedLengthM,
      `${path}.plannedLengthM`,
    ),
    spoolType: requireNullableNonemptyString(specification.spoolType, `${path}.spoolType`),
    birka: requireNullableNonemptyString(specification.birka, `${path}.birka`),
    recipeName: requireNullableNonemptyString(specification.recipeName, `${path}.recipeName`),
    ingredients: normalizeTypeIngredients(specification.ingredients, `${path}.ingredients`),
  };
}

function normalizeMatchedWeight(
  input: unknown,
  path: string,
): NonNullable<WarehouseCoverageMatchedTypeSpecificationView['weightKg']> {
  const weight = requireRecord(input, path);
  return {
    min: requireFiniteNumber(weight.min, `${path}.min`),
    max: requireFiniteNumber(weight.max, `${path}.max`),
    total: requireFiniteNumber(weight.total, `${path}.total`),
  };
}

function normalizeTypeIngredients(
  input: unknown,
  path: string,
): WarehouseCoverageTypeSpecificationView['ingredients'] {
  return requireArray(input, path, (item, index) => {
    const ingredientPath = `${path}[${index}]`;
    const ingredient = requireRecord(item, ingredientPath);
    return {
      name: requireNonemptyString(ingredient.name, `${ingredientPath}.name`),
      shareBasisPoints: requireFiniteNumber(
        ingredient.shareBasisPoints,
        `${ingredientPath}.shareBasisPoints`,
      ),
    };
  });
}

function normalizeTypeComparison(
  input: unknown,
  path: string,
): WarehouseCoverageTypeProjectionView['comparison'] {
  const comparison = requireRecord(input, path);
  return {
    filmType: requireBoolean(comparison.filmType, `${path}.filmType`),
    actualThickness: requireBoolean(comparison.actualThickness, `${path}.actualThickness`),
    accountingThickness: requireBoolean(
      comparison.accountingThickness,
      `${path}.accountingThickness`,
    ),
    width: requireBoolean(comparison.width, `${path}.width`),
    plannedLength: requireBoolean(comparison.plannedLength, `${path}.plannedLength`),
    weightTolerance: requireBoolean(comparison.weightTolerance, `${path}.weightTolerance`),
    spoolType: requireBoolean(comparison.spoolType, `${path}.spoolType`),
    birka: requireBoolean(comparison.birka, `${path}.birka`),
    ingredients: requireBoolean(comparison.ingredients, `${path}.ingredients`),
  };
}

export function normalizeFinanceWarehouseCoverage(input: unknown): FinanceWarehouseCoverageView {
  const record = requireExactRecord(
    input,
    [...WAREHOUSE_COVERAGE_KEYS, 'financeRolls'],
    'finance warehouse coverage',
  );
  return {
    ...normalizeWarehouseCoverage(record),
    financeRolls: requireArray(record.financeRolls, 'financeRolls', (item, index) => {
      const path = `financeRolls[${index}]`;
      const roll = requireExactRecord(
        item,
        [
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
        ],
        path,
      );
      return {
        rollCode: requireNonemptyString(roll.rollCode, `${path}.rollCode`),
        positionId: requireNonemptyString(roll.positionId, `${path}.positionId`),
        source: requireEnum(roll.source, COVERAGE_ROLL_SOURCES, `${path}.source`),
        locationLabel: requireNonemptyString(roll.locationLabel, `${path}.locationLabel`),
        availability: requireEnum(
          roll.availability,
          COVERAGE_ROLL_AVAILABILITIES,
          `${path}.availability`,
        ),
        batchCode: requireNullableNonemptyString(roll.batchCode, `${path}.batchCode`),
        receivedAt: requireNullableUtcIso(roll.receivedAt, `${path}.receivedAt`),
        grossKg: requireNullablePositiveNumber(roll.grossKg, `${path}.grossKg`),
        spoolKg: requireNullablePositiveNumber(roll.spoolKg, `${path}.spoolKg`),
        requested: normalizeCoverageRollSpecification(roll.requested, `${path}.requested`),
        matched: normalizeCoverageRollSpecification(roll.matched, `${path}.matched`),
      };
    }),
  };
}

function normalizeCoverageRollSpecification(
  input: unknown,
  path: string,
): WarehouseCoverageRollSpecificationView {
  const spec = requireExactRecord(
    input,
    [
      'filmType',
      'actualThicknessMicron',
      'accountingThicknessMicron',
      'widthMm',
      'plannedLengthM',
      'netKg',
      'spoolType',
      'birka',
      'materialLabel',
    ],
    path,
  );
  return {
    filmType: requireNullableNonemptyString(spec.filmType, `${path}.filmType`),
    actualThicknessMicron: requireNullablePositiveNumber(
      spec.actualThicknessMicron,
      `${path}.actualThicknessMicron`,
    ),
    accountingThicknessMicron: requireNullablePositiveNumber(
      spec.accountingThicknessMicron,
      `${path}.accountingThicknessMicron`,
    ),
    widthMm: requireNullablePositiveNumber(spec.widthMm, `${path}.widthMm`),
    plannedLengthM: requireNullablePositiveNumber(spec.plannedLengthM, `${path}.plannedLengthM`),
    netKg: requireNullablePositiveNumber(spec.netKg, `${path}.netKg`),
    spoolType: requireNullableNonemptyString(spec.spoolType, `${path}.spoolType`),
    birka: requireNullableNonemptyString(spec.birka, `${path}.birka`),
    materialLabel: requireNullableNonemptyString(spec.materialLabel, `${path}.materialLabel`),
  };
}

export function normalizeWarehouseCoverageWithCase(input: unknown): WarehouseCoverageWithCaseView {
  const record = requireExactRecord(
    input,
    [...WAREHOUSE_COVERAGE_KEYS, 'caseId'],
    'warehouse coverage with case',
  );
  return {
    ...normalizeWarehouseCoverage(record),
    caseId: requireNonemptyString(record.caseId, 'caseId'),
  };
}

export function normalizeFinanceWarehouseCoverageWithCase(
  input: unknown,
): FinanceWarehouseCoverageWithCaseView {
  const record = requireExactRecord(
    input,
    [...WAREHOUSE_COVERAGE_KEYS, 'financeRolls', 'caseId'],
    'finance warehouse coverage with case',
  );
  const { caseId, ...financeCoverage } = record;
  return {
    ...normalizeFinanceWarehouseCoverage(financeCoverage),
    caseId: requireNonemptyString(caseId, 'caseId'),
  };
}

export function normalizeWarehouseCoverageRecheckItem(
  input: unknown,
): WarehouseCoverageRecheckItem {
  const item = requireExactRecord(
    input,
    [
      'caseId',
      'coverageOrigin',
      'caseVersion',
      'stateVersion',
      'generation',
      'reasonCodes',
      'members',
    ],
    'warehouse coverage recheck',
  );
  return {
    caseId: requireNonemptyString(item.caseId, 'caseId'),
    coverageOrigin: requireEnum(item.coverageOrigin, COVERAGE_ORIGINS, 'coverageOrigin'),
    caseVersion: requirePositiveInteger(item.caseVersion, 'caseVersion'),
    stateVersion: requireNonnegativeInteger(item.stateVersion, 'stateVersion'),
    generation: requirePositiveInteger(item.generation, 'generation'),
    reasonCodes: requireEnumArray(item.reasonCodes, WAREHOUSE_COVERAGE_REASON_CODES, 'reasonCodes'),
    members: requireArray(item.members, 'members', normalizeRecheckMember),
  };
}

export function normalizeWarehouseCoverageDecisionTask(
  input: unknown,
): WarehouseCoverageDecisionTaskView {
  const task = requireExactRecord(
    input,
    ['taskId', 'status', 'generation', 'stateVersion', 'updatedAt', 'rows'],
    'warehouse coverage decision task',
  );
  return {
    taskId: requireNonemptyString(task.taskId, 'taskId'),
    status: requireEnum(task.status, COVERAGE_DECISION_TASK_STATUSES, 'status'),
    generation: requirePositiveInteger(task.generation, 'generation'),
    stateVersion: requireNonnegativeInteger(task.stateVersion, 'stateVersion'),
    updatedAt: requireUtcIso(task.updatedAt, 'updatedAt'),
    rows: requireArray(task.rows, 'rows', (inputRow, index) => {
      const row = requireExactRecord(
        inputRow,
        ['scanRowId', 'rollCode', 'scanStatus'],
        `rows[${index}]`,
      );
      return {
        scanRowId: requireNonemptyString(row.scanRowId, `rows[${index}].scanRowId`),
        rollCode: requireNonemptyString(row.rollCode, `rows[${index}].rollCode`),
        scanStatus: requireEnum(
          row.scanStatus,
          COVERAGE_SCAN_STATUSES,
          `rows[${index}].scanStatus`,
        ),
      };
    }),
  };
}

function normalizeRecheckMember(input: unknown, index: number): WarehouseCoverageRecheckMemberView {
  const path = `members[${index}]`;
  const member = requireExactRecord(
    input,
    [
      'membershipId',
      'rollCode',
      'sourceKind',
      'reasonCodes',
      'currentFactVersion',
      'ownerVerified',
      'currentSpec',
    ],
    path,
  );
  return {
    membershipId: requireNonemptyString(member.membershipId, `${path}.membershipId`),
    rollCode: requireNonemptyString(member.rollCode, `${path}.rollCode`),
    sourceKind: requireEnum(member.sourceKind, COVERAGE_MEMBER_SOURCE_KINDS, `${path}.sourceKind`),
    reasonCodes: requireEnumArray(
      member.reasonCodes,
      WAREHOUSE_COVERAGE_REASON_CODES,
      `${path}.reasonCodes`,
    ),
    currentFactVersion: requireNullablePositiveInteger(
      member.currentFactVersion,
      `${path}.currentFactVersion`,
    ),
    ownerVerified: requireBoolean(member.ownerVerified, `${path}.ownerVerified`),
    currentSpec:
      member.currentSpec === null
        ? null
        : normalizeCorrectionSpec(member.currentSpec, `${path}.currentSpec`),
  };
}

function normalizeCorrectionSpec(
  input: unknown,
  path: string,
): WarehouseCoverageCorrectionSpecView {
  const spec = requireExactRecord(
    input,
    [
      'filmType',
      'actualThickness',
      'accountingThickness',
      'widthMm',
      'plannedLengthM',
      'birka',
      'spoolType',
      'actualWeightKg',
      'plannedWeightKg',
      'recipeId',
      'recipeVersion',
      'recipeDefinitionId',
      'recipeDefinitionVersionId',
      'recipeVersionNumber',
      'ingredients',
    ],
    path,
  );
  const ingredients = requireArray(
    spec.ingredients,
    `${path}.ingredients`,
    (inputIngredient, index) => {
      const ingredientPath = `${path}.ingredients[${index}]`;
      const ingredient = requireExactRecord(
        inputIngredient,
        ['rawMaterialDefinitionId', 'shareBasisPoints'],
        ingredientPath,
      );
      return {
        rawMaterialDefinitionId: requireNonemptyString(
          ingredient.rawMaterialDefinitionId,
          `${ingredientPath}.rawMaterialDefinitionId`,
        ),
        shareBasisPoints: requireBasisPoints(
          ingredient.shareBasisPoints,
          `${ingredientPath}.shareBasisPoints`,
        ),
      };
    },
  );
  requireExactComposition(ingredients, `${path}.ingredients`);
  const widthMm = requireFiniteNumber(spec.widthMm, `${path}.widthMm`);
  const plannedLengthM = requireFiniteNumber(spec.plannedLengthM, `${path}.plannedLengthM`);
  for (const [value, max, field] of [
    [widthMm, 100_000, 'widthMm'],
    [plannedLengthM, 10_000_000, 'plannedLengthM'],
  ] as const) {
    if (value < 0.001 || value > max || Number(value.toFixed(3)) !== value) {
      throw new Error(
        `${path}.${field} must be a positive dimension with at most 3 decimal places`,
      );
    }
  }
  return {
    filmType: requireNonemptyString(spec.filmType, `${path}.filmType`),
    widthMm,
    plannedLengthM,
    actualThickness: requireNonemptyString(spec.actualThickness, `${path}.actualThickness`),
    accountingThickness: requireNonemptyString(
      spec.accountingThickness,
      `${path}.accountingThickness`,
    ),
    birka: requireNonemptyString(spec.birka, `${path}.birka`),
    spoolType: requireNonemptyString(spec.spoolType, `${path}.spoolType`),
    actualWeightKg: requireDecimalKgString(spec.actualWeightKg, `${path}.actualWeightKg`),
    plannedWeightKg: requireDecimalKgString(spec.plannedWeightKg, `${path}.plannedWeightKg`),
    recipeId: requireNullableNonemptyString(spec.recipeId, `${path}.recipeId`),
    recipeVersion: requireNullableNonemptyString(spec.recipeVersion, `${path}.recipeVersion`),
    recipeDefinitionId: requireNullableNonemptyString(
      spec.recipeDefinitionId,
      `${path}.recipeDefinitionId`,
    ),
    recipeDefinitionVersionId: requireNullableNonemptyString(
      spec.recipeDefinitionVersionId,
      `${path}.recipeDefinitionVersionId`,
    ),
    recipeVersionNumber: requireNullableNonnegativeInteger(
      spec.recipeVersionNumber,
      `${path}.recipeVersionNumber`,
    ),
    ingredients,
  };
}

function requireRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireExactRecord<const Keys extends readonly string[]>(
  input: unknown,
  keys: Keys,
  path: string,
): Record<Keys[number], unknown> {
  const record = requireRecord(input, path);
  const allowed = new Set<string>(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${path}: extra key "${key}"`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${path}: missing key "${key}"`);
    }
  }
  return record as Record<Keys[number], unknown>;
}

function requireArray<T>(
  input: unknown,
  path: string,
  normalize: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  return input.map(normalize);
}

function requireEnum<const Values extends readonly (string | number)[]>(
  input: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (!values.includes(input as Values[number])) {
    throw new Error(`${path} has an unsupported value`);
  }
  return input as Values[number];
}

function requireNullableEnum<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
  path: string,
): Values[number] | null {
  return input === null ? null : requireEnum(input, values, path);
}

function requireEnumArray<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
  path: string,
): Values[number][] {
  return requireArray(input, path, (item, index) => requireEnum(item, values, `${path}[${index}]`));
}

function requireNonemptyString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function requireNullableNonemptyString(input: unknown, path: string): string | null {
  return input === null ? null : requireNonemptyString(input, path);
}

function requireBoolean(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') throw new Error(`${path} must be a boolean`);
  return input;
}

function requireNonnegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return input as number;
}

function requirePositiveInteger(input: unknown, path: string): number {
  const value = requireNonnegativeInteger(input, path);
  if (value < 1) throw new Error(`${path} must be a positive safe integer`);
  return value;
}

function requireNullableNonnegativeInteger(input: unknown, path: string): number | null {
  return input === null ? null : requireNonnegativeInteger(input, path);
}

function requireNullablePositiveInteger(input: unknown, path: string): number | null {
  return input === null ? null : requirePositiveInteger(input, path);
}

function requireFiniteNumber(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${path} must be a finite number`);
  }
  return input;
}

function requireNullableFiniteNumber(input: unknown, path: string): number | null {
  return input === null ? null : requireFiniteNumber(input, path);
}

function requireNullablePositiveNumber(input: unknown, path: string): number | null {
  if (input === null) return null;
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    throw new Error(`${path} must be a positive finite number or null`);
  }
  return input;
}

function requireBasisPoints(input: unknown, path: string): number {
  const value = requirePositiveInteger(input, path);
  if (value > 10_000) throw new Error(`${path} must not exceed 10,000`);
  return value;
}

function requireExactComposition(
  ingredients: WarehouseCoverageCorrectionSpecView['ingredients'],
  path: string,
): void {
  if (ingredients.length === 0) throw new Error(`${path} must not be empty`);
  const ids = new Set<string>();
  let total = 0;
  for (const ingredient of ingredients) {
    if (ids.has(ingredient.rawMaterialDefinitionId)) {
      throw new Error(`${path} contains a duplicate rawMaterialDefinitionId`);
    }
    ids.add(ingredient.rawMaterialDefinitionId);
    total += ingredient.shareBasisPoints;
  }
  if (total !== 10_000) throw new Error(`${path} must total exactly 10,000 basis points`);
}

function requireDecimalKgString(input: unknown, path: string): DecimalKgString {
  if (typeof input !== 'string' || !/^\d+(?:[.,]\d{1,3})?$/u.test(input)) {
    throw new Error(`${path} must be a positive decimal kg string`);
  }
  const value = Number(input.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive decimal kg string`);
  }
  return input;
}

function requireUtcIso(input: unknown, path: string): UtcIsoString {
  if (
    typeof input !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(input) ||
    Number.isNaN(Date.parse(input))
  ) {
    throw new Error(`${path} must be a UTC ISO timestamp`);
  }
  return input;
}

function requireNullableUtcIso(input: unknown, path: string): UtcIsoString | null {
  return input === null ? null : requireUtcIso(input, path);
}
