import { commercialWorkObjects } from './fixtures/commercial';
import {
  materialCostReferences as defaultMaterialCostReferences,
  rawMaterialStocks,
  secondaryRawMaterialMovements,
} from './inventoryContracts';
import { roleHasCapability } from './accessPolicy';
import { visibleAuditActionLabel, warehouseSourceLabel } from './displayContracts';
import {
  calculateMaterialStockCost,
  calculateRecipeMaterialCost,
  findMaterialCostReference,
  formatRub,
  sameMaterialCostId,
} from './materialCostCalculations';
import type { ActionDescriptor, AuditEntry, MaterialCostReference, RawMaterialUsageSummary, Role, Severity, WorkObject } from './types';

export type RawMaterialModuleTab = 'summary' | 'stock' | 'usage' | 'movements' | 'conflicts';

export type RawMaterialModuleSummary = {
  id: string;
  label: string;
  value: string;
  detail: string;
  severity: Severity;
};

export type RawMaterialModuleRow = {
  id: string;
  tab: RawMaterialModuleTab;
  title: string;
  subtitle: string;
  actualQty: string;
  plannedQty: string;
  recordedQty: string;
  availableQty: string;
  status: string;
  source: string;
  severity: Severity;
  details: Array<{ label: string; value: string }>;
  actions: ActionDescriptor[];
};

export type RawMaterialModuleProjection = {
  summaries: RawMaterialModuleSummary[];
  tabs: Array<{
    id: RawMaterialModuleTab;
    label: string;
    rows: RawMaterialModuleRow[];
  }>;
};

const tabLabels: Record<RawMaterialModuleTab, string> = {
  summary: 'Сводка',
  stock: 'Наличие',
  usage: 'Использование',
  movements: 'Движения',
  conflicts: 'Расхождения',
};

function sameMaterialId(left: string, right: string) {
  return sameMaterialCostId(left, right);
}

function formatQty(value: number, unit: string) {
  return `${Number(value.toFixed(1)).toLocaleString('ru-RU')} ${unit}`;
}

function auditQty(events: AuditEntry[], materialId: string, actionLabel: string) {
  return events
    .filter((event) => event.actionLabel === actionLabel && sameMaterialId(event.objectId, materialId))
    .reduce((sum, event) => {
      const source = event.newValue ?? event.detail;
      const match = source.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
      return sum + (match ? Number(match[0]) : 0);
    }, 0);
}

function plannedUsageByMaterial(materialId: string) {
  return commercialWorkObjects.reduce((sum, object) => {
    const positions = object.commercialOrder?.positions ?? [];
    return sum + positions.reduce((positionSum, position) => {
      const rawMaterials = position.rawMaterials ?? [];
      return positionSum + rawMaterials
        .filter((material) => sameMaterialId(material.rawMaterialId, materialId) || sameMaterialId(material.label, materialId))
        .reduce((materialSum, material) => materialSum + material.nominalQty, 0);
    }, 0);
  }, 0);
}

function allRecipeMaterialLines() {
  return commercialWorkObjects.flatMap((object) => object.commercialOrder?.positions.flatMap((position) => position.rawMaterials ?? []) ?? []);
}

function recipeMaterialLinesByMaterial(materialId: string) {
  return allRecipeMaterialLines().filter((material) => sameMaterialId(material.rawMaterialId, materialId) || sameMaterialId(material.label, materialId));
}

function firstRecipeFormulaByMaterial(materialId: string, costReferences: MaterialCostReference[]) {
  for (const object of commercialWorkObjects) {
    for (const position of object.commercialOrder?.positions ?? []) {
      const rawMaterials = position.rawMaterials ?? [];
      if (rawMaterials.some((material) => sameMaterialId(material.rawMaterialId, materialId) || sameMaterialId(material.label, materialId))) {
        return calculateRecipeMaterialCost(rawMaterials, costReferences, 1);
      }
    }
  }
  return undefined;
}

function recordedUsageByMaterial(materialId: string, events: AuditEntry[]) {
  return auditQty(events, materialId, 'audit:raw_material_usage_recorded');
}

