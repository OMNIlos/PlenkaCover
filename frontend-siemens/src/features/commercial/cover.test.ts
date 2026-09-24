import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveCommercialWarehouseCover,
  requestCommercialWarehouseCoverRecheck,
} from './api';
import { availableCoverActions, CommercialCoverPanel } from './CommercialCoverPanel';
import type {
  CommercialOrderPositionContract,
  WarehouseCoverProposalContract,
} from './contracts';

const position: CommercialOrderPositionContract = {
  id: 'position-1',
  version: 1,
  rollCount: 3,
  filmType: 'Рукав',
  actualThickness: '80 мкм',
  accountingThickness: '78 мкм',
  rawMaterialId: 'rm-1',
  spoolType: 'Шпуля 76 мм',
  birka: 'Гост',
  comment: null,
  plannedWeightKg: 41.2,
  warehouseCoverStatus: 'partial_proposed',
  coveredQty: 0,
  productionQty: 3,
  fulfilledQty: 0,
  blockingReasons: ['cover_unresolved'],
  coverProposals: [],
};

function proposal(
  overrides: Partial<WarehouseCoverProposalContract> = {},
): WarehouseCoverProposalContract {
  return {
    id: 'proposal-1',
    orderId: 'order-1',
    positionId: 'position-1',
    version: 2,
    route: 'production_only',
    status: 'partial_proposed',
    coverQty: 1,
    reserveQty: 0,
    productionQty: 2,
    sourceCapturedAt: '2026-07-14T08:00:00.000Z',
    expiresAt: null,
    stale: false,
    commercialApproved: false,
    technicalApproved: false,
    matches: [
      {
        rollId: 'roll-1',
        rollCode: 'STK-1',
        compatible: true,
        criteria: {
          filmType: { expected: 'Рукав', actual: 'Рукав', matches: true },
          actualThickness: { expected: '80 мкм', actual: '80 мкм', matches: true },
          birka: { expected: 'Гост', actual: 'Гост', matches: true },
          spoolType: { expected: 'Шпуля 76 мм', actual: '76 мм', matches: true },
          weight: { expected: 41.2, actual: 41.2, matches: true },
        },
      },
    ],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('commercial warehouse cover route matrix', () => {
  it('offers only production and recheck when no compatible rolls were proposed', () => {
    expect(availableCoverActions(position, proposal({ coverQty: 0, matches: [] }))).toEqual([
      'production_only',
      'recheck',
    ]);
  });

  it('offers the exact partial route without a quantity editor', () => {
    const partial = proposal();
    expect(availableCoverActions(position, partial)).toEqual([
      'partial_cover',
      'production_only',
      'recheck',
    ]);

    const markup = renderToStaticMarkup(
      createElement(CommercialCoverPanel, {
        position,
        proposal: partial,
        status: 'idle',
        error: null,
        onApprove: vi.fn(),
        onRecheck: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    expect(markup).toContain('1 из 3 рул.');
    expect(markup).not.toContain('type="number"');
    expect(markup).not.toContain('Количество покрытия');
  });

  it('renders the route decision before collapsible compatibility evidence', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCoverPanel, {
        position,
        proposal: proposal(),
        status: 'idle',
        error: null,
        onApprove: vi.fn(),
        onRecheck: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toContain('class="commercial-cover-summary"');
    expect(markup).toContain('Заказано</dt><dd>3 рул.');
    expect(markup).toContain('Со склада предложено</dt><dd>1 рул.');
    expect(markup).toContain('В резерве</dt><dd>0 рул.');
    expect(markup).toContain('Подтверждено</dt><dd>Ожидает решения');
    expect(markup).toContain('В производство</dt><dd>2 рул.');
    expect(markup).toContain('<summary>Совместимость и факты');
    expect(markup.indexOf('Принять резерв и произвести остаток')).toBeLessThan(
      markup.indexOf('Совместимость и факты'),
    );
  });

  it('offers full cover only when every requested roll has a compatible match', () => {
    const full = proposal({
      status: 'full_proposed',
      coverQty: 3,
      productionQty: 0,
      matches: [
        proposal().matches[0],
        { ...proposal().matches[0], rollId: 'roll-2', rollCode: 'STK-2' },
        { ...proposal().matches[0], rollId: 'roll-3', rollCode: 'STK-3' },
      ],
    });
    expect(availableCoverActions(position, full)).toEqual([
      'full_cover',
      'production_only',
      'recheck',
    ]);
  });

  it('allows only recheck for stale proposals and no action after confirmation', () => {
    expect(availableCoverActions(position, proposal({ stale: true }))).toEqual(['recheck']);
    expect(
      availableCoverActions(
        position,
        proposal({ commercialApproved: true, route: 'partial_cover' }),
      ),
    ).toEqual([]);
  });

  it('states that production-only approval does not wait for technical confirmation', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCoverPanel, {
        position,
        proposal: proposal({
          commercialApproved: true,
          route: 'production_only',
          coverQty: 0,
          productionQty: 3,
          matches: [],
        }),
        status: 'success',
        error: null,
        onApprove: vi.fn(),
        onRecheck: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toContain('Техническое подтверждение не требуется');
    expect(markup).not.toContain('Ожидается зав. производства');
  });

  it('renders conflict as recoverable stale state', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCoverPanel, {
        position,
        proposal: proposal(),
        status: 'error',
        error: 'Предложение изменилось',
        onApprove: vi.fn(),
        onRecheck: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    expect(markup).toContain('Предложение изменилось');
    expect(markup).toContain('Обновить данные');
    expect(markup).toContain('role="alert"');
  });

  it('sends proposal/version/route identifiers without fabricated quantity or roll ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => proposal({ commercialApproved: true, route: 'partial_cover' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await approveCommercialWarehouseCover('order-1', 'position-1', 'proposal-1', {
      expectedVersion: 2,
      route: 'partial_cover',
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(path).toBe(
      '/api/commercial/orders/order-1/positions/position-1/warehouse-cover/proposal-1/commercial-approval',
    );
    expect(body).toEqual({ expectedVersion: 2, route: 'partial_cover' });
    expect(body).not.toHaveProperty('coverQty');
    expect(body).not.toHaveProperty('rollIds');
  });

  it('recheck also carries the proposal version and an audited reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => proposal({ status: 'recheck_requested' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestCommercialWarehouseCoverRecheck('order-1', 'position-1', 'proposal-1', {
      expectedVersion: 2,
      reason: 'Складские факты изменились',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      expectedVersion: 2,
      reason: 'Складские факты изменились',
    });
  });
});
