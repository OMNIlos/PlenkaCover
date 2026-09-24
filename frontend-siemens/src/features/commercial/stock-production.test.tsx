import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StockProductionTemplate } from '../../api/stockProductionTemplates';
import { IntakeCreateSurface } from '../../components/shell/intakeCreateSurface';
import {
  CommercialIntakeForm,
  createEmptyCommercialIntakeDraft,
} from './CommercialIntakeForm';
import { CommercialOrderOverview } from './CommercialOrderOverview';
import { CommercialQueue } from './CommercialQueue';
import { CommercialWorkspace } from './CommercialWorkspace';
import { buildCommercialCreateOrderCommand, createCommercialOrderFromIntake } from './api';
import type { CommercialOrderDetailContract, CommercialOrderSummaryContract } from './contracts';

const stockDraft = {
  ...createEmptyCommercialIntakeDraft(),
  stockProductionTemplateId: 'stock-template-1',
  positions: [
    {
      ...createEmptyCommercialIntakeDraft().positions[0],
      rollCount: '3',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      filmType: 'Полотно',
      widthMm: '1200',
      plannedLengthM: '300',
      plannedWeightKg: '40',
      birka: 'ГОСТ',
      spoolType: 'Тонкая',
      baseRawMaterialDefinitionId: 'material-primary',
    },
  ],
};

const stockTemplate: StockProductionTemplate = {
  id: 'stock-template-1',
  name: 'Ходовой запас',
  description: null,
  status: 'active',
  version: 2,
  positions: [],
  versions: [
    {
      id: 'stock-template-version-2',
      templateId: 'stock-template-1',
      version: 2,
      positions: [],
      createdAt: '2026-07-27T10:00:00.000Z',
    },
  ],
  usageCount: 4,
  lastUsedAt: null,
  updatedAt: '2026-07-27T10:00:00.000Z',
};

const stockSummary: CommercialOrderSummaryContract = {
  id: 'stock-order-1',
  orderNumber: 'S-17',
  title: null,
  comment: null,
  commentVersion: 1,
  version: 1,
  bucket: 'in_work',
  requestType: 'stock_reserve',
  stockBatchCode: 'STOCK-S-17',
  counterparty: null,
  positionCount: 1,
  requestedQty: 3,
  indicators: {
    production: 'needs_production',
    warehouseCover: 'needs_production',
    payment: 'not_applicable',
    shipment: 'not_applicable',
  },
  commercialCompletion: {
    state: 'incomplete',
    requestedQty: 3,
    fulfilledQty: 0,
    blockingReasons: ['production_incomplete'],
  },
  nextAction: {
    code: 'send_to_production',
    ownerRole: 'commercial',
    label: 'Передать в производство',
    allowed: true,
  },
  actionPriority: 30,
  createdAt: '2026-07-27T01:00:00.000Z',
  updatedAt: '2026-07-27T01:10:00.000Z',
};