function reservedQtyByMaterial(materialId: string, events: AuditEntry[]) {
  return Math.max(
    0,
    auditQty(events, materialId, 'audit:raw_material_reserved_for_order')
      - Math.abs(auditQty(events, materialId, 'audit:raw_material_reserve_released'))
  );
}

export function buildRawMaterialUsageSummaries(inventoryObject?: WorkObject): RawMaterialUsageSummary[] {
  const events = inventoryObject?.audit ?? [];
  const stocks = inventoryObject?.rawMaterialStocks ?? rawMaterialStocks;
  return stocks.map((stock) => {
    const plannedUsageQty = Math.max(plannedUsageByMaterial(stock.rawMaterialId), auditQty(events, stock.rawMaterialId, 'audit:raw_material_usage_planned'));
    const recordedUsageQty = recordedUsageByMaterial(stock.rawMaterialId, events);
    const reservedQty = reservedQtyByMaterial(stock.rawMaterialId, events);
    const availableAfterPlanQty = stock.actualQty - plannedUsageQty - reservedQty;
    const sourceStatus: RawMaterialUsageSummary['sourceStatus'] = availableAfterPlanQty < 0
      ? 'дефицит'
      : stock.sourceOfTruthStatus === 'расхождение с 1С'
        ? 'расхождение с учетом'
        : recordedUsageQty > 0
          ? 'записано событием'
          : plannedUsageQty > 0
            ? 'план'
            : 'актуально';

    return {
      rawMaterialId: stock.rawMaterialId,
      label: stock.label,
      materialKind: stock.materialKind,
      actualQty: stock.actualQty,
      plannedUsageQty,
      recordedUsageQty,
      reservedQty,
      availableAfterPlanQty,
      unit: stock.unit,
      source: stock.source,
      sourceStatus,
      lastUpdatedAt: stock.updatedAt,
      referenceQty: stock.referenceQty,
      sourceSnapshotId: stock.referenceSnapshotId,
    };
  });
}

function severityForSummary(summary: RawMaterialUsageSummary): Severity {
  if (summary.availableAfterPlanQty < 0) return 'critical';
  if (summary.sourceStatus === 'расхождение с учетом' || summary.recordedUsageQty === 0 && summary.plannedUsageQty > 0) return 'warning';
  return 'info';
}

function sourceLabel(summary: RawMaterialUsageSummary) {
  if (summary.source === 'warehouse_fact') return 'факт склада';
  if (summary.source === 'manual_platform') return 'ручной учет';
  if (summary.source === '1C' || summary.source === 'mock') return 'учетный снимок';
  return 'источник';
}

function materialCostBasisLabel(basis: MaterialCostReference['basis']) {
  const labels: Record<MaterialCostReference['basis'], string> = {
    material_price_reference: 'цена материала',
    accounting_1c: 'бухгалтерский учёт',
    manual_override: 'ручная цена',
    purchase_actual: 'факт закупки',
    weighted_average: 'средняя',
    batch: 'партия',
    unknown: 'нет basis',
  };
  return labels[basis];
}

function materialCostDetail(role: Role, costReference?: MaterialCostReference) {
  if (!roleHasCapability(role, 'material_cost.view')) return 'Скрыто по роли';
  if (!costReference || costReference.status === 'source_missing') return 'Нет цены: нужна цена сырья/добавки с источником и датой';
  return `${costReference.valueLabel} · ${materialCostBasisLabel(costReference.basis)} · ${costReference.sourceLabel} · с ${costReference.effectiveAt}`;
}

