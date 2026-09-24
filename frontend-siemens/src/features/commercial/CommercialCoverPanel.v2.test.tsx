import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CommercialWarehouseCoverageEnvelopeView,
  CommercialWarehouseCoverageView,
  WarehouseCoverageTypeProjectionView,
} from '../../domain/warehouseCoverage';
import { fetchCommercialOrderDetail } from './api';
import { CommercialCoverPanel } from './CommercialCoverPanel';
import type {
  CommercialOrderPositionContract,
  WarehouseCoverProposalContract,
} from './contracts';

function coverage(
  overrides: Partial<CommercialWarehouseCoverageView> = {},
): CommercialWarehouseCoverageEnvelopeView {
  return {
    workflowVersion: 2,
    state: 'awaiting_finance',
    stateVersion: 3,
    generation: 2,
    availability: 'verified_full',
    reasonCodes: ['full_cover_available'],
    nextOwner: 'finance',
    availableActions: [],
    requiredRollCount: 2,
    matchedRollCount: 2,
    uncertainRollCount: 0,
    calculatedAt: '2026-07-25T08:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

const groupedCoverageRows = [
  {
    positionId: 'position-a',
    label: 'Рукав 80 мкм · 1200 мм',
    requiredRollCount: 6,
    matchedRollCount: 4,
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
      filmType: 'Рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1_200,
      plannedLengthM: 800,
      weightKg: { min: 40.5, max: 41.5, total: 164 },
      spoolType: '76 мм',
      birka: 'ГОСТ',
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
    rollCode: 'ROLL-SECRET-001',
  },
  {
    positionId: 'position-b',
    label: 'Полотно 120 мкм · 900 мм',
    requiredRollCount: 4,
    matchedRollCount: 3,
    uncertainRollCount: 0,
    requested: {
      filmType: 'Полотно',
      actualThicknessMicron: 120,
      accountingThicknessMicron: 118,
      widthMm: 900,
      plannedLengthM: 600,
      weightKg: 50,
      spoolType: '76 мм',
      birka: 'Белая',
      recipeName: null,
      ingredients: [],
    },
    matched: {
      filmType: 'Полотно',
      actualThicknessMicron: 120,
      accountingThicknessMicron: 118,
      widthMm: 900,
      plannedLengthM: 600,
      weightKg: { min: 49.5, max: 50.5, total: 150 },
      spoolType: '76 мм',
      birka: 'Белая',
      recipeName: null,
      ingredients: [],
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
    rollCode: 'ROLL-SECRET-002',
  },
] satisfies Array<WarehouseCoverageTypeProjectionView & { rollCode: string }>;

const legacyPosition: CommercialOrderPositionContract = {
  id: 'position-1',
  version: 1,
  rollCount: 1,
  filmType: 'Полотно',
  actualThickness: '80 мкм',
  accountingThickness: '80 мкм',
  rawMaterialId: 'raw-1',
  spoolType: '76 мм',
  birka: 'Белая',
  comment: null,
  plannedWeightKg: 40,
  warehouseCoverStatus: 'full_proposed',
  coveredQty: 0,
  productionQty: 1,
  fulfilledQty: 0,
  blockingReasons: ['cover_unresolved'],
  coverProposals: [],
};

const legacyProposal: WarehouseCoverProposalContract = {
  id: 'proposal-1',
  orderId: 'order-1',
  positionId: 'position-1',
  version: 1,
  route: 'full_cover',
  status: 'full_proposed',
  coverQty: 1,
  reserveQty: 0,
  productionQty: 0,
  sourceCapturedAt: '2026-07-25T08:00:00.000Z',
  expiresAt: null,
  stale: false,
  commercialApproved: false,
  technicalApproved: false,
  matches: [
    {
      rollId: 'legacy-roll-1',
      rollCode: 'LEGACY-001',
      compatible: true,
      criteria: {
        filmType: { expected: 'Полотно', actual: 'Полотно', matches: true },
        actualThickness: { expected: '80 мкм', actual: '80 мкм', matches: true },
        birka: { expected: 'Белая', actual: 'Белая', matches: true },
        spoolType: { expected: '76 мм', actual: '76 мм', matches: true },
        weight: { expected: 40, actual: 40, matches: true },
      },
    },
  ],
};

function renderV2(value: CommercialWarehouseCoverageEnvelopeView) {
  return renderToStaticMarkup(
    createElement(CommercialCoverPanel, {
      warehouseCoverageWorkflowVersion: 2,
      coverage: value,
    }),
  );
}

function textFromMarkup(markup: string) {
  return markup.replace(/<[^>]+>/gu, '');
}

afterEach(() => vi.unstubAllGlobals());

describe('commercial V2 warehouse coverage', () => {
  it('renders aggregate status without manual proposal controls or exact roll data', () => {
    const markup = renderV2(coverage());
    const text = textFromMarkup(markup);

    expect(text).toContain('Почему такой маршрут');
    expect(text).toContain('2 из 2 рулонов');
    expect(text.match(/Доступность рассчитана/gu)).toHaveLength(1);
    expect(text).not.toContain('Следующее действие');
    expect(text).not.toContain('Система');
    expect(text).not.toMatch(
      /Подтвердить|Технически согласовать|Отклонить|Закрыть полностью|Произвести всё/u,
    );
    expect(markup).not.toContain('ROLL-SECRET-001');
    expect(markup).not.toMatch(/rollId|positionId|financeRolls/u);
  });

  it('renders one compact comparison per order position instead of physical roll rows', () => {
    const markup = renderV2(
      coverage({
        requiredRollCount: 10,
        matchedRollCount: 7,
        typeCoverage: groupedCoverageRows,
      }),
    );
    const text = textFromMarkup(markup);

    expect(markup).toMatch(/<header>[\s\S]*<h4>7 из 10 рулонов<\/h4>/u);
    expect(markup.match(/data-testid="warehouse-coverage-type"/gu)).toHaveLength(2);
    expect(text).toContain('Можно покрыть 4 из 6');
    expect(text).toContain('Можно покрыть 3 из 4');
    expect(
      markup.match(/<details class="commercial-coverage-type-details"/gu),
    ).toHaveLength(2);
    expect(markup.match(/<summary>Заказ \/ Резерв<\/summary>/gu)).toHaveLength(2);
    expect(text).toContain('ПВД 15803-020 · 60%');
    expect(text).toContain('40,5–41,5 кг · всего 164 кг');
    expect(markup).not.toContain('ROLL-SECRET-001');
    expect(markup).not.toContain('ROLL-SECRET-002');
  });

  it.each([
    [
      'stale',
      {
        state: 'stale' as const,
        availability: 'verified_full' as const,
        stale: true,
      },
    ],
    [
      'unknown',
      {
        state: 'unknown' as const,
        availability: 'unknown' as const,
        stale: false,
      },
    ],
    [
      'unavailable',
      {
        state: 'production_required' as const,
        availability: 'unavailable' as const,
        stale: false,
      },
    ],
  ])('does not render grouped comparisons for %s coverage', (_label, overrides) => {
    const markup = renderV2(
      coverage({
        ...overrides,
        requiredRollCount: 10,
        matchedRollCount: 7,
        typeCoverage: groupedCoverageRows,
      }),
    );

    expect(markup).not.toContain('data-testid="warehouse-coverage-type"');
    expect(markup).not.toContain('Заказ / Резерв');
    expect(markup).not.toContain('ROLL-SECRET-001');
  });

  it('keeps a zero-match result to a short aggregate without an empty comparison table', () => {
    const markup = renderV2(
      coverage({
        state: 'production_required',
        availability: 'unavailable',
        reasonCodes: ['no_compatible_rolls'],
        nextOwner: 'system',
        requiredRollCount: 10,
        matchedRollCount: 0,
        typeCoverage: [],
      }),
    );
    const text = textFromMarkup(markup);

    expect(text).toContain('0 из 10 рулонов');
    expect(text).toContain('Требуется производство');
    expect(markup).not.toContain('data-testid="warehouse-coverage-type"');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Заказ / Резерв');
  });

  it('shows specification remediation only when the server assigns commercial', () => {
    const allowed = renderV2(
      coverage({
        state: 'unknown',
        availability: 'unknown',
        reasonCodes: ['order_spec_incomplete'],
        nextOwner: 'commercial',
        availableActions: ['correct_order_spec'],
        matchedRollCount: 0,
      }),
    );
    const denied = renderV2(
      coverage({
        state: 'unknown',
        availability: 'unknown',
        reasonCodes: ['order_spec_incomplete'],
        nextOwner: 'finance',
        availableActions: [],
        matchedRollCount: 0,
      }),
    );

    expect(allowed).toContain('Исправить спецификацию заказа');
    expect(allowed).toContain('href="#commercial-order-positions"');
    expect(denied).not.toContain('Исправить спецификацию заказа');
  });

  it('retains legacy V1 controls', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCoverPanel, {
        warehouseCoverageWorkflowVersion: 1,
        position: legacyPosition,
        proposal: legacyProposal,
        status: 'idle',
        error: null,
        onApprove: vi.fn(),
        onRecheck: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toContain('Закрыть полностью со склада');
  });

  it('is deterministic across navigation and reload renders', () => {
    const serverValue = coverage({
      state: 'recheck_requested',
      availability: 'unknown',
      reasonCodes: ['warehouse_recheck_pending'],
      nextOwner: 'warehouse',
      availableActions: [],
      matchedRollCount: 0,
      uncertainRollCount: 1,
    });

    expect(renderV2(serverValue)).toBe(renderV2(structuredClone(serverValue)));
  });

  it('normalizes the live V2 projection and drops protected roll fields', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'order / real-id',
        positions: [
          {
            id: 'position-1',
            coverProposals: [{ id: 'legacy-proposal-must-not-render' }],
          },
        ],
        warehouseCoverageWorkflowVersion: 2,
        warehouseCoverage: {
          ...coverage(),
          financeRolls: [{ rollCode: 'ROLL-SECRET-001', positionId: 'position-secret' }],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCommercialOrderDetail('order / real-id');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/orders/order%20%2F%20real-id',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.warehouseCoverage).toEqual(coverage());
    expect(result.warehouseCoverage).not.toHaveProperty('financeRolls');
    expect(result.positions[0].coverProposals).toEqual([]);
  });

  it('rejects a mismatched workflow projection instead of selecting a client fallback', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'order-1',
        positions: [],
        warehouseCoverageWorkflowVersion: 2,
        warehouseCoverage: { ...coverage(), workflowVersion: 1 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCommercialOrderDetail('order-1')).rejects.toThrow(
      /не совпадает/u,
    );
  });
});
