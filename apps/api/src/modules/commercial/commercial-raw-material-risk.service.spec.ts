import { BadRequestException } from '@nestjs/common';
import { DECORATORS } from '@nestjs/swagger';
import { capabilitiesForRole } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { CommercialRawMaterialRiskResponseDto } from './dto/commercial-raw-material-risk.dto';
import { CommercialRawMaterialRiskService } from './commercial-raw-material-risk.service';

const ACTOR: Actor = {
  userId: 'commercial-1',
  role: 'commercial',
  capabilities: capabilitiesForRole('commercial'),
};

const MATERIAL = {
  materialId: 'rm-pvd',
  label: 'ПВД первичный',
  actualQty: 50,
  unit: 'кг',
  package: 'мешок 25 кг',
  factStatus: 'warehouse_fact',
  updatedAt: new Date('2026-07-14T10:00:00.000Z'),
};

function definition(
  id: string,
  name: string,
  stock: typeof MATERIAL | null,
  normalizedName = name.toLocaleLowerCase('ru-RU'),
) {
  return { id, name, normalizedName, stock };
}

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: 'position-1',
    rawMaterialId: 'rm-pvd',
    rollCount: 2,
    plannedWeightKg: null,
    warehouseCoverStatus: 'needs_production',
    recipe: null,
    coverProposals: [],
    order: {
      id: 'order-1',
      orderNumber: 'A-1',
      productionOrder: null,
    },
    ...overrides,
  };
}

function setup(
  materials = [MATERIAL],
  positions = [position()],
  definitions = materials.map((material, index) =>
    definition(`definition-${index + 1}`, material.label, material),
  ),
  coverage = {
    read: jest.fn().mockResolvedValue({
      workflowVersion: 2,
      state: 'production_required',
      stateVersion: 1,
      generation: 3,
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'commercial',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-14T08:00:00.000Z',
      stale: false,
    }),
  },
) {
  const prisma = {
    rawMaterialStock: { findMany: jest.fn().mockResolvedValue(materials) },
    rawMaterialDefinition: { findMany: jest.fn().mockResolvedValue(definitions) },
    commercialOrderPosition: { findMany: jest.fn().mockResolvedValue(positions) },
  };
  return {
    prisma,
    coverage,
    service: new CommercialRawMaterialRiskService(
      prisma as unknown as PrismaService,
      coverage as never,
    ),
  };
}