function actionsForRole(role: Role, summary: RawMaterialUsageSummary): ActionDescriptor[] {
  const actions: ActionDescriptor[] = [];

  if (roleHasCapability(role, 'raw_material.mutate_stock')) {
    actions.push({
      id: `warehouse-open-stock-mutation:${summary.rawMaterialId}`,
      label: 'Открыть форму изменения остатка',
      level: 'secondary',
      enabled: true,
      actionIntent: 'inspect',
    });
  }
  if (role === 'director' && summary.availableAfterPlanQty < 0) {
    actions.push(
      { id: `director-warehouse-override-return:${summary.rawMaterialId}`, label: 'Вернуть дефицит складу...', level: 'secondary', enabled: true, confirmation: 'Нужна причина director override' },
    );
  }
  if (roleHasCapability(role, 'material_cost.edit')) {
    actions.push({ id: `finance-edit-material-cost:${summary.rawMaterialId}`, label: 'Обновить учетную цену...', level: 'secondary', enabled: true, confirmation: 'Нужны старая цена, новая цена, источник, дата и причина изменения' });
  }
  if (roleHasCapability(role, 'material_cost.override')) {
    actions.push({ id: `director-override-material-cost:${summary.rawMaterialId}`, label: 'Утвердить / override...', level: 'secondary', enabled: true, confirmation: 'Нужна причина директорского override' });
  }
  if (roleHasCapability(role, 'material_cost.source_config')) {
    actions.push({ id: `admin-material-cost-source:${summary.rawMaterialId}`, label: 'Настроить источник цены', level: 'secondary', enabled: true, actionIntent: 'inspect' });
  }
  if (role === 'admin') {
    actions.push(
      { id: `admin-source-open:${summary.rawMaterialId}`, label: 'Открыть источник', level: 'secondary', enabled: true, actionIntent: 'inspect' },
    );
  }
  return actions;
}

function baseRow(tab: RawMaterialModuleTab, role: Role, summary: RawMaterialUsageSummary, costReferences: MaterialCostReference[]): RawMaterialModuleRow {
  const severity = severityForSummary(summary);
  const accountingDetail = roleHasCapability(role, 'raw_material.view_accounting_reference')
    ? `${summary.referenceQty ?? 'нет'} ${summary.referenceQty ? summary.unit : ''}`.trim()
    : 'Скрыто по роли';
  const costReference = findMaterialCostReference(summary.rawMaterialId, costReferences);
  const canViewCost = roleHasCapability(role, 'material_cost.view');
  const stockCost = canViewCost ? calculateMaterialStockCost(summary, costReference) : undefined;
  const recipeMaterialLines = recipeMaterialLinesByMaterial(summary.rawMaterialId);
  const plannedCost = canViewCost ? calculateRecipeMaterialCost(recipeMaterialLines, costReferences) : undefined;
  const defectFormula = canViewCost ? firstRecipeFormulaByMaterial(summary.rawMaterialId, costReferences) : undefined;
  const materialKindLabel = summary.materialKind === 'primary'
    ? 'Первичное сырье'
    : summary.materialKind === 'secondary'
      ? 'Вторичное сырье'
      : summary.materialKind === 'additive'
        ? 'Добавка'
        : 'Категория не указана';

  return {
    id: `${tab}:${summary.rawMaterialId}`,
    tab,
    title: summary.label,
    subtitle: materialKindLabel,
    actualQty: formatQty(summary.actualQty, summary.unit),
    plannedQty: formatQty(summary.plannedUsageQty, summary.unit),
    recordedQty: summary.recordedUsageQty > 0 ? formatQty(summary.recordedUsageQty, summary.unit) : 'нет события',
    availableQty: formatQty(summary.availableAfterPlanQty, summary.unit),
    status: summary.sourceStatus,
    source: sourceLabel(summary),
    severity,
    details: [
      { label: 'Стоимость', value: materialCostDetail(role, costReference) },
      { label: 'Рублевый остаток', value: canViewCost ? stockCost?.summaryLabel ?? 'Нет расчета' : 'Скрыто по роли' },
      { label: 'План в рублях', value: canViewCost ? plannedCost?.summaryLabel ?? 'Нет строк рецептуры' : 'Скрыто по роли' },
      { label: 'Расчет брака/перерасхода', value: canViewCost ? defectFormula?.formulaLabel ?? 'Нет структурной рецептуры' : 'Скрыто по роли' },
      { label: 'Источник расчета', value: canViewCost ? defectFormula?.sourceLabel ?? stockCost?.sourceLabel ?? 'Нужна цена сырья/добавки' : 'Скрыто по роли' },
      { label: 'Факт склада', value: formatQty(summary.actualQty, summary.unit) },
      { label: 'План по заказам', value: formatQty(summary.plannedUsageQty, summary.unit) },
      { label: 'Записанное использование', value: summary.recordedUsageQty > 0 ? formatQty(summary.recordedUsageQty, summary.unit) : 'Нет события расхода' },
      { label: 'Резерв под заказ', value: formatQty(summary.reservedQty, summary.unit) },
      { label: 'По учету', value: accountingDetail },
      { label: 'Расчет остатка', value: canViewCost ? stockCost?.formulaLabel ?? 'Нет расчета' : 'Скрыто по роли' },
      { label: 'Обновлено', value: summary.lastUpdatedAt },
    ],
    actions: actionsForRole(role, summary),
  };
}

