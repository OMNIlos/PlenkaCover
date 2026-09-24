import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCommercialOrderDetail } from './api';
import type { CommercialOrderDetailContract } from './contracts';
import { projectCommercialPipeline } from './commercialPipeline';

afterEach(() => vi.unstubAllGlobals());

function order(
  overrides: Partial<CommercialOrderDetailContract> = {},
): CommercialOrderDetailContract {
  return {
    id: 'order-1',
    orderNumber: 'A-5',
    title: 'Плёнка 80 мкм',
    comment: null,
    commentVersion: 1,
    version: 1,
    bucket: 'in_work',
    requestType: 'client_order',
    counterparty: {
      id: 'counterparty-1',
      displayName: 'ПакетПром',
      legalName: 'ООО ПакетПром',
      inn: '7700000000',
    },
    positionCount: 1,
    requestedQty: 2,
    indicators: {
      production: 'not_started',
      warehouseCover: 'needs_production',
      payment: 'unpaid',
      shipment: 'not_shipped',
    },
    commercialCompletion: {
      state: 'incomplete',
      requestedQty: 2,
      fulfilledQty: 0,
      blockingReasons: ['production_incomplete'],
    },
    nextAction: {
      code: 'wait_invoice',
      ownerRole: 'finance',
      label: 'Ожидать счёт',
      allowed: false,
    },
    actionPriority: 100,
    createdAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T13:00:00.000Z',
    creatorRole: 'commercial',
    commercialStage: 'sent_to_finance',
    ownerRole: 'finance',
    productionOrderId: null,
    financeSummary: {
      invoiceStatus: 'pending',
      paymentStatus: 'unpaid',
    },
    edit: {
      parametersAllowed: false,
      parametersAmendable: true,
      parametersLockReason: null,
      promoteDraftAllowed: false,
      lockedAt: '2026-07-22T09:00:00.000Z',
    },
    warehouseCoverageWorkflowVersion: 2,
    warehouseCoverage: {
      workflowVersion: 2,
      state: 'production_required',
      stateVersion: 2,
      generation: 1,
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'system',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-22T09:00:00.000Z',
      stale: false,
    },
    positions: [],
    productionProblems: [],
    ...overrides,
  };
}

function stepTitles(value: CommercialOrderDetailContract) {
  return projectCommercialPipeline(value).steps.map(({ title }) => title);
}

