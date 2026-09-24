import assert from 'node:assert/strict';

export const SHARED_BUSINESS_SECTIONS = [
  'Контроль',
  'Финансы',
  'Производство',
  'Склад',
  'Проблемы',
];

const PAGE_FIELDS = ['items', 'nextCursor', 'source'];
const SOURCE_FIELDS = ['freshness', 'generatedAt', 'kind', 'status'];
const CONTROL_FIELDS = [
  'accountingProduction',
  'commercialApplications',
  'productionQualitySeries',
  'productionSeries',
  'range',
  'source',
  'summary',
];
const CONTROL_RANGE_FIELDS = ['bucket', 'effective', 'generatedAt', 'requested', 'timezone'];
const CONTROL_REQUESTED_RANGE_FIELDS = ['from', 'to'];
const CONTROL_EFFECTIVE_RANGE_FIELDS = ['fromUtc', 'toExclusiveUtc'];
const CONTROL_SUMMARY_FIELDS = [
  'defectKg',
  'defectRollCount',
  'invoicedAmount',
  'overdueAmount',
  'paidAmount',
  'producedKg',
  'producedRolls',
  'receivableAmount',
  'returnedSpoolCount',
  'warehouseAcceptedRolls',
];
const CONTROL_PRODUCTION_POINT_FIELDS = ['bucketStartDate', 'producedKg', 'rollCount'];
const CONTROL_PRODUCTION_QUALITY_POINT_FIELDS = [
  'bucketStartDate',
  'defectRecordCount',
  'defectiveRollCount',
  'id',
  'producedKg',
  'producedRollCount',
  'returnedSpoolCount',
  'unverifiedDefectCount',
  'verifiedDefectKg',
];
const ACCOUNTING_PRODUCTION_FIELDS = ['coverage', 'materialSeries', 'productionSeries', 'source'];
const ACCOUNTING_SOURCE_FIELDS = [
  'label',
  'latestDocumentDate',
  'latestImportedAt',
  'sourceKind',
  'stale',
];
const ACCOUNTING_COVERAGE_FIELDS = [
  'documentCount',
  'excludedMaterialLineCount',
  'excludedOutputLineCount',
];
const ACCOUNTING_PRODUCTION_POINT_FIELDS = ['bucketStartDate', 'documentCount', 'producedKg'];
const ACCOUNTING_MATERIAL_POINT_FIELDS = ['bucketStartDate', 'consumedKg'];
const COMMERCIAL_APPLICATION_FIELDS = ['asOfDate', 'definition', 'periods'];
const COMMERCIAL_APPLICATION_PERIOD_FIELDS = [
  'clientOrderCount',
  'fromDate',
  'period',
  'stockReserveCount',
  'toDate',
  'totalCount',
];
const FINANCE_FIELDS = [
  'counterpartyName',
  'id',
  'invoiceStatus',
  'invoicedAmount',
  'nextConfirmedDueAt',
  'orderNumber',
  'paidAmount',
  'paymentPlanKind',
  'paymentPlanLabel',
  'paymentStatus',
  'remainingAmount',
  'updatedAt',
];
const PRODUCTION_FIELDS = [
  'actualKg',
  'completedAt',
  'completedRollCount',
  'createdAt',
  'defectKg',
  'defectRollCount',
  'id',
  'lifecycleStatus',
  'orderNumber',
  'plannedKg',
  'plannedRollCount',
  'productionStatus',
  'returnedSpoolCount',
  'updatedAt',
];
const WAREHOUSE_PAGE_FIELDS = ['items', 'page', 'pageSize', 'total'];
const WAREHOUSE_ROW_FIELDS = [
  'counterpartyName',
  'id',
  'kind',
  'orderNumber',
  'status',
  'templates',
];
const WAREHOUSE_TEMPLATE_FIELDS = [
  'accountingThicknessMicron',
  'actualThicknessMicron',
  'birka',
  'filmType',
  'fingerprint',
  'plannedLengthM',
  'plannedWeightKg',
  'recipeVersion',
  'spoolType',
  'widthMm',
];
const ROLL_FIELDS = [
  'completedAt',
  'createdAt',
  'id',
  'lifecycleStatus',
  'machineName',
  'operatorName',
  'orderNumber',
  'parameters',
  'priority',
  'productionCost',
  'rollCode',
  'rollName',
  'status',
  'weights',
];
const ROLL_PARAMETER_FIELDS = [
  'accountingThicknessUm',
  'actualThicknessUm',
  'filmType',
  'plannedLengthM',
  'weightKg',
  'widthMm',
];
const ROLL_WEIGHT_FIELDS = ['actualGrossKg', 'actualNetKg', 'deviationKg', 'plannedNetKg'];
const ROLL_COST_AMOUNT_FIELDS = [
  'additionalAmountKopecks',
  'materialAmountKopecks',
  'payrollAmountKopecks',
  'payrollSource',
  'spoolAmountKopecks',
  'totalAmountKopecks',
  'totalKopecksPerKg',
  'unresolvedReasons',
];
const ROLL_COST_PAYROLL_SOURCE_FIELDS = [
  'basisLabel',
  'effectiveFrom',
  'rateKopecksPerKg',
  'tariffOrderId',
  'tariffOrderName',
];
const ROLL_COST_PLANNED_FIELDS = [
  'basis',
  'calculationVersion',
  'kind',
  ...ROLL_COST_AMOUNT_FIELDS,
  'status',
];
const ROLL_COST_SNAPSHOT_FIELDS = [
  'basis',
  'calculationVersion',
  'closedAt',
  'createdAt',
  'kind',
  ...ROLL_COST_AMOUNT_FIELDS,
  'producedAt',
  'snapshotId',
  'status',
  'version',
];
const ROLL_COST_REASONS = [
  'weight_unresolved',
  'material_usage_unresolved',
  'material_price_unresolved',
  'spool_type_unresolved',
  'spool_price_unresolved',
  'spool_geometry_unresolved',
  'payroll_unresolved',
  'order_cost_allocation_unresolved',
  'additional_cost_unresolved',
  'canonical_capture_unresolved',
  'defect_present',
  'operator_step_unresolved',
  'dispatch_not_completed',
  'post_session_not_closed',
  'machine_assignment_not_completed',
  'shift_not_closed',
  'snapshot_pending',
];
const PROBLEM_FIELDS = [
  'createdAt',
  'id',
  'kind',
  'label',
  'machineName',
  'orderId',
  'orderNumber',
  'reason',
  'rollCode',
  'status',
];
const PAYMENT_LABELS = {
  full: '100%',
  half_split: '50/50',
  custom: 'Индивидуально',
  not_set: 'Не задано',
};