function summaryRows(role: Role, summaries: RawMaterialUsageSummary[], costReferences: MaterialCostReference[]) {
  return summaries.map((summary) => baseRow('summary', role, summary, costReferences));
}

function movementRows(role: Role, inventoryObject?: WorkObject): RawMaterialModuleRow[] {
  const auditRows: RawMaterialModuleRow[] = (inventoryObject?.audit ?? [])
    .filter((event) => [
      'audit:raw_material_usage_planned',
      'audit:raw_material_usage_recorded',
      'audit:raw_material_reserved_for_order',
      'audit:raw_material_stock_adjusted',
      'audit:material_received',
      'audit:raw_material_reserve_released',
      'problem:raw_material_shortage',
      'problem:inventory_source_conflict',
      'problem:inventory_mutation_blocked',
    ].includes(event.actionLabel))
    .map((event) => ({
      id: `movement:${event.id}`,
      tab: 'movements' as const,
      title: visibleAuditActionLabel(event.actionLabel),
      subtitle: event.detail,
      actualQty: event.newValue ?? event.time,
      plannedQty: event.oldValue ?? 'нет',
      recordedQty: event.actorLabel,
      availableQty: event.time,
      status: event.actionLabel.startsWith('problem:') ? 'Проблема' : 'История',
      source: warehouseSourceLabel(event.sourceSnapshot ?? 'audit/source layer'),
      severity: event.actionLabel.startsWith('problem:') ? 'warning' as const : 'info' as const,
      details: [
        { label: 'Кто', value: event.actorLabel },
        { label: 'Когда', value: event.time },
        { label: 'Событие', value: visibleAuditActionLabel(event.actionLabel) },
        { label: 'Было', value: event.oldValue ?? 'Нет' },
        { label: 'Стало', value: event.newValue ?? 'Нет' },
      ],
      actions: [],
    }));

  const transferRows: RawMaterialModuleRow[] = roleHasCapability(role, 'raw_material.view_usage')
    ? secondaryRawMaterialMovements.map((movement) => ({
      id: `movement:${movement.id}`,
      tab: 'movements' as const,
      title: `${movement.fromWorkshop} -> ${movement.toWorkshop}`,
      subtitle: movement.rawMaterialId,
      actualQty: formatQty(movement.qty, movement.unit),
      plannedQty: movement.status === 'signed' ? 'движение учтено' : 'до подписи',
      recordedQty: movement.status === 'signed' ? formatQty(movement.qty, movement.unit) : 'нет события',
      availableQty: movement.status === 'signed' ? `+${formatQty(movement.qty, movement.unit)}` : 'не меняется',
      status: movement.status === 'requires_second_signature' ? 'Ждет второй подписи' : movement.status === 'signed' ? 'Подписано' : movement.status === 'rejected' ? 'Отклонено' : 'Черновик',
      source: 'ручной учет',
      severity: movement.status === 'requires_second_signature' ? 'warning' as const : movement.status === 'rejected' ? 'critical' as const : 'info' as const,
      details: [
        { label: 'Материал', value: movement.rawMaterialId },
        { label: 'Подписи', value: movement.signatures.map((item) => `${item.signerLabel}: ${item.signedAt ? 'подписано' : 'не подписано'}`).join('; ') },
        { label: 'Создано', value: movement.createdAt },
      ],
      actions: roleHasCapability(role, 'raw_material.mutate_stock')
        ? [{ id: `warehouse-sign-secondary-transfer:${movement.id}`, label: 'Подписать перемещение', level: 'recommended', enabled: movement.status === 'requires_second_signature' }]
        : [],
    }))
    : [];

  return [...auditRows, ...transferRows];
}

function conflictRows(role: Role, summaries: RawMaterialUsageSummary[], costReferences: MaterialCostReference[]) {
  return summaries
    .filter((summary) => summary.sourceStatus === 'расхождение с учетом' || summary.availableAfterPlanQty < 0)
    .map((summary) => baseRow('conflicts', role, summary, costReferences));
}