describe('projectCommercialPipeline', () => {
  it('stops the route for a cancelled order without inventing an invoice or next owner', () => {
    const result = projectCommercialPipeline(
      order({
        cancellation: {
          status: 'cancelled',
          version: 2,
          cancelledAt: '2026-09-15T12:00:00Z',
          reason: 'Проверка',
          completedRollCount: 0,
          remainingCancelledRollCount: 2,
        },
      }),
    );
    expect(result.steps).toEqual([]);
    expect(result.focus).toMatchObject({ mode: 'done', title: 'Отменён' });
    expect(result.focus.actionLabel).toBeUndefined();
  });

  it('renders the exact six-stage commercial route', () => {
    expect(stepTitles(order())).toEqual([
      'Заявка',
      'Передано в бухгалтерию',
      'Выставление счёта',
      'Передать в производство',
      'Производство',
      'Склад',
    ]);
  });

  it('starts with the commercial handoff to finance', () => {
    const result = projectCommercialPipeline(
      order({
        bucket: 'incoming',
        commercialStage: 'incoming',
        financeSummary: null,
        nextAction: {
          code: 'submit_to_finance',
          ownerRole: 'commercial',
          label: 'Передать в бухгалтерию',
          allowed: true,
        },
      }),
    );

    expect(result.steps.map(({ state }) => state)).toEqual([
      'done',
      'current',
      'next',
      'next',
      'next',
      'next',
    ]);
    expect(result.steps[1]).toEqual(
      expect.objectContaining({ title: 'Передать в бухгалтерию', action: true }),
    );
  });

  it('changes finance handoff to “Передано” and advances to invoicing', () => {
    const result = projectCommercialPipeline(order());

    expect(result.steps[1]).toEqual(
      expect.objectContaining({ title: 'Передано в бухгалтерию', state: 'done' }),
    );
    expect(result.steps[2]).toEqual(
      expect.objectContaining({ title: 'Выставление счёта', state: 'current' }),
    );
  });

  it('changes invoicing to “Счёт выставлен” and advances to production handoff', () => {
    const result = projectCommercialPipeline(
      order({
        financeSummary: {
          invoiceStatus: 'invoiced',
          paymentStatus: 'unpaid',
        },
        nextAction: {
          code: 'send_to_production',
          ownerRole: 'commercial',
          label: 'Передать в производство',
          allowed: true,
        },
      }),
    );

    expect(result.steps[2]).toEqual(
      expect.objectContaining({ title: 'Счёт выставлен', state: 'done' }),
    );
    expect(result.steps[3]).toEqual(
      expect.objectContaining({ title: 'Передать в производство', state: 'current', action: true }),
    );
  });

  it('changes production handoff to “Передано” and advances to production', () => {
    const result = projectCommercialPipeline(
      order({
        productionOrderId: 'production-1',
        financeSummary: {
          invoiceStatus: 'invoiced',
          paymentStatus: 'unpaid',
        },
        nextAction: {
          code: 'wait_fulfillment',
          ownerRole: 'production_lead',
          label: 'Ожидать производство',
          allowed: false,
        },
      }),
    );

    expect(result.steps[3]).toEqual(
      expect.objectContaining({ title: 'Передано в производство', state: 'done' }),
    );
    expect(result.steps[4]).toEqual(
      expect.objectContaining({ title: 'Производство', state: 'current' }),
    );
  });

  it('changes production to “Произведено” and advances to warehouse', () => {
    const result = projectCommercialPipeline(
      order({
        productionOrderId: 'production-1',
        financeSummary: {
          invoiceStatus: 'invoiced',
          paymentStatus: 'paid',
        },
        indicators: {
          production: 'ready',
          warehouseCover: 'needs_production',
          payment: 'paid',
          shipment: 'not_shipped',
        },
        commercialCompletion: {
          state: 'ready_for_shipment',
          requestedQty: 2,
          fulfilledQty: 2,
          blockingReasons: [],
        },
        nextAction: {
          code: 'prepare_shipment',
          ownerRole: 'warehouse',
          label: 'Подготовить отгрузку',
          allowed: false,
        },
      }),
    );

    expect(result.steps[4]).toEqual(
      expect.objectContaining({ title: 'Произведено', state: 'done' }),
    );
    expect(result.steps[5]).toEqual(
      expect.objectContaining({ title: 'Склад', state: 'current' }),
    );
  });

  it('changes the final warehouse stage to “Отгружено” only after full shipment', () => {
    const partial = projectCommercialPipeline(
      order({
        productionOrderId: 'production-1',
        financeSummary: {
          invoiceStatus: 'invoiced',
          paymentStatus: 'paid',
        },
        indicators: {
          production: 'ready',
          warehouseCover: 'needs_production',
          payment: 'paid',
          shipment: 'partial_shipped',
        },
        commercialCompletion: {
          state: 'ready_for_shipment',
          requestedQty: 2,
          fulfilledQty: 2,
          blockingReasons: [],
        },
      }),
    );
    const shipped = projectCommercialPipeline(
      order({
        productionOrderId: 'production-1',
        financeSummary: {
          invoiceStatus: 'invoiced',
          paymentStatus: 'paid',
        },
        indicators: {
          production: 'ready',
          warehouseCover: 'needs_production',
          payment: 'paid',
          shipment: 'shipped',
        },
        commercialCompletion: {
          state: 'shipped',
          requestedQty: 2,
          fulfilledQty: 2,
          blockingReasons: [],
        },
      }),
    );

    expect(partial.steps[5]).toEqual(
      expect.objectContaining({ title: 'Склад', state: 'current', note: 'Частично отгружено' }),
    );
    expect(shipped.steps[5]).toEqual(
      expect.objectContaining({ title: 'Отгружено', state: 'done' }),
    );
  });
});