const stockDetail: CommercialOrderDetailContract = {
  ...stockSummary,
  creatorRole: 'commercial',
  commercialStage: 'in_work',
  ownerRole: 'commercial',
  productionOrderId: null,
  financeSummary: null,
  edit: {
    parametersAllowed: false,
    parametersAmendable: false,
    parametersLockReason: null,
    promoteDraftAllowed: false,
    lockedAt: null,
  },
  positions: [],
  productionProblems: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('commercial stock production', () => {
  it('renders and executes the production handoff returned by the live workspace API', async () => {
    const fetchMock = vi.fn((inputValue: string | URL | Request, init?: RequestInit) => {
      const path = String(inputValue);
      const response = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (path.startsWith('/api/commercial/orders?')) {
        return Promise.resolve(response({ items: [stockSummary], nextCursor: null }));
      }
      if (path === '/api/commercial/orders/stock-order-1' && init?.method === 'GET') {
        return Promise.resolve(response(stockDetail));
      }
      if (
        path === '/api/commercial/orders/stock-order-1/send-to-production' &&
        init?.method === 'POST'
      ) {
        return Promise.resolve(response({ id: 'production-order-1' }, 201));
      }
      if (path === '/api/material-catalog' || path === '/api/recipe-catalog') {
        return Promise.resolve(response([]));
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <CommercialWorkspace
          activeSection="В работе"
          selectedOrderId="stock-order-1"
          onChangeSection={vi.fn()}
          onSelectOrder={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const handoff = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.children.join('') === 'Передать в производство');
    expect(handoff).toBeDefined();
    await act(async () => {
      handoff?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/orders/stock-order-1/send-to-production',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('renders an explicit stock wizard without customer or client-template controls', () => {
    const markup = renderToStaticMarkup(
      <IntakeCreateSurface
        value={stockDraft}
        requestType="stock_reserve"
        onChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
        materialCatalogStatus="ready"
        stockTemplates={[stockTemplate]}
      />,
    );

    expect(markup).toContain('Произвести на запас');
    expect(markup).toContain('На запас');
    expect(markup).toContain('Шаблон производства на запас');
    expect(markup).toContain('Без шаблона');
    expect(markup).toContain('Ходовой запас · v2');
    expect(markup).not.toContain('Контрагент');
    expect(markup).not.toContain('Сохранить набор позиций как шаблон контрагента');
    expect(markup).not.toContain('Создать шаблон');
    expect(markup).not.toContain('Редактировать шаблон');
    expect(markup).not.toContain('Клиент');
  });

  it('submits stock_reserve with immutable stock-template provenance', async () => {
    const command = buildCommercialCreateOrderCommand({
      form: stockDraft,
      requestType: 'stock_reserve',
      stockProductionTemplateVersionId: 'stock-template-version-2',
      clientRequestId: '00000000-0000-4000-8000-000000000217',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command).toMatchObject({
      clientRequestId: '00000000-0000-4000-8000-000000000217',
      requestType: 'stock_reserve',
      mode: 'submit',
      stockProductionTemplateId: 'stock-template-1',
      stockProductionTemplateVersionId: 'stock-template-version-2',
    });
    expect(command).not.toHaveProperty('counterpartyId');
    expect(command).not.toHaveProperty('templateId');
    expect(command).not.toHaveProperty('templateVersionId');

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'stock-order-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromIntake({
      form: stockDraft,
      requestType: 'stock_reserve',
      counterparties: [],
      templates: [],
      stockTemplates: [stockTemplate],
      creatorRole: 'commercial',
      mode: 'submit',
      clientRequestId: '00000000-0000-4000-8000-000000000218',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(request[1].body));
    expect(body.requestType).toBe('stock_reserve');
    expect(body.stockProductionTemplateId).toBe('stock-template-1');
    expect(body.stockProductionTemplateVersionId).toBe('stock-template-version-2');
    expect(body).not.toHaveProperty('counterpartyId');
    expect(body).not.toHaveProperty('templateId');
  });

  it('keeps manual stock entry available when the stock-template catalog fails', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/commercial/stock-production-templates') {
        throw new Error('catalog offline');
      }
      if (path === '/api/commercial/orders') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'manual-stock-order' }),
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <CommercialIntakeForm
          value={stockDraft}
          requestType="stock_reserve"
          onChange={vi.fn()}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
          materialCatalogStatus="ready"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(IntakeCreateSurface)).toBeDefined();
    const visibleText = renderer.root
      .findAllByType('strong')
      .map((node) => node.children.join(' '));
    expect(visibleText).toContain('Не удалось загрузить шаблоны производства на запас');
    expect(
      renderer.root
        .findAllByType('button')
        .some((button) => button.children.join(' ') === 'Повторить'),
    ).toBe(true);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/stock-production-templates',
    ]);

    const surface = renderer.root.findByType(IntakeCreateSurface);
    await act(async () => {
      await surface.props.onSubmit('order');
    });
    const orderRequest = fetchMock.mock.calls.find(
      ([path]) => path === '/api/commercial/orders',
    ) as unknown as [string, RequestInit] | undefined;
    expect(orderRequest).toBeDefined();
    const orderBody = JSON.parse(String(orderRequest?.[1].body));
    expect(orderBody).not.toHaveProperty('stockProductionTemplateId');
    expect(orderBody).not.toHaveProperty('stockProductionTemplateVersionId');

    const retry = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join(' ') === 'Повторить');
    await act(async () => {
      retry?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/stock-production-templates',
      '/api/commercial/orders',
      '/api/commercial/stock-production-templates',
    ]);
  });

  it('keeps the stock badge after queue and detail reload projections', () => {
    const queue = renderToStaticMarkup(
      <CommercialQueue
        items={[stockSummary]}
        selectedId={stockSummary.id}
        status="ready"
        stale={false}
        error={null}
        hasMore={false}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );
    const detail = renderToStaticMarkup(<CommercialOrderOverview detail={stockDetail} />);

    expect(queue).toContain('На запас');
    expect(queue).toContain('STOCK-S-17');
    expect(detail).toContain('На запас');
    expect(detail).toContain('STOCK-S-17');
    expect(detail).not.toContain('Оплата');
    expect(detail).not.toContain('Отгрузка');
  });
});
