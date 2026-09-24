import { describe, expect, it } from 'vitest';
import { buildWarehouseCoverPlan } from './warehouseCoverPlanning';
import type { CommercialOrderPosition, RawMaterialStock } from './types';

const basePosition: CommercialOrderPosition = {
  id: 'position-1',
  draftId: 'order-1',
  rollCount: 10,
  filmType: 'Рукав',
  actualThickness: '80 мкм',
  accountingThickness: '80 мкм',
  plannedWeightKg: 12,
  rawMaterialId: 'rm-pvd-15803',
  rawMaterialLabel: 'ПВД 15803-020',
  rawMaterials: [
    {
      rawMaterialId: 'rm-pvd-15803',
      label: 'ПВД 15803-020',
      nominalQty: 120,
      unit: 'кг',
      accountingSource: 'order_entry',
    },
  ],
  spoolType: 'Тонкая',
  birka: 'Гост',
  recipeSnapshot: {
    id: 'recipe-1',
    positionId: 'position-1',
    recipeOwnerRole: 'commercial',
    parameters: [{ label: 'План. вес, кг', value: '12' }],
    source: 'commercial_form',
    createdBy: 'commercial',
    createdAt: '2026-07-08T09:00:00.000Z',
    version: 'v1',
  },
  warehouseCoverStatus: 'not_checked',
};

function stock(actualQty: number): RawMaterialStock {
  return {
    id: 'stock-1',
    rawMaterialId: 'rm-pvd-15803',
    label: 'ПВД 15803-020',
    materialKind: 'primary',
    qty: actualQty,
    actualQty,
    unit: 'кг',
    source: 'warehouse_fact',
    sourceOfTruthStatus: 'актуально',
    updatedAt: '2026-07-08T09:05:00.000Z',
  };
}

describe('buildWarehouseCoverPlan', () => {
  it('offers only partial cover and production when raw material covers part of the position', () => {
    const plan = buildWarehouseCoverPlan(basePosition, [stock(70)]);

    expect(plan.coverableRollCount).toBe(5);
    expect(plan.actions.map((action) => action.id)).toEqual(['partial', 'production']);
    expect(plan.partialInput).toBeUndefined();
  });

  it('offers partial, full, and production when raw material can cover the whole position', () => {
    const plan = buildWarehouseCoverPlan(basePosition, [stock(140)]);

    expect(plan.coverableRollCount).toBe(10);
    expect(plan.actions.map((action) => action.id)).toEqual(['partial', 'full', 'production']);
    expect(plan.partialInput).toEqual({
      min: 1,
      max: 9,
      defaultValue: 9,
      suffix: 'из 10 рул.',
    });
  });

  it('offers only production when the stock cannot cover a single roll', () => {
    const plan = buildWarehouseCoverPlan(basePosition, [stock(8)]);

    expect(plan.coverableRollCount).toBe(0);
    expect(plan.actions.map((action) => action.id)).toEqual(['production']);
  });
});