function record(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function assertExactFields(value, fields, label) {
  const actual = Object.keys(record(value, label)).sort();
  assert.deepEqual(actual, [...fields].sort(), `${label} fields must match the safe allowlist`);
}

function assertPage(value, fields, label) {
  assertExactFields(value, PAGE_FIELDS, `${label} page`);
  assert(Array.isArray(value.items), `${label} items must be an array`);
  assertExactFields(value.source, SOURCE_FIELDS, `${label} source`);
  value.items.forEach((item, index) => assertExactFields(item, fields, `${label} item ${index}`));
}

function assertFinancePage(value) {
  assertPage(value, FINANCE_FIELDS, 'finance');
  for (const item of value.items) {
    assert.equal(
      PAYMENT_LABELS[item.paymentPlanKind],
      item.paymentPlanLabel,
      `payment plan label must match kind ${String(item.paymentPlanKind)}`,
    );
  }
}

function assertWarehousePage(value, label) {
  assertExactFields(value, WAREHOUSE_PAGE_FIELDS, `${label} page`);
  assert(Array.isArray(value.items), `${label} items must be an array`);
  assert(Number.isSafeInteger(value.page) && value.page >= 1, `${label} page must be positive`);
  assert(
    Number.isSafeInteger(value.pageSize) && value.pageSize >= 1 && value.pageSize <= 100,
    `${label} pageSize must be bounded`,
  );
  assert(Number.isSafeInteger(value.total) && value.total >= 0, `${label} total must be safe`);
  assert(value.items.length <= value.pageSize, `${label} page exceeds pageSize`);
  assert(value.items.length <= value.total, `${label} page exceeds total`);
  value.items.forEach((item, index) => {
    const itemLabel = `${label} item ${index}`;
    assertExactFields(item, WAREHOUSE_ROW_FIELDS, itemLabel);
    assert(['client_order', 'reserve'].includes(item.kind), `${itemLabel} kind is invalid`);
    assert(typeof item.id === 'string' && item.id.trim(), `${itemLabel} id is invalid`);
    assert(
      ['awaiting_shipment', 'reserve', 'processing'].includes(item.status),
      `${itemLabel} status is invalid`,
    );
    for (const key of ['orderNumber', 'counterpartyName']) {
      assert(item[key] === null || typeof item[key] === 'string', `${itemLabel} ${key} is invalid`);
    }
    assert(Array.isArray(item.templates), `${itemLabel} templates must be an array`);
    item.templates.forEach((template, templateIndex) => {
      const templateLabel = `${itemLabel} template ${templateIndex}`;
      assertExactFields(template, WAREHOUSE_TEMPLATE_FIELDS, templateLabel);
      assert(/^[a-f0-9]{64}$/u.test(template.fingerprint), `${templateLabel} fingerprint`);
      for (const key of ['filmType', 'birka', 'spoolType']) {
        assert(
          typeof template[key] === 'string' && template[key].trim(),
          `${templateLabel} ${key}`,
        );
      }
      for (const key of [
        'actualThicknessMicron',
        'accountingThicknessMicron',
        'widthMm',
        'plannedLengthM',
        'plannedWeightKg',
      ]) {
        assert(
          typeof template[key] === 'number' && Number.isFinite(template[key]) && template[key] > 0,
          `${templateLabel} ${key}`,
        );
      }
      assert(
        template.recipeVersion === null || typeof template.recipeVersion === 'string',
        `${templateLabel} recipeVersion`,
      );
    });
  });
}

function assertArrayItems(value, fields, label) {
  assert(Array.isArray(value), `${label} must be an array`);
  value.forEach((item, index) => assertExactFields(item, fields, `${label} item ${index}`));
}

function assertSafeMoney(value, label, nullable = false) {
  if (nullable && value === null) return;
  assert(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be safe non-negative integer kopecks`,
  );
}

function assertCanonicalIso(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp), `${label} must be a finite timestamp`);
  assert.equal(new Date(timestamp).toISOString(), value, `${label} must be canonical ISO`);
}

function assertCanonicalDate(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(value), `${label} must be a canonical calendar date`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  assert(Number.isFinite(timestamp), `${label} must be a canonical calendar date`);
  assert.equal(
    new Date(timestamp).toISOString().slice(0, 10),
    value,
    `${label} must be a canonical calendar date`,
  );
}

function assertPayrollSource(source, label) {
  if (source === null) return;
  assertExactFields(source, ROLL_COST_PAYROLL_SOURCE_FIELDS, `${label} payroll source`);
  for (const field of ['tariffOrderId', 'tariffOrderName', 'basisLabel']) {
    assert.equal(typeof source[field], 'string', `${label} payroll source ${field}`);
    assert(source[field].trim().length > 0, `${label} payroll source ${field} must be non-empty`);
  }
  assertCanonicalDate(source.effectiveFrom, `${label} payroll source effectiveFrom`);
  assertSafeMoney(source.rateKopecksPerKg, `${label} payroll source rate`);
}

function assertRollCost(cost, label) {
  record(cost, label);
  if (cost.kind === 'planned_preview' || cost.kind === 'actual_pending') {
    assertExactFields(cost, ROLL_COST_PLANNED_FIELDS, `${label} production cost`);
  } else if (cost.kind === 'actual_snapshot') {
    assertExactFields(cost, ROLL_COST_SNAPSHOT_FIELDS, `${label} production cost`);
  } else {
    assert.fail(`${label} production cost has an unknown kind`);
  }

  assertExactFields(cost.basis, ['kind', 'weightGrams'], `${label} production cost basis`);
  const expectedBasisKind = cost.kind === 'planned_preview' ? 'planned' : 'actual';
  assert.equal(cost.basis.kind, expectedBasisKind, `${label} production cost basis kind`);
  if (cost.kind === 'actual_pending' && cost.basis.weightGrams === null) {
    // A pending actual snapshot may legitimately wait for the canonical weight.
  } else {
    assert(
      Number.isSafeInteger(cost.basis.weightGrams) && cost.basis.weightGrams > 0,
      `${label} production cost weight must be a positive safe integer`,
    );
  }

  if (cost.kind === 'planned_preview' || cost.kind === 'actual_pending') {
    assert.equal(
      cost.calculationVersion,
      'production-cost-v1',
      `${label} production cost calculation version`,
    );
  } else {
    assert.equal(typeof cost.calculationVersion, 'string');
    assert(cost.calculationVersion.length > 0, `${label} production cost calculation version`);
    assert.equal(typeof cost.snapshotId, 'string');
    assert(cost.snapshotId.length > 0, `${label} production cost snapshot id`);
    assert(Number.isSafeInteger(cost.version) && cost.version > 0, `${label} snapshot version`);
    assertCanonicalIso(cost.producedAt, `${label} producedAt`);
    assertCanonicalIso(cost.closedAt, `${label} closedAt`);
    assertCanonicalIso(cost.createdAt, `${label} createdAt`);
  }

  const complete = cost.status === 'complete';
  const partial = cost.status === 'partial' || cost.status === 'pending';
  if (cost.kind === 'actual_pending') assert.equal(cost.status, 'pending');
  else assert(complete || cost.status === 'partial', `${label} production cost status`);

  assertSafeMoney(cost.materialAmountKopecks, `${label} material`, partial);
  assertSafeMoney(cost.spoolAmountKopecks, `${label} spool`, partial);
  assertSafeMoney(cost.payrollAmountKopecks, `${label} payroll`, partial);
  assertPayrollSource(cost.payrollSource, label);
  assertSafeMoney(cost.additionalAmountKopecks, `${label} additional`);
  assert(Array.isArray(cost.unresolvedReasons), `${label} unresolved reasons must be an array`);
  assert(
    cost.unresolvedReasons.every((reason) => ROLL_COST_REASONS.includes(reason)),
    `${label} unresolved reason must be known`,
  );
  const reasonIndexes = cost.unresolvedReasons.map((reason) => ROLL_COST_REASONS.indexOf(reason));
  assert(
    reasonIndexes.every(
      (reasonIndex, index) => index === 0 || reasonIndex > reasonIndexes[index - 1],
    ),
    `${label} unresolved reasons must be canonical and unique`,
  );
  if (complete) {
    assertSafeMoney(cost.totalAmountKopecks, `${label} total`);
    assertSafeMoney(cost.totalKopecksPerKg, `${label} per kg`);
    assert.equal(cost.unresolvedReasons.length, 0, `${label} complete reasons must be empty`);
  } else {
    assert.equal(cost.totalAmountKopecks, null, `${label} partial total must be null`);
    assert.equal(cost.totalKopecksPerKg, null, `${label} partial per kg must be null`);
    assert(cost.unresolvedReasons.length > 0, `${label} partial reasons must be non-empty`);
  }
}

function assertControl(value, label) {
  assertExactFields(value, CONTROL_FIELDS, label);
  assertExactFields(value.source, SOURCE_FIELDS, `${label} source`);

  assertExactFields(value.range, CONTROL_RANGE_FIELDS, `${label} range`);
  assertExactFields(
    value.range.requested,
    CONTROL_REQUESTED_RANGE_FIELDS,
    `${label} range requested`,
  );
  assertExactFields(
    value.range.effective,
    CONTROL_EFFECTIVE_RANGE_FIELDS,
    `${label} range effective`,
  );
  assertExactFields(value.summary, CONTROL_SUMMARY_FIELDS, `${label} summary`);
  assertArrayItems(
    value.productionSeries,
    CONTROL_PRODUCTION_POINT_FIELDS,
    `${label} production series`,
  );
  assertArrayItems(
    value.productionQualitySeries,
    CONTROL_PRODUCTION_QUALITY_POINT_FIELDS,
    `${label} production quality series`,
  );

  assertExactFields(
    value.accountingProduction,
    ACCOUNTING_PRODUCTION_FIELDS,
    `${label} accounting production`,
  );
  assertExactFields(
    value.accountingProduction.source,
    ACCOUNTING_SOURCE_FIELDS,
    `${label} accounting source`,
  );
  assertExactFields(
    value.accountingProduction.coverage,
    ACCOUNTING_COVERAGE_FIELDS,
    `${label} accounting coverage`,
  );
  assertArrayItems(
    value.accountingProduction.productionSeries,
    ACCOUNTING_PRODUCTION_POINT_FIELDS,
    `${label} accounting production series`,
  );
  assertArrayItems(
    value.accountingProduction.materialSeries,
    ACCOUNTING_MATERIAL_POINT_FIELDS,
    `${label} accounting material series`,
  );

  assertExactFields(
    value.commercialApplications,
    COMMERCIAL_APPLICATION_FIELDS,
    `${label} commercial applications`,
  );
  assertArrayItems(
    value.commercialApplications.periods,
    COMMERCIAL_APPLICATION_PERIOD_FIELDS,
    `${label} commercial application periods`,
  );
}

function normalizedRolePayload(section, payload) {
  const normalized = structuredClone(payload);
  if (section === 'Контроль') {
    normalized.range.generatedAt = '<generated-at>';
    normalized.source.generatedAt = '<generated-at>';
  } else if (section !== 'Проблемы' && section !== 'Склад') {
    normalized.source.generatedAt = '<generated-at>';
  }
  return normalized;
}

export function assertSafeBusinessRollPage(value) {
  assertExactFields(value, ['items', 'nextCursor'], 'roll page');
  assert(Array.isArray(value.items), 'roll items must be an array');
  value.items.forEach((item, index) => {
    assertExactFields(item, ROLL_FIELDS, `roll item ${index}`);
    assertExactFields(item.parameters, ROLL_PARAMETER_FIELDS, `roll item ${index} parameters`);
    assertExactFields(item.weights, ROLL_WEIGHT_FIELDS, `roll item ${index} weights`);
    assert.equal(
      item.status,
      item.lifecycleStatus,
      `roll item ${index} status must match its canonical lifecycleStatus`,
    );
    assertRollCost(item.productionCost, `roll item ${index}`);
  });
}

export function assertSafeBusinessProblemPage(value) {
  assertExactFields(value, ['items', 'nextCursor'], 'problem page');
  assert(Array.isArray(value.items), 'problem items must be an array');
  value.items.forEach((item, index) => {
    assertExactFields(item, PROBLEM_FIELDS, `problem item ${index}`);
    assert(
      item.orderId === null || typeof item.orderId === 'string',
      `problem item ${index} orderId must be a nullable string`,
    );
    assert(
      [
        'weight_deviation',
        'general',
        'raw_material_shortage',
        'defect',
        'machine_breakdown',
      ].includes(item.kind),
      `problem item ${index} has an unknown kind`,
    );
    assert(
      ['open', 'resolved'].includes(item.status),
      `problem item ${index} has an unknown status`,
    );
  });
}

export function assertBusinessPerformanceRoleParity(section, commercial, director) {
  assert(SHARED_BUSINESS_SECTIONS.includes(section), `unknown shared section: ${section}`);

  if (section === 'Контроль') {
    assertControl(commercial, 'commercial control');
    assertControl(director, 'director control');
  } else if (section === 'Финансы') {
    assertFinancePage(commercial);
    assertFinancePage(director);
  } else if (section === 'Производство') {
    assertPage(commercial, PRODUCTION_FIELDS, 'commercial production');
    assertPage(director, PRODUCTION_FIELDS, 'director production');
  } else if (section === 'Склад') {
    assertWarehousePage(commercial, 'commercial warehouse');
    assertWarehousePage(director, 'director warehouse');
  } else {
    assertSafeBusinessProblemPage(commercial);
    assertSafeBusinessProblemPage(director);
  }

  assert.deepEqual(
    normalizedRolePayload(section, commercial),
    normalizedRolePayload(section, director),
    `${section} commercial/director payload mismatch`,
  );
}
