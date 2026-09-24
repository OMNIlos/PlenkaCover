import { ConflictException } from '@nestjs/common';
import {
  assertCoverageWorkflow,
  validateV2CoverageCompleteness,
  workflowVersionForNewOrder,
} from './warehouse-coverage-workflow';

function completeOrder() {
  return {
    counterpartyId: 'counterparty-1',
    positions: [
      {
        id: 'position-1',
        rollCount: 2,
        filmType: ' Плёнка  ПЭ ',
        actualThickness: '80 мкм',
        accountingThickness: '78,5 мкм',
        widthMm: 1700,
        plannedLengthM: 275,
        birka: ' ГОСТ ',
        spoolType: 'Шпуля 76 мм',
        plannedWeightKg: 275.125,
        baseRawMaterialDefinitionId: null,
        recipeDefinitionVersionId: 'recipe-version-3',
        recipe: {
          id: 'snapshot-1',
          version: 'v3',
          recipeDefinitionId: 'recipe-1',
          recipeDefinitionVersionId: 'recipe-version-3',
          recipeVersionNumber: 3,
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-b',
              name: 'Краситель',
              shareBasisPoints: 2_000,
            },
            {
              rawMaterialDefinitionId: 'material-a',
              name: 'ПВД',
              shareBasisPoints: 8_000,
            },
          ],
        },
      },
    ],
  };
}