describe('commercial grouped warehouse coverage normalization', () => {
  it('keeps two positions grouped with every safe comparison field and drops internal rows', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'order-1',
        positions: [],
        warehouseCoverageWorkflowVersion: 2,
        warehouseCoverage: {
          workflowVersion: 2,
          state: 'awaiting_finance',
          stateVersion: 4,
          generation: 3,
          availability: 'verified_full',
          reasonCodes: ['full_cover_available'],
          nextOwner: 'finance',
          availableActions: ['use_warehouse'],
          requiredRollCount: 3,
          matchedRollCount: 3,
          uncertainRollCount: 0,
          calculatedAt: '2026-08-06T09:00:00.000Z',
          stale: false,
          typeCoverage: [
            {
              positionId: 'position-a',
              label: 'Рукав 80 мкм',
              requiredRollCount: 2,
              matchedRollCount: 2,
              uncertainRollCount: 0,
              requested: {
                filmType: 'Рукав',
                actualThicknessMicron: 80,
                accountingThicknessMicron: 78,
                widthMm: 1_200,
                plannedLengthM: 800,
                weightKg: 41,
                spoolType: '76 мм',
                birka: 'ГОСТ',
                recipeName: 'ПВД прозрачный',
                ingredients: [
                  { name: 'ПВД 15803-020', shareBasisPoints: 6_000 },
                  { name: 'ПВД 10803-020', shareBasisPoints: 4_000 },
                ],
                rawPayload: 'requested-secret',
              },
              matched: {
                filmType: 'рукав',
                actualThicknessMicron: 80,
                accountingThicknessMicron: 78,
                widthMm: 1_200,
                plannedLengthM: 800,
                weightKg: { min: 40.5, max: 41.5, total: 82 },
                spoolType: '76 мм',
                birka: 'гост',
                recipeName: 'ПВД прозрачный',
                ingredients: [
                  { name: 'ПВД 15803-020', shareBasisPoints: 6_000, factId: 'ingredient-fact' },
                  { name: 'ПВД 10803-020', shareBasisPoints: 4_000 },
                ],
                fingerprint: 'matched-secret',
              },
              comparison: {
                filmType: true,
                actualThickness: true,
                accountingThickness: true,
                width: true,
                plannedLength: true,
                weightTolerance: true,
                spoolType: true,
                birka: true,
                ingredients: true,
                rawPayload: 'comparison-secret',
              },
              rollCode: 'ROLL-A',
            },
            {
              positionId: 'position-b',
              label: 'Полотно 120 мкм',
              requiredRollCount: 1,
              matchedRollCount: 1,
              uncertainRollCount: 0,
              requested: {
                filmType: 'Полотно',
                actualThicknessMicron: 120,
                accountingThicknessMicron: null,
                widthMm: 900,
                plannedLengthM: null,
                weightKg: null,
                spoolType: null,
                birka: null,
                recipeName: null,
                ingredients: [],
              },
              matched: {
                filmType: 'Полотно',
                actualThicknessMicron: 120,
                accountingThicknessMicron: null,
                widthMm: 900,
                plannedLengthM: null,
                weightKg: null,
                spoolType: null,
                birka: null,
                recipeName: null,
                ingredients: [],
              },
              comparison: {
                filmType: true,
                actualThickness: true,
                accountingThickness: false,
                width: true,
                plannedLength: false,
                weightTolerance: false,
                spoolType: false,
                birka: false,
                ingredients: false,
              },
              factId: 'position-fact',
            },
          ],
          rolls: [{ rollCode: 'FINANCE-ROLL-MUST-STAY-HIDDEN' }],
          financeRolls: [{ rollCode: 'LEGACY-FINANCE-ROLL-MUST-STAY-HIDDEN' }],
          fingerprint: 'coverage-secret',
          rawPayload: { secret: true },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const detail = await fetchCommercialOrderDetail('order-1');

    expect(detail.warehouseCoverage?.typeCoverage).toHaveLength(2);
    expect(detail.warehouseCoverage?.typeCoverage).toEqual([
      {
        positionId: 'position-a',
        label: 'Рукав 80 мкм',
        requiredRollCount: 2,
        matchedRollCount: 2,
        uncertainRollCount: 0,
        requested: {
          filmType: 'Рукав',
          actualThicknessMicron: 80,
          accountingThicknessMicron: 78,
          widthMm: 1_200,
          plannedLengthM: 800,
          weightKg: 41,
          spoolType: '76 мм',
          birka: 'ГОСТ',
          recipeName: 'ПВД прозрачный',
          ingredients: [
            { name: 'ПВД 15803-020', shareBasisPoints: 6_000 },
            { name: 'ПВД 10803-020', shareBasisPoints: 4_000 },
          ],
        },
        matched: {
          filmType: 'рукав',
          actualThicknessMicron: 80,
          accountingThicknessMicron: 78,
          widthMm: 1_200,
          plannedLengthM: 800,
          weightKg: { min: 40.5, max: 41.5, total: 82 },
          spoolType: '76 мм',
          birka: 'гост',
          recipeName: 'ПВД прозрачный',
          ingredients: [
            { name: 'ПВД 15803-020', shareBasisPoints: 6_000 },
            { name: 'ПВД 10803-020', shareBasisPoints: 4_000 },
          ],
        },
        comparison: {
          filmType: true,
          actualThickness: true,
          accountingThickness: true,
          width: true,
          plannedLength: true,
          weightTolerance: true,
          spoolType: true,
          birka: true,
          ingredients: true,
        },
      },
      {
        positionId: 'position-b',
        label: 'Полотно 120 мкм',
        requiredRollCount: 1,
        matchedRollCount: 1,
        uncertainRollCount: 0,
        requested: {
          filmType: 'Полотно',
          actualThicknessMicron: 120,
          accountingThicknessMicron: null,
          widthMm: 900,
          plannedLengthM: null,
          weightKg: null,
          spoolType: null,
          birka: null,
          recipeName: null,
          ingredients: [],
        },
        matched: {
          filmType: 'Полотно',
          actualThicknessMicron: 120,
          accountingThicknessMicron: null,
          widthMm: 900,
          plannedLengthM: null,
          weightKg: null,
          spoolType: null,
          birka: null,
          recipeName: null,
          ingredients: [],
        },
        comparison: {
          filmType: true,
          actualThickness: true,
          accountingThickness: false,
          width: true,
          plannedLength: false,
          weightTolerance: false,
          spoolType: false,
          birka: false,
          ingredients: false,
        },
      },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(
      /rollCode|factId|fingerprint|rawPayload|financeRolls/u,
    );
  });

  it('rejects malformed grouped rows instead of coercing primitive fields', async () => {
    const validRow = {
      positionId: 'position-a',
      label: 'Рукав 80 мкм',
      requiredRollCount: 1,
      matchedRollCount: 1,
      uncertainRollCount: 0,
      requested: {
        filmType: 'Рукав',
        actualThicknessMicron: 80,
        accountingThicknessMicron: 78,
        widthMm: 1_200,
        plannedLengthM: 800,
        weightKg: 41,
        spoolType: '76 мм',
        birka: 'ГОСТ',
        recipeName: 'ПВД прозрачный',
        ingredients: [{ name: 'ПВД 15803-020', shareBasisPoints: 10_000 }],
      },
      matched: {
        filmType: 'Рукав',
        actualThicknessMicron: 80,
        accountingThicknessMicron: 78,
        widthMm: 1_200,
        plannedLengthM: 800,
        weightKg: { min: 40, max: 42, total: 41 },
        spoolType: '76 мм',
        birka: 'ГОСТ',
        recipeName: 'ПВД прозрачный',
        ingredients: [{ name: 'ПВД 15803-020', shareBasisPoints: 10_000 }],
      },
      comparison: {
        filmType: true,
        actualThickness: true,
        accountingThickness: true,
        width: true,
        plannedLength: true,
        weightTolerance: true,
        spoolType: true,
        birka: true,
        ingredients: true,
      },
    };
    const malformedRows = [
      { ...validRow, label: 80 },
      {
        ...validRow,
        matched: {
          ...validRow.matched,
          weightKg: { min: 40, max: Number.POSITIVE_INFINITY, total: 41 },
        },
      },
      {
        ...validRow,
        comparison: { ...validRow.comparison, filmType: 'true' },
      },
      {
        ...validRow,
        requested: {
          ...validRow.requested,
          ingredients: [{ name: 15803, shareBasisPoints: 10_000 }],
        },
      },
    ];

    for (const typeCoverageRow of malformedRows) {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'order-1',
          positions: [],
          warehouseCoverageWorkflowVersion: 2,
          warehouseCoverage: {
            workflowVersion: 2,
            state: 'awaiting_finance',
            stateVersion: 4,
            generation: 3,
            availability: 'verified_full',
            reasonCodes: ['full_cover_available'],
            nextOwner: 'finance',
            availableActions: ['use_warehouse'],
            requiredRollCount: 1,
            matchedRollCount: 1,
            uncertainRollCount: 0,
            calculatedAt: '2026-08-06T09:00:00.000Z',
            stale: false,
            typeCoverage: [typeCoverageRow],
          },
        }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchCommercialOrderDetail('order-1')).rejects.toThrow();
    }
  });
});
