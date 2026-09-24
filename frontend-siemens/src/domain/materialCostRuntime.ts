import type { MaterialCostReference, WorkObject } from './types';
import { auditEntryWithValues, stampNow } from './prototypeRuntime';

const manualMaterialCostValues: Record<string, string> = {
  'ПВД-15803-020': '152,00 ₽/кг',
  'ПВД-10803-020': '151,00 ₽/кг',
  'ВТОР-РЕГРАН-01': '96,00 ₽/кг',
  'ADD-COLOR-BLUE-01': '186,00 ₽/кг',
};

function manualMaterialCostValue(materialId: string) {
  return manualMaterialCostValues[materialId] ?? '100,00 ₽/кг';
}

function manualMaterialUnitPriceRub(materialId: string) {
  const match = manualMaterialCostValue(materialId).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

export function upsertManualMaterialCostReference(object: WorkObject, materialId: string): WorkObject {
  const references = object.materialCostReferences ?? [];
  const existing = references.find((item) => item.materialId === materialId);
  const nextValue = manualMaterialCostValue(materialId);
  const oldValue = existing?.valueLabel ?? 'нет цены';
  const reason = 'Ручная цена сырья/добавки для рублевого эквивалента; используется с источником и причиной до учётной сверки.';
  const nextReference: MaterialCostReference = {
    id: existing?.id ?? `MCR-${materialId}`,
    materialId,
    label: existing?.label ?? materialId,
    materialKind: existing?.materialKind,
    basis: 'material_price_reference',
    unitPriceRub: manualMaterialUnitPriceRub(materialId),
    valueLabel: nextValue,
    currency: 'RUB',
    source: 'manual_platform',
    sourceLabel: 'ручной override в платформе',
    status: 'manual_override',
    effectiveAt: '2026-07-01',
    updatedAt: stampNow(),
    updatedBy: 'Бухгалтерия',
    approvedBy: existing?.approvedBy,
    reason,
    auditTrail: [
      ...(existing?.auditTrail ?? []),
      {
        id: `a-mcr-${materialId}-${Date.now()}`,
        actorLabel: 'Бухгалтерия',
        actionLabel: 'audit:material_cost_reference_updated',
        oldValue,
        newValue: nextValue,
        reason,
        time: stampNow(),
      },
    ],
  };

  return {
    ...object,
    materialCostReferences: existing
      ? references.map((item) => (item.materialId === materialId ? nextReference : item))
      : [...references, nextReference],
    audit: [
      auditEntryWithValues(
        object.id,
        'Бухгалтерия',
        'audit:material_cost_reference_updated',
        `${nextReference.label}: задана ручная цена ${nextValue}.`,
	        { oldValue, newValue: nextValue, reason, sourceSnapshot: 'ручная проверка бухгалтерии' }
      ),
      ...object.audit,
    ],
  };
}

export function approveMaterialCostReference(object: WorkObject, materialId: string): WorkObject {
  const references = object.materialCostReferences ?? [];
  const existing = references.find((item) => item.materialId === materialId);
  const baseReference: MaterialCostReference = existing ?? {
    id: `MCR-${materialId}`,
    materialId,
    label: materialId,
    basis: 'material_price_reference',
    unitPriceRub: manualMaterialUnitPriceRub(materialId),
    valueLabel: manualMaterialCostValue(materialId),
    currency: 'RUB',
    source: 'manual_platform',
    sourceLabel: 'ручной override в платформе',
    status: 'manual_override',
    effectiveAt: '2026-07-01',
    updatedAt: stampNow(),
    updatedBy: 'Бухгалтерия',
    reason: 'Директорский override создан без учётного снимка; нужна последующая сверка.',
    auditTrail: [],
  };
  const reason = 'Директор утвердил source-aware стоимость для управленческих рублевых графиков.';
  const nextReference: MaterialCostReference = {
    ...baseReference,
    approvedBy: 'Директор',
    updatedAt: stampNow(),
    status: baseReference.status === 'source_missing' ? 'manual_override' : baseReference.status,
    auditTrail: [
      ...baseReference.auditTrail,
      {
        id: `a-mcr-${materialId}-approved-${Date.now()}`,
        actorLabel: 'Директор',
        actionLabel: 'audit:material_cost_reference_approved',
        newValue: baseReference.valueLabel,
        reason,
        time: stampNow(),
      },
    ],
  };

  return {
    ...object,
    materialCostReferences: existing
      ? references.map((item) => (item.materialId === materialId ? nextReference : item))
      : [...references, nextReference],
    audit: [
      auditEntryWithValues(
        object.id,
        'Директор',
        'audit:material_cost_reference_approved',
        `${nextReference.label}: утверждена стоимость ${nextReference.valueLabel}.`,
        { newValue: nextReference.valueLabel, reason, sourceSnapshot: nextReference.source }
      ),
      ...object.audit,
    ],
  };
}