export function buildRawMaterialModuleProjection(role: Role, inventoryObject?: WorkObject): RawMaterialModuleProjection {
  const summaries = buildRawMaterialUsageSummaries(inventoryObject);
  const costReferences = inventoryObject?.materialCostReferences ?? defaultMaterialCostReferences;
  const canViewCost = roleHasCapability(role, 'material_cost.view');
  const totalActualKg = summaries.reduce((sum, summary) => sum + (summary.unit === 'кг' ? summary.actualQty : 0), 0);
  const totalPlannedKg = summaries.reduce((sum, summary) => sum + (summary.unit === 'кг' ? summary.plannedUsageQty : 0), 0);
  const totalRecordedKg = summaries.reduce((sum, summary) => sum + (summary.unit === 'кг' ? summary.recordedUsageQty : 0), 0);
  const plannedRecipeCost = canViewCost ? calculateRecipeMaterialCost(allRecipeMaterialLines(), costReferences) : undefined;
  const stockRubleTotal = canViewCost
    ? summaries.reduce((sum, summary) => {
      const calculation = calculateMaterialStockCost(summary, findMaterialCostReference(summary.rawMaterialId, costReferences));
      return sum + (calculation.totalRub ?? 0);
    }, 0)
    : 0;
  const missingCostCount = canViewCost
    ? summaries.filter((summary) => calculateMaterialStockCost(summary, findMaterialCostReference(summary.rawMaterialId, costReferences)).status !== 'ready').length
    : 0;
  const shortageCount = summaries.filter((summary) => summary.availableAfterPlanQty < 0).length;
  const conflictCount = summaries.filter((summary) => summary.sourceStatus === 'расхождение с учетом').length;
  const movement = movementRows(role, inventoryObject);
  const conflicts = conflictRows(role, summaries, costReferences);

  return {
    summaries: [
      { id: 'actual', label: 'Факт склада', value: formatQty(totalActualKg, 'кг'), detail: `${summaries.length} позиции`, severity: conflictCount > 0 ? 'warning' : 'info' },
      { id: 'planned', label: 'План расхода', value: formatQty(totalPlannedKg, 'кг'), detail: 'по позициям заказов', severity: totalPlannedKg > totalActualKg ? 'critical' : 'info' },
      { id: 'recorded', label: 'Записано расхода', value: totalRecordedKg > 0 ? formatQty(totalRecordedKg, 'кг') : '0 кг', detail: totalRecordedKg > 0 ? 'по событиям' : 'нет событий расхода', severity: totalRecordedKg > 0 ? 'info' : 'warning' },
      { id: 'ruble-plan', label: 'Рублевый план', value: canViewCost ? plannedRecipeCost?.summaryLabel ?? 'нет расчета' : 'скрыто', detail: 'цены сырья/добавок × рецептура', severity: plannedRecipeCost?.status === 'missing_cost' ? 'warning' : 'info' },
      { id: 'ruble-stock', label: 'Остатки в ₽', value: canViewCost ? formatRub(stockRubleTotal) : 'скрыто', detail: missingCostCount > 0 ? `без цены: ${missingCostCount}` : 'по price reference', severity: missingCostCount > 0 ? 'warning' : 'info' },
      { id: 'risks', label: 'Риски', value: String(shortageCount + conflictCount), detail: `дефицит: ${shortageCount}, расхождения: ${conflictCount}`, severity: shortageCount > 0 ? 'critical' : conflictCount > 0 ? 'warning' : 'info' },
    ],
    tabs: [
      { id: 'summary', label: tabLabels.summary, rows: summaryRows(role, summaries, costReferences) },
      { id: 'stock', label: tabLabels.stock, rows: summaries.map((summary) => baseRow('stock', role, summary, costReferences)) },
      { id: 'usage', label: tabLabels.usage, rows: roleHasCapability(role, 'raw_material.view_usage') ? summaries.map((summary) => baseRow('usage', role, summary, costReferences)) : [] },
      { id: 'movements', label: tabLabels.movements, rows: movement },
      { id: 'conflicts', label: tabLabels.conflicts, rows: conflicts },
    ],
  };
}