describe('CommercialRawMaterialRiskService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('queries only operational materials instead of exposing an imported catalog as stock', async () => {
    const { prisma, service } = setup([], [], []);

    await service.list(ACTOR, { limit: 20 });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'active',
          AND: expect.arrayContaining([
            {
              OR: [
                { stock: { isNot: null } },
                {
                  basePositions: {
                    some: {
                      order: {
                        commercialStage: { in: ['incoming', 'sent_to_finance', 'in_work'] },
                        shipmentStatus: { not: 'shipped' },
                      },
                    },
                  },
                },
                {
                  ingredients: {
                    some: {
                      recipeDefinitionVersion: {
                        positions: {
                          some: {
                            order: {
                              commercialStage: {
                                in: ['incoming', 'sent_to_finance', 'in_work'],
                              },
                              shipmentStatus: { not: 'shipped' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('uses V2 full-order production provenance and ignores legacy cover proposals', async () => {
    const v2Position = position({
      warehouseCoverStatus: 'full_confirmed',
      plannedWeightKg: 40,
      coverProposals: [
        {
          id: 'legacy-proposal-that-must-not-drive-v2',
          status: 'full_confirmed',
          coverQty: 2,
          reserveQty: 2,
          productionQty: 0,
          commercialApprovedAt: new Date('2026-07-14T08:00:00.000Z'),
          technicalApprovedAt: new Date('2026-07-14T08:00:00.000Z'),
          reservedRolls: [
            {
              id: 'secret-roll-1',
              reservedForOrderId: 'order-1',
              reservedForPositionId: 'position-1',
              reservedByProposalId: 'legacy-proposal-that-must-not-drive-v2',
            },
            {
              id: 'secret-roll-2',
              reservedForOrderId: 'order-1',
              reservedForPositionId: 'position-1',
              reservedByProposalId: 'legacy-proposal-that-must-not-drive-v2',
            },
          ],
        },
      ],
      order: {
        id: 'order-1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 2,
        coverageState: {
          state: 'production_required',
          generation: 3,
          currentCalculationId: 'calculation-3',
          currentDecisionId: '00000000-0000-4000-8000-000000000003',
          currentCalculation: {
            id: 'calculation-3',
            generation: 3,
            inputFingerprint: 'a'.repeat(64),
          },
          currentDecision: {
            id: '00000000-0000-4000-8000-000000000003',
            calculationId: 'calculation-3',
            generation: 3,
            kind: 'produce_all',
            inputFingerprint: 'a'.repeat(64),
          },
        },
        productionOrder: {
          sourceCoverageCalculationId: 'calculation-3',
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000003',
          sourceCoverageInputFingerprint: 'a'.repeat(64),
          sourceCoverageGeneration: 3,
          dispatchItems: [
            {
              id: 'dispatch-1',
              orderLineId: 'position-1',
              status: 'new',
              completedAt: null,
            },
            {
              id: 'dispatch-2',
              orderLineId: 'position-1',
              status: 'new',
              completedAt: null,
            },
          ],
        },
      },
    });
    const { service } = setup(
      [MATERIAL],
      [v2Position],
      [definition('definition-1', MATERIAL.label, MATERIAL)],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: 80,
        rollsInMovement: 2,
        planningAvailability: 'available',
      }),
    );
    expect(JSON.stringify(result)).not.toContain('secret-roll');
  });

  it('fails closed when V2 production provenance is stale', async () => {
    const v2Position = position({
      plannedWeightKg: 40,
      order: {
        id: 'order-1',
        orderNumber: 'A-1',
        warehouseCoverageWorkflowVersion: 2,
        coverageState: {
          state: 'production_required',
          generation: 4,
          currentCalculationId: 'calculation-4',
          currentDecisionId: '00000000-0000-4000-8000-000000000004',
          currentCalculation: {
            id: 'calculation-4',
            generation: 4,
            inputFingerprint: 'b'.repeat(64),
          },
          currentDecision: {
            id: '00000000-0000-4000-8000-000000000004',
            calculationId: 'calculation-4',
            generation: 4,
            kind: 'produce_all',
            inputFingerprint: 'b'.repeat(64),
          },
        },
        productionOrder: {
          sourceCoverageCalculationId: 'calculation-3',
          sourceCoverageDecisionId: '00000000-0000-4000-8000-000000000003',
          sourceCoverageInputFingerprint: 'a'.repeat(64),
          sourceCoverageGeneration: 3,
          dispatchItems: [],
        },
      },
    });
    const { service } = setup(
      [MATERIAL],
      [v2Position],
      [definition('definition-1', MATERIAL.label, MATERIAL)],
      {
        read: jest.fn().mockResolvedValue({
          workflowVersion: 2,
          state: 'production_required',
          stateVersion: 2,
          generation: 4,
          availability: 'unavailable',
          reasonCodes: ['no_compatible_rolls'],
          nextOwner: 'commercial',
          availableActions: [],
          requiredRollCount: 2,
          matchedRollCount: 0,
          uncertainRollCount: 0,
          calculatedAt: '2026-07-14T09:00:00.000Z',
          stale: false,
        }),
      },
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'production_facts_inconsistent',
      }),
    );
  });

  it('splits remaining planned need across the immutable snapshot composition', async () => {
    const primaryStock = { ...MATERIAL, materialId: 'rm-primary', label: 'Первичное' };
    const pigmentStock = {
      ...MATERIAL,
      materialId: 'rm-blue',
      label: 'Синий краситель',
    };
    const structuredPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-version-1',
      recipeDefinitionVersion: {
        id: 'recipe-version-1',
        version: 1,
        recipeDefinition: { id: 'recipe-1', name: 'Синяя смесь' },
        ingredients: [
          {
            sequence: 1,
            shareBasisPoints: 8000,
            rawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
          },
          {
            sequence: 2,
            shareBasisPoints: 2000,
            rawMaterialDefinition: { id: 'm-blue', name: 'Синий краситель' },
          },
        ],
      },
      rollCount: 3,
      plannedWeightKg: 20,
      recipe: {
        parameters: [],
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'recipe-version-1',
        recipeVersionNumber: 1,
        recipeName: 'Синяя смесь',
        ingredients: [
          { rawMaterialDefinitionId: 'm-primary', name: 'Первичное', shareBasisPoints: 8000 },
          {
            rawMaterialDefinitionId: 'm-blue',
            name: 'Синий краситель',
            shareBasisPoints: 2000,
          },
        ],
      },
      order: {
        id: 'order-1',
        orderNumber: 'A-1',
        productionOrder: {
          dispatchItems: [
            {
              id: 'dispatch-1',
              orderLineId: 'position-1',
              status: 'done',
              completedAt: new Date(),
            },
            {
              id: 'dispatch-2',
              orderLineId: 'position-1',
              status: 'assigned',
              completedAt: null,
            },
            {
              id: 'dispatch-3',
              orderLineId: 'position-1',
              status: 'assigned',
              completedAt: null,
            },
          ],
        },
      },
    });
    const definitions = [
      definition('m-primary', 'Первичное', primaryStock, 'первичное'),
      definition('m-blue', 'Синий краситель', pigmentStock, 'синий краситель'),
    ];
    const { service } = setup([primaryStock, pigmentStock], [structuredPosition], definitions);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawMaterialDefinitionId: 'm-primary',
          plannedNeedQty: 32,
          affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 2 }],
        }),
        expect.objectContaining({
          rawMaterialDefinitionId: 'm-blue',
          plannedNeedQty: 8,
          affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 2 }],
        }),
      ]),
    );
  });

  it('allocates rounding per position before aggregating definition demand', async () => {
    const primaryStock = { ...MATERIAL, materialId: 'rm-primary', label: 'Первичное' };
    const additiveStock = { ...MATERIAL, materialId: 'rm-additive', label: 'Добавка' };
    const ingredients = [
      {
        rawMaterialDefinitionId: 'm-primary',
        name: 'Первичное',
        shareBasisPoints: 5000,
      },
      {
        rawMaterialDefinitionId: 'm-additive',
        name: 'Добавка',
        shareBasisPoints: 5000,
      },
    ];
    const positions = ['first', 'second'].map((suffix) =>
      position({
        id: `position-${suffix}`,
        rawMaterialId: null,
        recipeDefinitionVersionId: 'recipe-version-1',
        recipeDefinitionVersion: {
          id: 'recipe-version-1',
          version: 1,
          recipeDefinition: { id: 'recipe-1', name: 'Поровну' },
          ingredients: ingredients.map((ingredient, index) => ({
            sequence: index + 1,
            shareBasisPoints: ingredient.shareBasisPoints,
            rawMaterialDefinition: {
              id: ingredient.rawMaterialDefinitionId,
              name: ingredient.name,
            },
          })),
        },
        rollCount: 1,
        plannedWeightKg: 0.001,
        recipe: {
          parameters: [],
          recipeDefinitionId: 'recipe-1',
          recipeDefinitionVersionId: 'recipe-version-1',
          recipeVersionNumber: 1,
          recipeName: 'Поровну',
          ingredients,
        },
        order: {
          id: `order-${suffix}`,
          orderNumber: `A-${suffix}`,
          productionOrder: null,
        },
      }),
    );
    const { service } = setup([primaryStock, additiveStock], positions, [
      definition('m-primary', 'Первичное', primaryStock, 'первичное'),
      definition('m-additive', 'Добавка', additiveStock, 'добавка'),
    ]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items.find((item) => item.rawMaterialDefinitionId === 'm-primary')).toEqual(
      expect.objectContaining({ plannedNeedQty: 0 }),
    );
    expect(result.items.find((item) => item.rawMaterialDefinitionId === 'm-additive')).toEqual(
      expect.objectContaining({ plannedNeedQty: 0.002 }),
    );
  });

  it('keeps a legacy snapshot with null ingredients on rawMaterialId at 100 percent', async () => {
    const legacyPosition = position({
      rawMaterialId: MATERIAL.materialId,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: null,
      rollCount: 2,
      plannedWeightKg: null,
      recipe: {
        parameters: [{ label: 'План. вес, кг', value: '25' }],
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: null,
        ingredients: null,
      },
    });
    const { service } = setup(
      [MATERIAL],
      [legacyPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-primary',
        plannedNeedQty: 50,
        planningAvailability: 'available',
      }),
    );
  });

  it('reports a catalog-only definition without pretending confirmed stock is zero', async () => {
    const catalogOnly = definition('m-catalog-only', 'Новый компонент', null, 'новый компонент');
    const structuredPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: 'm-catalog-only',
      baseRawMaterialDefinition: { id: 'm-catalog-only', name: 'Новый компонент' },
      plannedWeightKg: 20,
      recipe: {
        parameters: [],
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Новый компонент',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-catalog-only',
            name: 'Новый компонент',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });
    const { prisma, service } = setup([], [structuredPosition], [catalogOnly]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'active' }) }),
    );
    expect(result.items[0]).toMatchObject({
      rawMaterialDefinitionId: 'm-catalog-only',
      materialId: null,
      label: 'Новый компонент',
      stockAvailability: 'unavailable',
      reason: 'stock_fact_missing',
      actualQty: null,
      unit: null,
      source: null,
      plannedNeedQty: 40,
      deficitQty: null,
      risk: 'unknown',
    });
  });

  it('shows account 10.01 quantity separately without treating it as physical stock', async () => {
    const accountingOnly = {
      ...definition('m-accounting', 'Гранула ПВД', null, 'гранула пвд'),
      sourceUnit: 'кг',
      oneCNomenclatureItem: {
        unitName: 'кг',
        stockBalances: [
          {
            quantity: 125,
            capturedAt: new Date('2026-07-14T11:00:00.000Z'),
            syncedAt: new Date('2026-07-14T11:05:00.000Z'),
          },
        ],
      },
    };
    const { prisma, service } = setup([], [], [accountingOnly]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'active' }),
      }),
    );
    expect(result.items[0]).toMatchObject({
      rawMaterialDefinitionId: 'm-accounting',
      stockAvailability: 'unavailable',
      actualQty: null,
      oneCQty: 125,
      oneCUnit: 'кг',
      oneCSource: {
        capturedAt: '2026-07-14T11:00:00.000Z',
        importedAt: '2026-07-14T11:05:00.000Z',
        stale: false,
      },
      risk: 'unknown',
    });
  });

  it('fails closed on a malformed structured snapshot instead of using legacy material', async () => {
    const malformedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: 'm-primary',
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-primary',
            name: 'Первичное',
            shareBasisPoints: 9000,
          },
        ],
      },
    });
    const { service } = setup(
      [MATERIAL],
      [malformedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-primary',
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'recipe_snapshot_invalid',
        risk: 'unknown',
      }),
    );
  });

  it('fails closed when a named snapshot composition differs from its selected version', async () => {
    const corruptedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-version-1',
      recipeDefinitionVersion: {
        id: 'recipe-version-1',
        version: 1,
        recipeDefinition: { id: 'recipe-1', name: 'Первичное специальное' },
        ingredients: [
          {
            sequence: 1,
            shareBasisPoints: 10_000,
            rawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
          },
        ],
      },
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionId: 'recipe-1',
        recipeDefinitionVersionId: 'recipe-version-1',
        recipeVersionNumber: 1,
        recipeName: 'Первичное специальное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-ghost',
            name: 'Несуществующий компонент',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });
    const { service } = setup(
      [MATERIAL],
      [corruptedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-primary',
        plannedNeedQty: null,
        planningUnavailableReason: 'recipe_snapshot_invalid',
        risk: 'unknown',
      }),
    );
  });

  it('never falls back to legacy material when only structured snapshot metadata survives', async () => {
    const malformedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionVersionId: 'recipe-version-orphaned',
        recipeVersionNumber: 1,
        recipeName: 'Поврежденный snapshot',
        ingredients: null,
      },
    });
    const { prisma, service } = setup(
      [MATERIAL],
      [malformedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'recipe_snapshot_invalid',
        affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 2 }],
      }),
    );
    const { OR } = prisma.commercialOrderPosition.findMany.mock.calls[0][0].where;
    expect(OR).toEqual(
      expect.arrayContaining([
        {
          recipe: {
            is: {
              recipeDefinitionVersionId: { not: null },
            },
          },
        },
      ]),
    );
  });

  it('treats an orphaned recipe definition id as invalid structured metadata', async () => {
    const malformedPosition = position({
      rawMaterialId: MATERIAL.materialId,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionId: 'recipe-orphaned',
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: null,
        ingredients: null,
      },
    });
    const { prisma, service } = setup(
      [MATERIAL],
      [malformedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'recipe_snapshot_invalid',
        risk: 'unknown',
      }),
    );
    const { OR } = prisma.commercialOrderPosition.findMany.mock.calls[0][0].where;
    expect(OR).toEqual(
      expect.arrayContaining([
        {
          recipe: {
            is: {
              recipeDefinitionId: { not: null },
            },
          },
        },
      ]),
    );
  });

  it('fetches an orphaned composition even when every selector and legacy id is absent', async () => {
    const malformedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: null,
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-primary',
            name: 'Первичное',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });
    const { prisma, service } = setup(
      [MATERIAL],
      [malformedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'recipe_snapshot_invalid',
        risk: 'unknown',
      }),
    );
    const { OR } = prisma.commercialOrderPosition.findMany.mock.calls[0][0].where;
    expect(OR).toEqual(
      expect.arrayContaining([
        {
          recipe: {
            is: {
              ingredients: { not: expect.anything() },
            },
          },
        },
      ]),
    );
  });

  it('targets an invalid snapshot only on the page containing its identifiable material', async () => {
    const unrelatedStock = {
      ...MATERIAL,
      materialId: 'rm-unrelated',
      label: 'Несвязанное сырьё',
    };
    const otherPageStock = {
      ...MATERIAL,
      materialId: 'rm-other-page',
      label: 'Сырьё другой страницы',
    };
    const unrelatedDefinition = definition(
      'm-unrelated',
      'Несвязанное сырьё',
      unrelatedStock,
      'a-unrelated',
    );
    const otherPageDefinition = definition(
      'm-other-page',
      'Сырьё другой страницы',
      otherPageStock,
      'b-other-page',
    );
    const malformedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: null,
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-other-page',
            name: 'Сырьё другой страницы',
            shareBasisPoints: 9000,
          },
        ],
      },
    });
    const { prisma, service } = setup(
      [unrelatedStock, otherPageStock],
      [malformedPosition],
      [unrelatedDefinition, otherPageDefinition],
    );

    const firstPage = await service.list(ACTOR, { limit: 1 });
    prisma.rawMaterialDefinition.findMany.mockResolvedValueOnce([otherPageDefinition]);
    const secondPage = await service.list(ACTOR, {
      limit: 1,
      cursor: firstPage.nextCursor!,
    });

    expect(firstPage.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-unrelated',
        plannedNeedQty: 0,
        planningAvailability: 'available',
        planningUnavailableReason: null,
        affectedOrders: [],
      }),
    );
    expect(secondPage.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-other-page',
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'recipe_snapshot_invalid',
      }),
    );
  });

  it('marks a base selector invalid when its snapshot points at another definition', async () => {
    const mismatchedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: 'm-primary',
      baseRawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-other',
            name: 'Другое',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });
    const { service } = setup(
      [MATERIAL],
      [mismatchedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-primary',
        plannedNeedQty: null,
        planningUnavailableReason: 'recipe_snapshot_invalid',
      }),
    );
  });

  it('marks a base selector invalid when its copied material name is corrupted', async () => {
    const corruptedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: 'm-primary',
      baseRawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-primary',
            name: 'Подменённое имя',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });
    const { service } = setup(
      [MATERIAL],
      [corruptedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-primary',
        plannedNeedQty: null,
        planningUnavailableReason: 'recipe_snapshot_invalid',
      }),
    );
  });

  it('rejects named-recipe identity metadata on a base-material snapshot', async () => {
    const corruptedPosition = position({
      rawMaterialId: null,
      baseRawMaterialDefinitionId: 'm-primary',
      baseRawMaterialDefinition: { id: 'm-primary', name: 'Первичное' },
      recipeDefinitionVersionId: null,
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionId: 'recipe-must-not-exist',
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-primary',
            name: 'Первичное',
            shareBasisPoints: 10_000,
          },
        ],
      },
    });
    const { service } = setup(
      [MATERIAL],
      [corruptedPosition],
      [definition('m-primary', 'Первичное', MATERIAL, 'первичное')],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'm-primary',
        plannedNeedQty: null,
        planningUnavailableReason: 'recipe_snapshot_invalid',
      }),
    );
  });

  it('prioritizes invalid snapshots over every other planning reason regardless of order', async () => {
    const withOrder = (id: string, orderNumber: string, overrides: Record<string, unknown> = {}) =>
      position({
        id,
        order: {
          id: `order-${id}`,
          orderNumber,
          productionOrder: null,
        },
        ...overrides,
      });
    const missingWeight = withOrder('position-missing', 'A-1');
    const unresolvedRoute = withOrder('position-unresolved', 'A-2', {
      plannedWeightKg: 40,
      warehouseCoverStatus: 'partial_proposed',
    });
    const inconsistentFacts = withOrder('position-inconsistent', 'A-3', {
      plannedWeightKg: 40,
      warehouseCoverStatus: 'partial_confirmed',
    });
    const invalidSnapshot = withOrder('position-invalid', 'A-4', {
      rawMaterialId: null,
      baseRawMaterialDefinitionId: 'm-primary',
      plannedWeightKg: 40,
      recipe: {
        parameters: [],
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: 'm-primary',
            name: 'Первичное',
            shareBasisPoints: 9000,
          },
        ],
      },
    });
    const ordered = [missingWeight, unresolvedRoute, inconsistentFacts, invalidSnapshot];
    const { prisma, service } = setup([MATERIAL], ordered, [
      definition('m-primary', 'Первичное', MATERIAL, 'первичное'),
    ]);

    const invalidLast = await service.list(ACTOR, { limit: 20 });
    prisma.commercialOrderPosition.findMany.mockResolvedValueOnce([...ordered].reverse());
    const invalidFirst = await service.list(ACTOR, { limit: 20 });

    expect([
      invalidLast.items[0]?.planningUnavailableReason,
      invalidFirst.items[0]?.planningUnavailableReason,
    ]).toEqual(['recipe_snapshot_invalid', 'recipe_snapshot_invalid']);
  });

  it('pages definitions by normalized name and id, independent of nullable stock facts', async () => {
    const first = definition('m-2', 'Ёлка', null, 'елка');
    const second = definition('m-1', 'Яблоко', null, 'яблоко');
    const { prisma, service } = setup([], [], [first, second]);

    const page = await service.list(ACTOR, { limit: 1 });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
        take: 2,
      }),
    );
    expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      normalizedName: 'елка',
      rawMaterialDefinitionId: 'm-2',
    });
    prisma.rawMaterialDefinition.findMany.mockResolvedValueOnce([second]);

    await service.list(ACTOR, { limit: 1, cursor: page.nextCursor! });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { normalizedName: { gt: 'елка' } },
                { normalizedName: 'елка', id: { gt: 'm-2' } },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('filters the operational projection by a normalized material-name query', async () => {
    const { prisma, service } = setup([], [], []);

    await service.list(ACTOR, { limit: 20, q: '  ПЕРВИЧКА   ЛЕНТЫ  ' });

    expect(prisma.rawMaterialDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              normalizedName: { contains: 'первичка ленты' },
            },
          ]),
        }),
      }),
    );
  });

  it('documents nullable stock facts and the explicit stock availability boundary', () => {
    const field = (name: string) =>
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES,
        CommercialRawMaterialRiskResponseDto.prototype,
        name,
      );

    expect(field('rawMaterialDefinitionId')).toBeDefined();
    expect(field('stockAvailability')).toMatchObject({
      enum: ['available', 'unavailable'],
    });
    expect(field('reason')).toMatchObject({ nullable: true });
    for (const nullableField of ['materialId', 'actualQty', 'unit', 'source']) {
      expect(field(nullableField)).toMatchObject({ nullable: true });
    }
  });

  it('does not invent planned need when explicit planning weight is absent', async () => {
    const { service } = setup();

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        materialId: 'rm-pvd',
        actualQty: 50,
        reservedQty: null,
        plannedNeedQty: null,
        deficitQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'planned_weight_missing',
        reservationAvailability: 'unavailable',
        reservationUnavailableReason: 'reservation_fact_unavailable',
        risk: 'unknown',
        monetaryMetrics: { available: false },
      }),
    );
  });

  it('uses finalized production delta and explicit per-roll weight for numeric need', async () => {
    const partialPosition = position({
      rollCount: 3,
      plannedWeightKg: 40,
      warehouseCoverStatus: 'partial_confirmed',
      coverProposals: [
        {
          id: 'proposal-1',
          status: 'partial_confirmed',
          coverQty: 1,
          reserveQty: 1,
          productionQty: 2,
          commercialApprovedAt: new Date('2026-07-14T08:00:00.000Z'),
          technicalApprovedAt: new Date('2026-07-14T08:05:00.000Z'),
          reservedRolls: [
            {
              id: 'warehouse-roll-1',
              reservedForOrderId: 'order-1',
              reservedForPositionId: 'position-1',
              reservedByProposalId: 'proposal-1',
            },
          ],
        },
      ],
    });
    const { service } = setup([MATERIAL], [partialPosition]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: 80,
        deficitQty: 30,
        planningAvailability: 'available',
        planningUnavailableReason: null,
        affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 2 }],
        rollsInMovement: 0,
        risk: 'deficit',
      }),
    );
  });

  it('subtracts completed dispatch rolls without treating their material as future need', async () => {
    const planned = position({
      plannedWeightKg: 25,
      order: {
        id: 'order-1',
        orderNumber: 'A-1',
        productionOrder: {
          dispatchItems: [
            {
              id: 'dispatch-1',
              orderLineId: 'position-1',
              status: 'done',
              completedAt: new Date(),
            },
            { id: 'dispatch-2', orderLineId: 'position-1', status: 'assigned', completedAt: null },
          ],
        },
      },
    });
    const { service } = setup([MATERIAL], [planned]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: 25,
        affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 1 }],
        rollsInMovement: 1,
      }),
    );
  });

  it('marks unresolved cover facts unavailable instead of assuming all rolls need production', async () => {
    const { service } = setup(
      [MATERIAL],
      [position({ plannedWeightKg: 40, warehouseCoverStatus: 'partial_proposed' })],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: null,
        planningAvailability: 'unavailable',
        planningUnavailableReason: 'production_route_unresolved',
        rollsInMovement: null,
        affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 2 }],
      }),
    );
  });

  it('keeps an old durable warehouse fact current until the warehouse changes it', async () => {
    const oldMaterial = {
      ...MATERIAL,
      updatedAt: new Date('2026-07-12T08:00:00.000Z'),
    };
    const { service } = setup([oldMaterial], []);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        plannedNeedQty: 0,
        deficitQty: 0,
        risk: 'ok',
        source: expect.objectContaining({ kind: 'warehouse_fact', stale: false }),
      }),
    );
  });

  it('ages only imported source snapshots', async () => {
    const oldSourceMaterial = {
      ...MATERIAL,
      factStatus: 'source',
      updatedAt: new Date('2026-07-12T08:00:00.000Z'),
    };
    const { service } = setup([oldSourceMaterial], []);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        deficitQty: null,
        risk: 'attention',
        source: expect.objectContaining({ kind: '1C', stale: true }),
      }),
    );
  });

  it('joins the explicit pilot stock alias to legacy order material ids', async () => {
    const pilotMaterial = {
      ...MATERIAL,
      materialId: 'pilot-rm-pvd-10803',
      label: 'Пилот · ПВД 10803-020',
    };
    const legacyPosition = position({
      rawMaterialId: 'rm-pvd-10803',
      plannedWeightKg: 40,
    });
    const { prisma, service } = setup([pilotMaterial], [legacyPosition]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(prisma.commercialOrderPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              rawMaterialId: {
                in: expect.arrayContaining(['pilot-rm-pvd-10803', 'rm-pvd-10803']),
              },
            },
          ]),
        }),
      }),
    );
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        materialId: 'pilot-rm-pvd-10803',
        plannedNeedQty: 80,
        affectedOrders: [{ id: 'order-1', orderNumber: 'A-1', rollCount: 2 }],
      }),
    );
  });

  it('prefers exact material ids when exact and pilot stock rows coexist', async () => {
    const exactMaterial = { ...MATERIAL, materialId: 'rm-pvd-10803', label: 'ПВД 10803' };
    const pilotMaterial = {
      ...MATERIAL,
      materialId: 'pilot-rm-pvd-10803',
      label: 'Пилот · ПВД 10803',
    };
    const exactPosition = position({
      rawMaterialId: 'rm-pvd-10803',
      plannedWeightKg: 25,
    });
    const { service } = setup([exactMaterial, pilotMaterial], [exactPosition]);

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items.find((item) => item.materialId === 'rm-pvd-10803')).toEqual(
      expect.objectContaining({ plannedNeedQty: 50 }),
    );
    expect(result.items.find((item) => item.materialId === 'pilot-rm-pvd-10803')).toEqual(
      expect.objectContaining({ plannedNeedQty: 0, affectedOrders: [] }),
    );
  });

  it('keeps exact-id precedence when the matching stock row is outside the current page', async () => {
    const pilotMaterial = {
      ...MATERIAL,
      materialId: 'pilot-rm-pvd-10803',
      label: 'Пилот · ПВД 10803',
    };
    const exactPosition = position({
      rawMaterialId: 'rm-pvd-10803',
      plannedWeightKg: 25,
    });
    const { prisma, service } = setup([pilotMaterial], [exactPosition]);
    prisma.rawMaterialStock.findMany.mockResolvedValueOnce([{ materialId: 'rm-pvd-10803' }]);

    const result = await service.list(ACTOR, { limit: 1 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({ plannedNeedQty: 0, affectedOrders: [] }),
    );
    expect(prisma.commercialOrderPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ rawMaterialId: { in: ['pilot-rm-pvd-10803'] } }]),
        }),
      }),
    );
  });

  it('does not fuzzy-join unrelated material ids', async () => {
    const unrelatedPosition = position({
      rawMaterialId: 'pilot-warehouse-special',
      plannedWeightKg: 25,
    });
    const { service } = setup(
      [{ ...MATERIAL, materialId: 'warehouse-special' }],
      [unrelatedPosition],
    );

    const result = await service.list(ACTOR, { limit: 20 });

    expect(result.items[0]).toEqual(
      expect.objectContaining({ plannedNeedQty: 0, affectedOrders: [] }),
    );
  });

  it('returns a deterministic cursor page without external or raw source fields', async () => {
    const second = { ...MATERIAL, materialId: 'rm-secondary', label: 'ПВД вторичный' };
    const { prisma, service } = setup([MATERIAL, second], []);

    const firstPage = await service.list(ACTOR, { limit: 1 });
    prisma.rawMaterialDefinition.findMany.mockResolvedValueOnce([
      definition('definition-2', second.label, second),
    ]);
    const secondPage = await service.list(ACTOR, {
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(firstPage.items.map((item) => item.materialId)).toEqual(['rm-pvd']);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.items.map((item) => item.materialId)).toEqual(['rm-secondary']);
    expect(JSON.stringify([...firstPage.items, ...secondPage.items])).not.toMatch(
      /externalId|sourceVersion|rawPayload/,
    );
  });

  it('rejects a malformed cursor', async () => {
    const { service } = setup();

    await expect(service.list(ACTOR, { limit: 20, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects cursor fields that are structured values instead of non-empty strings', async () => {
    const { prisma, service } = setup();
    const cursor = Buffer.from(
      JSON.stringify({ normalizedName: [], rawMaterialDefinitionId: {} }),
    ).toString('base64url');

    await expect(service.list(ACTOR, { limit: 20, cursor })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.rawMaterialDefinition.findMany).not.toHaveBeenCalled();
  });
});