describe('warehouse coverage workflow', () => {
  it('maps the rollout decision to one immutable workflow version', () => {
    expect(workflowVersionForNewOrder(false)).toBe(1);
    expect(workflowVersionForNewOrder(true)).toBe(2);
  });

  it('returns a stable explicit 409 payload for cross-workflow commands', () => {
    expect(() => assertCoverageWorkflow(2, 1)).toThrow(ConflictException);
    try {
      assertCoverageWorkflow(2, 1);
    } catch (error) {
      expect((error as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        code: 'warehouse_coverage_workflow_mismatch',
        expected: 1,
        actual: 2,
      });
    }

    expect(() => assertCoverageWorkflow(1, 2)).toThrow(
      expect.objectContaining({
        response: {
          statusCode: 409,
          code: 'warehouse_coverage_workflow_mismatch',
          expected: 2,
          actual: 1,
        },
      }),
    );
  });

  it('canonicalizes a complete persisted order and strips display-only ingredient names', () => {
    expect(validateV2CoverageCompleteness(completeOrder())).toEqual({
      ok: true,
      positions: [
        {
          positionId: 'position-1',
          rollCount: 2,
          filmType: 'пленка пэ',
          actualThicknessMilliMicron: 80_000,
          accountingThicknessMilliMicron: 78_500,
          widthMilliMm: 1_700_000,
          plannedLengthMilliM: 275_000,
          birka: 'гост',
          spoolType: '76 мм',
          plannedWeightMilliKg: 275_125,
          ingredients: [
            { rawMaterialDefinitionId: 'material-a', shareBasisPoints: 8_000 },
            { rawMaterialDefinitionId: 'material-b', shareBasisPoints: 2_000 },
          ],
          recipeId: 'snapshot-1',
          recipeVersion: 'v3',
          recipeDefinitionId: 'recipe-1',
          recipeDefinitionVersionId: 'recipe-version-3',
          recipeVersionNumber: 3,
        },
      ],
    });
  });

  it('uses the manual label when a catalog label was not selected', () => {
    const order = completeOrder();
    Object.assign(order.positions[0]!, { birka: null, manualBirka: ' Маркировка клиента ' });

    expect(validateV2CoverageCompleteness(order)).toMatchObject({
      ok: true,
      positions: [{ birka: 'маркировка клиента' }],
    });
  });

  it('accepts a frozen base-material snapshot only when its one ingredient is exact', () => {
    const order = completeOrder();
    Object.assign(order.positions[0]!, {
      baseRawMaterialDefinitionId: 'material-a',
      recipeDefinitionVersionId: null,
      recipe: {
        id: 'snapshot-base',
        version: 'v1',
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        ingredients: [
          {
            rawMaterialDefinitionId: 'material-a',
            name: 'ПВД',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });

    expect(validateV2CoverageCompleteness(order)).toMatchObject({
      ok: true,
      positions: [
        {
          ingredients: [{ rawMaterialDefinitionId: 'material-a', shareBasisPoints: 10_000 }],
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeVersionNumber: null,
        },
      ],
    });
  });

  it('rejects a base-material snapshot whose ingredient identity is not exact', () => {
    const order = completeOrder();
    Object.assign(order.positions[0]!, {
      baseRawMaterialDefinitionId: 'material-a',
      recipeDefinitionVersionId: null,
      recipe: {
        id: 'snapshot-base',
        version: 'v1',
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        ingredients: [
          {
            rawMaterialDefinitionId: 'different-material',
            name: 'ПВД',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });

    expect(validateV2CoverageCompleteness(order)).toEqual({
      ok: false,
      reasonCode: 'order_spec_incomplete',
      missing: ['positions[0].materialSelection'],
    });
  });

  it.each([
    {
      name: 'both material selectors',
      change: {
        baseRawMaterialDefinitionId: 'material-a',
        recipeDefinitionVersionId: 'recipe-version-3',
      },
    },
    {
      name: 'catalog snapshot selector mismatch',
      change: { recipeDefinitionVersionId: 'different-version' },
    },
    {
      name: 'legacy snapshot without a structured selector',
      change: {
        baseRawMaterialDefinitionId: null,
        recipeDefinitionVersionId: null,
      },
    },
    {
      name: 'malformed base selector beside a valid catalog selector',
      change: {
        baseRawMaterialDefinitionId: ' ',
        recipeDefinitionVersionId: 'recipe-version-3',
      },
    },
  ])('rejects $name as incomplete provenance', ({ change }) => {
    const order = completeOrder();
    Object.assign(order.positions[0]!, change);

    expect(validateV2CoverageCompleteness(order)).toEqual({
      ok: false,
      reasonCode: 'order_spec_incomplete',
      missing: ['positions[0].materialSelection'],
    });
  });

  it.each([0, Number.POSITIVE_INFINITY, 1.0001])(
    'rejects non-canonical persisted weight %p without rounding',
    (plannedWeightKg) => {
      const order = completeOrder();
      order.positions[0]!.plannedWeightKg = plannedWeightKg;

      expect(validateV2CoverageCompleteness(order)).toEqual({
        ok: false,
        reasonCode: 'order_spec_incomplete',
        missing: ['positions[0].plannedWeightKg'],
      });
    },
  );

  it('fails closed with deterministic path-only missing fields before canonical handoff', () => {
    const order = completeOrder();
    order.counterpartyId = ' ';
    Object.assign(order.positions[0]!, {
      rollCount: 0,
      actualThickness: '80/90',
      accountingThickness: '',
      widthMm: 0,
      plannedLengthM: Number.POSITIVE_INFINITY,
      birka: null,
      spoolType: undefined,
      plannedWeightKg: Number.NaN,
      recipe: {
        id: '',
        version: null,
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        ingredients: [
          {
            rawMaterialDefinitionId: 'material-a',
            name: 'ПВД',
            shareBasisPoints: 9_999,
          },
        ],
      },
    });

    expect(validateV2CoverageCompleteness(order)).toEqual({
      ok: false,
      reasonCode: 'order_spec_incomplete',
      missing: [
        'counterpartyId',
        'positions[0].rollCount',
        'positions[0].actualThickness',
        'positions[0].accountingThickness',
        'positions[0].widthMm',
        'positions[0].plannedLengthM',
        'positions[0].birka',
        'positions[0].spoolType',
        'positions[0].plannedWeightKg',
        'positions[0].recipe.id',
        'positions[0].recipe.version',
        'positions[0].recipe.ingredients',
      ],
    });
  });
});
