import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommercialOrderDetail } from './CommercialOrderDetail';
import { CommercialQueue } from './CommercialQueue';
import type {
  CommercialCompletionContract,
  CommercialOrderDetailContract,
  CommercialOrderSummaryContract,
} from './contracts';

function summary(
  id: string,
  completion: CommercialCompletionContract,
): CommercialOrderSummaryContract {
  return {
    id,
    orderNumber: id,
    title: null,
    comment: null,
    commentVersion: 1,
    version: 1,
    bucket: 'completed',
    requestType: 'client_order',
    counterparty: {
      id: 'counterparty-1',
      displayName: 'Контрагент',
      legalName: 'ООО Контрагент',
      inn: '7700000000',
    },
    positionCount: 1,
    requestedQty: 2,
    indicators: {
      production: 'ready',
      warehouseCover: 'partial_confirmed',
      payment: 'paid',
      shipment: completion.state === 'shipped' ? 'shipped' : 'not_shipped',
    },
    commercialCompletion: completion,
    nextAction: {
      code: 'prepare_shipment',
      ownerRole: 'warehouse',
      label: 'Подготовить отгрузку',
      allowed: false,
    },
    actionPriority: 0,
    createdAt: '2026-07-14T08:00:00.000Z',
    updatedAt: '2026-07-14T10:00:00.000Z',
  };
}

function detail(item: CommercialOrderSummaryContract): CommercialOrderDetailContract {
  return {
    ...item,
    creatorRole: 'commercial',
    commercialStage: 'in_work',
    ownerRole: item.nextAction.ownerRole,
    productionOrderId: 'production-1',
    financeSummary: { invoiceStatus: 'invoiced', paymentStatus: 'paid' },
    edit: {
      parametersAllowed: false,
      parametersAmendable: false,
      parametersLockReason: 'invoice_issued',
      promoteDraftAllowed: false,
      lockedAt: null,
    },
    positions: [
      {
        id: 'position-1',
        version: 1,
        rollCount: 2,
        filmType: 'ПВД',
        actualThickness: '80',
        accountingThickness: '80',
        rawMaterialId: 'raw-1',
        spoolType: '76 мм',
        birka: 'Белая',
        comment: null,
        plannedWeightKg: 40,
        warehouseCoverStatus: 'partial_confirmed',
        coveredQty: 1,
        productionQty: 1,
        fulfilledQty: 2,
        blockingReasons: [],
        coverProposals: [],
      },
    ],
    productionProblems: [],
  };
}

describe('commercial fulfillment state', () => {
  const ready = summary('A-READY', {
    state: 'ready_for_shipment',
    requestedQty: 2,
    fulfilledQty: 2,
    blockingReasons: [],
  });
  const shipped = summary('A-SHIPPED', {
    state: 'shipped',
    requestedQty: 2,
    fulfilledQty: 2,
    blockingReasons: [],
  });

  it('renders ready for shipment separately from shipped in order detail', () => {
    const readyMarkup = renderToStaticMarkup(
      createElement(CommercialOrderDetail, {
        detail: detail(ready),
        status: 'ready',
        error: null,
        onRetry: vi.fn(),
      }),
    );
    const shippedMarkup = renderToStaticMarkup(
      createElement(CommercialOrderDetail, {
        detail: detail(shipped),
        status: 'ready',
        error: null,
        onRetry: vi.fn(),
      }),
    );

    expect(readyMarkup).toContain('<span>Готов к отгрузке</span>');
    expect(readyMarkup).not.toContain('<span>Отгружен</span>');
    expect(shippedMarkup).toContain('<span>Отгружен</span>');
  });

  it('labels both fulfillment states explicitly in the completed queue', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialQueue, {
        items: [ready, shipped],
        selectedId: null,
        status: 'ready',
        stale: false,
        error: null,
        hasMore: false,
        onSelect: vi.fn(),
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
      }),
    );

    expect(markup).toContain('Готов к отгрузке');
    expect(markup).toContain('Отгружен');
  });
});
