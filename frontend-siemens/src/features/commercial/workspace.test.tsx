import { useEffect, useState } from 'react';
import { LiveRefreshController } from '../../api/liveRefresh';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { CommercialOrderDetail } from './CommercialOrderDetail';
import { CommercialQueue } from './CommercialQueue';
import {
  CommercialWorkspace,
  shouldReconcileCommercialExternalSelection,
  shouldSyncCommercialExternalSelection,
} from './CommercialWorkspace';
import type {
  CommercialOrderCommentContract,
  CommercialOrderDetailContract,
  CommercialOrderSummaryContract,
} from './contracts';
import {
  CommercialRequestGeneration,
  commercialWorkspaceReducer,
  initialCommercialWorkspaceState,
  isCommercialDetailNotFound,
  preserveSelection,
  settleCommercialRequest,
} from './useCommercialWorkspace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

function textarea(root: ReactTestInstance, label: string) {
  return root
    .findAllByType('textarea')
    .find((candidate) => candidate.props['aria-label'] === label);
}

function input(root: ReactTestInstance, label: string) {
  return root
    .findAllByType('input')
    .find((candidate) => candidate.props['aria-label'] === label);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary: CommercialOrderSummaryContract = {
  id: 'order-1',
  orderNumber: 'A-1',
  title: 'Срочная заявка',
  comment: null,
  commentVersion: 1,
  version: 1,
  bucket: 'incoming',
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
    production: 'not_started',
    warehouseCover: 'not_checked',
    payment: 'unpaid',
    shipment: 'not_shipped',
  },
  commercialCompletion: {
    state: 'incomplete',
    requestedQty: 2,
    fulfilledQty: 0,
    blockingReasons: ['cover_unresolved'],
  },
  nextAction: {
    code: 'request_cover',
    ownerRole: 'commercial',
    label: 'Запросить проверку склада',
    allowed: true,
  },
  actionPriority: 30,
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
};

const detail: CommercialOrderDetailContract = {
  ...summary,
  creatorRole: 'commercial',
  commercialStage: 'incoming',
  ownerRole: 'commercial',
  productionOrderId: null,
  financeSummary: null,
  edit: {
    parametersAllowed: false,
    parametersAmendable: false,
    parametersLockReason: null,
    promoteDraftAllowed: false,
    lockedAt: '2026-07-14T09:00:00.000Z',
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
      plannedWeightKg: null,
      warehouseCoverStatus: 'not_checked',
      coveredQty: 0,
      productionQty: 2,
      fulfilledQty: 0,
      blockingReasons: ['cover_unresolved'],
      coverProposals: [],
    },
  ],
  productionProblems: [],
};

describe('commercial workspace state and views', () => {
  it('confirms the primary delete action and removes the order after a 204 response', async () => {
    const cancelledDetail: CommercialOrderDetailContract = {
      ...detail,
      nextAction: { ...detail.nextAction, code: 'delete_order', label: 'Удалить заказ' },
    };
    let deleted = false;
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/commercial/orders/order-1' && init?.method === 'DELETE') {
          deleted = true;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.startsWith('/api/commercial/orders?')) {
          return Promise.resolve(
            jsonResponse({ items: deleted ? [] : [summary], nextCursor: null }),
          );
        }
        if (url === '/api/commercial/orders/order-1') {
          return Promise.resolve(jsonResponse(deleted ? {} : cancelledDetail, deleted ? 404 : 200));
        }
        return Promise.resolve(jsonResponse([]));
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    function Harness() {
      const [selectedId, setSelectedId] = useState<string | null>('order-1');
      return (
        <CommercialWorkspace
          activeSection="Входящие заявки"
          selectedOrderId={selectedId}
          onReconcileSelection={setSelectedId}
          onChangeSection={vi.fn()}
          onSelectOrder={vi.fn()}
        />
      );
    }
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    await act(async () => {
      renderer.root.findByType(CommercialOrderDetail).props.onAction(cancelledDetail.nextAction);
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('без возможности восстановления'));
    expect(deleted).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => {
      renderer.root.findByType(CommercialOrderDetail).props.onAction(cancelledDetail.nextAction);
    });
    expect(deleted).toBe(true);
    expect(renderer.root.findByType(CommercialOrderDetail).props.detail).toBeNull();
    expect(renderer.root.findByType(CommercialQueue).props.items).toEqual([]);
    act(() => renderer.unmount());
  });

  it('applies authoritative patch text at the current comment version', () => {
    const reconciled = commercialWorkspaceReducer(
      {
        ...initialCommercialWorkspaceState,
        selectedId: detail.id,
        selectionSource: 'queue',
        detail: { ...detail, comment: 'Устаревший локальный текст', commentVersion: 5 },
        status: 'ready',
        detailStatus: 'ready',
      },
      {
        type: 'comment_reconciled',
        id: detail.id,
        comment: { comment: 'Авторитетный текст PATCH', commentVersion: 5 },
      },
    );

    expect(reconciled.detail).toMatchObject({
      comment: 'Авторитетный текст PATCH',
      commentVersion: 5,
    });
  });

  it('keeps a newer detail comment when an older deferred patch resolves afterward', async () => {
    const patch = deferred<CommercialOrderCommentContract>();
    let current = commercialWorkspaceReducer(
      {
        ...initialCommercialWorkspaceState,
        items: [summary],
        selectedId: detail.id,
        selectionSource: 'queue',
        detail: { ...detail, comment: 'Комментарий v4', commentVersion: 4 },
        status: 'ready',
        detailStatus: 'ready',
      },
      { type: 'detail_requested' },
    );
    const patchSettlement = patch.promise.then((comment) => {
      current = commercialWorkspaceReducer(current, {
        type: 'comment_reconciled',
        id: detail.id,
        comment,
      });
    });

    current = commercialWorkspaceReducer(current, {
      type: 'detail_succeeded',
      id: detail.id,
      detail: { ...detail, comment: 'Комментарий v6', commentVersion: 6 },
    });
    patch.resolve({ comment: 'Комментарий v5', commentVersion: 5 });
    await patchSettlement;

    expect(current.detail).toMatchObject({
      comment: 'Комментарий v6',
      commentVersion: 6,
    });
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={current.detail}
        status={current.detailStatus}
        error={current.detailError}
        onRetry={vi.fn()}
        onCommentUpdate={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(markup).toContain('Комментарий v6');
    expect(markup).not.toContain('Комментарий v5');
  });

  it('projects a successful deferred comment patch before a failed detail refresh', async () => {
    const originalDetail: CommercialOrderDetailContract = {
      ...detail,
      comment: 'Старый комментарий',
      commentVersion: 4,
      edit: { ...detail.edit, parametersAllowed: true },
    };
    const originalSummary: CommercialOrderSummaryContract = {
      ...summary,
      comment: originalDetail.comment,
      commentVersion: originalDetail.commentVersion,
    };
    const patch = deferred<Response>();
    const refreshDetail = deferred<Response>();
    let detailRequests = 0;
    let patchRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/commercial/orders?')) {
        return Promise.resolve(jsonResponse({ items: [originalSummary], nextCursor: null }));
      }
      if (path === '/api/commercial/orders/order-1' && init?.method === 'GET') {
        detailRequests += 1;
        return detailRequests === 1
          ? Promise.resolve(jsonResponse(originalDetail))
          : refreshDetail.promise;
      }
      if (path === '/api/commercial/orders/order-1/comment' && init?.method === 'PATCH') {
        patchRequests += 1;
        return patchRequests === 1
          ? patch.promise
          : Promise.resolve(jsonResponse({ message: 'Конфликт версий' }, 409));
      }
      if (path === '/api/material-catalog' || path === '/api/recipe-catalog') {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <CommercialWorkspace
          activeSection="Входящие заявки"
          selectedOrderId="order-1"
          onChangeSection={vi.fn()}
          onSelectOrder={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Новый комментарий' },
      }),
    );
    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    await act(async () => {
      patch.resolve(jsonResponse({ comment: 'Новый комментарий', commentVersion: 5 }));
      await patch.promise;
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('Новый комментарий');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Старый комментарий');
    expect(detailRequests).toBeGreaterThan(1);

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Следующий комментарий' },
      }),
    );
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    const secondPatch = fetchMock.mock.calls.find(
      ([input, init], index) =>
        index > 0 &&
        String(input) === '/api/commercial/orders/order-1/comment' &&
        init?.method === 'PATCH' &&
        JSON.parse(String(init.body)).comment === 'Следующий комментарий',
    );
    expect(JSON.parse(String(secondPatch?.[1]?.body))).toEqual({
      expectedVersion: 5,
      comment: 'Следующий комментарий',
    });
    expect(textarea(renderer.root, 'Комментарий к заявке')?.props.value).toBe(
      'Следующий комментарий',
    );

    await act(async () => {
      refreshDetail.resolve(jsonResponse({ message: 'Обновление недоступно' }, 503));
      await refreshDetail.promise;
      await Promise.resolve();
    });
    act(() => button(renderer.root, 'Отмена')?.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain('Новый комментарий');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Старый комментарий');
  });

  it('treats only an API 404 as authoritative missing detail', () => {
    expect(isCommercialDetailNotFound(new ApiError(404, 'Не найдено'))).toBe(true);
    expect(isCommercialDetailNotFound(new ApiError(503, 'Недоступно'))).toBe(false);
    expect(isCommercialDetailNotFound(Object.assign(new Error('Сеть'), { status: 404 }))).toBe(
      false,
    );
  });

  it('refreshes and closes the editor when invoice issuance wins the save race', async () => {
    const editableDetail: CommercialOrderDetailContract = {
      ...detail,
      version: 3,
      bucket: 'in_work',
      commercialStage: 'sent_to_finance',
      edit: {
        ...detail.edit,
        parametersAllowed: false,
        parametersAmendable: true,
        parametersLockReason: null,
        lockedAt: null,
      },
      positions: [
        {
          ...detail.positions[0],
          version: 2,
          widthMm: 1600,
          plannedLengthM: 250,
          plannedWeightKg: 42.3,
        },
      ],
    };
    const lockedDetail: CommercialOrderDetailContract = {
      ...editableDetail,
      financeSummary: { invoiceStatus: 'invoiced', paymentStatus: 'unpaid' },
      edit: {
        ...editableDetail.edit,
        parametersAmendable: false,
        parametersLockReason: 'invoice_issued',
      },
    };
    const queueItem: CommercialOrderSummaryContract = {
      ...summary,
      bucket: 'in_work',
      version: editableDetail.version,
    };
    let detailRequests = 0;
    let invoiceIssued = false;
    const fetchMock = vi.fn((inputValue: string | URL | Request, init?: RequestInit) => {
      const path = String(inputValue);
      if (path.startsWith('/api/commercial/orders?')) {
        return Promise.resolve(jsonResponse({ items: [queueItem], nextCursor: null }));
      }
      if (path === '/api/commercial/orders/order-1' && init?.method === 'GET') {
        detailRequests += 1;
        return Promise.resolve(jsonResponse(invoiceIssued ? lockedDetail : editableDetail));
      }
      if (path === '/api/commercial/orders/order-1/amendments' && init?.method === 'POST') {
        invoiceIssued = true;
        return Promise.resolve(
          jsonResponse(
            {
              code: 'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE',
              message: 'Параметры заказа закрыты после выставления счёта.',
            },
            409,
          ),
        );
      }
      if (path === '/api/material-catalog' || path === '/api/recipe-catalog') {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <CommercialWorkspace
          activeSection="В работе"
          selectedOrderId="order-1"
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

    expect(button(renderer.root, 'Изменить параметры')).toBeDefined();
    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    expect(renderer.root.findAllByType('form')).toHaveLength(1);
    act(() => {
      input(renderer.root, 'Ширина, мм')?.props.onChange({
        currentTarget: { value: '1650' },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(detailRequests).toBeGreaterThan(1);
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Параметры закрыты после выставления счёта',
    );
    expect(button(renderer.root, 'Изменить параметры')).toBeUndefined();
    expect(button(renderer.root, 'Добавить позицию')).toBeUndefined();
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });

  it('ignores a deferred page success after its request generation is invalidated', async () => {
    const gate = new CommercialRequestGeneration();
    const request = deferred<string>();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const generation = gate.begin();
    const settlement = settleCommercialRequest(
      gate,
      generation,
      request.promise,
      onSuccess,
      onFailure,
    );

    gate.invalidate(generation);
    request.resolve('late page');
    await settlement;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('ignores a deferred page failure after its request generation is invalidated', async () => {
    const gate = new CommercialRequestGeneration();
    const request = deferred<string>();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const generation = gate.begin();
    const settlement = settleCommercialRequest(
      gate,
      generation,
      request.promise,
      onSuccess,
      onFailure,
    );

    gate.invalidate(generation);
    request.reject(new Error('late failure'));
    await settlement;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('preserves an existing or explicitly cleared selection and reconciles a stale id', () => {
    const items = [{ id: 'order-1' }, { id: 'order-2' }];
    expect(preserveSelection('order-2', items)).toBe('order-2');
    expect(preserveSelection(null, items)).toBeNull();
    expect(preserveSelection('missing', items)).toBe('order-1');
    expect(preserveSelection('missing', [])).toBeNull();
  });

  it('keeps an explicit null selection through a live page refresh', () => {
    const selected = commercialWorkspaceReducer(initialCommercialWorkspaceState, {
      type: 'selected',
      id: 'order-1',
    });
    const cleared = commercialWorkspaceReducer(selected, { type: 'selected', id: null });
    const refreshed = commercialWorkspaceReducer(cleared, {
      type: 'page_succeeded',
      items: [summary],
      nextCursor: null,
      append: false,
    });

    expect(refreshed.selectedId).toBeNull();
    expect(refreshed.detail).toBeNull();
  });

  it('keeps an external selection outside the current page through detail load and polling', () => {
    const externalDetail: CommercialOrderDetailContract = {
      ...detail,
      id: 'order-from-control',
      orderNumber: 'A-404',
    };
    const ready = commercialWorkspaceReducer(initialCommercialWorkspaceState, {
      type: 'page_succeeded',
      items: [summary],
      nextCursor: null,
      append: false,
    });
    const selected = commercialWorkspaceReducer(ready, {
      type: 'selected',
      id: externalDetail.id,
      source: 'external',
    });
    const firstPoll = commercialWorkspaceReducer(selected, {
      type: 'page_succeeded',
      items: [summary],
      nextCursor: null,
      append: false,
    });
    const loaded = commercialWorkspaceReducer(firstPoll, {
      type: 'detail_succeeded',
      id: externalDetail.id,
      detail: externalDetail,
    });
    const secondPoll = commercialWorkspaceReducer(loaded, {
      type: 'page_succeeded',
      items: [summary],
      nextCursor: null,
      append: false,
    });

    expect(firstPoll).toMatchObject({
      selectedId: externalDetail.id,
      selectionSource: 'external',
    });
    expect(secondPoll).toMatchObject({
      selectedId: externalDetail.id,
      selectionSource: 'external',
      detail: externalDetail,
    });
  });

  it('retains an external selection after a transient detail error', () => {
    const selected = commercialWorkspaceReducer(
      {
        ...initialCommercialWorkspaceState,
        items: [summary],
        status: 'ready',
      },
      { type: 'selected', id: 'order-from-control', source: 'external' },
    );
    const failed = commercialWorkspaceReducer(selected, {
      type: 'detail_failed',
      id: 'order-from-control',
      message: 'Сеть недоступна',
    });

    expect(failed).toMatchObject({
      selectedId: 'order-from-control',
      selectionSource: 'external',
      detailStatus: 'error',
      detailError: 'Сеть недоступна',
    });
  });

  it('falls back only after the selected external detail is confirmed missing', () => {
    const selected = commercialWorkspaceReducer(
      {
        ...initialCommercialWorkspaceState,
        items: [summary],
        status: 'ready',
      },
      { type: 'selected', id: 'order-from-control', source: 'external' },
    );
    const reconciled = commercialWorkspaceReducer(selected, {
      type: 'detail_not_found',
      id: 'order-from-control',
    });

    expect(reconciled).toMatchObject({
      selectedId: summary.id,
      selectionSource: 'queue',
      detail: null,
      detailStatus: 'idle',
      detailError: null,
    });
  });

  it('still reconciles an ordinary queue selection that disappears on refresh', () => {
    const selected = commercialWorkspaceReducer(
      {
        ...initialCommercialWorkspaceState,
        items: [summary, { ...summary, id: 'order-2' }],
        status: 'ready',
      },
      { type: 'selected', id: 'order-2' },
    );
    const refreshed = commercialWorkspaceReducer(selected, {
      type: 'page_succeeded',
      items: [summary],
      nextCursor: null,
      append: false,
    });

    expect(refreshed).toMatchObject({ selectedId: summary.id, selectionSource: 'queue' });
  });

  it('dispatches an external explicit null but does not resurrect a stale external id', () => {
    expect(
      shouldSyncCommercialExternalSelection(null, 'order-1', [{ id: 'order-1' }], false),
    ).toBe(true);
    expect(
      shouldSyncCommercialExternalSelection('missing', 'order-1', [{ id: 'order-1' }], false),
    ).toBe(false);
    expect(
      shouldSyncCommercialExternalSelection('order-2', 'order-1', [{ id: 'order-1' }], true),
    ).toBe(true);
  });

  it('does not reconcile a newly changed external target against the previous ready page', () => {
    const previousItems = [{ id: 'order-1' }];

    expect(
      shouldReconcileCommercialExternalSelection(
        'order-2',
        'order-1',
        previousItems,
        true,
      ),
    ).toBe(false);
    expect(
      shouldReconcileCommercialExternalSelection(
        'order-2',
        'order-1',
        previousItems,
        false,
      ),
    ).toBe(true);
    expect(
      shouldReconcileCommercialExternalSelection(null, 'order-1', previousItems, false),
    ).toBe(false);
    expect(
      shouldReconcileCommercialExternalSelection(
        'order-1',
        'order-1',
        previousItems,
        false,
      ),
    ).toBe(false);
    expect(
      shouldReconcileCommercialExternalSelection(
        'order-1',
        'order-2',
        previousItems,
        false,
      ),
    ).toBe(false);
  });

  it('keeps old rows visible as stale when a refresh fails', () => {
    const ready = commercialWorkspaceReducer(initialCommercialWorkspaceState, {
      type: 'page_succeeded',
      items: [summary],
      nextCursor: null,
      append: false,
    });
    const refreshing = commercialWorkspaceReducer(ready, { type: 'page_requested' });
    const failed = commercialWorkspaceReducer(refreshing, {
      type: 'page_failed',
      message: 'Сеть недоступна',
    });

    expect(failed.items).toEqual([summary]);
    expect(failed).toMatchObject({ status: 'error', stale: true, error: 'Сеть недоступна' });
  });

  it('renders an accessible selected row, retry state and pagination', () => {
    const markup = renderToStaticMarkup(
      <CommercialQueue
        items={[summary]}
        selectedId="order-1"
        status="error"
        stale
        error="Сеть недоступна"
        hasMore
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        filters={{ mode: 'Требуют действий', from: '2026-07-01', to: '2026-07-31' }}
        onFiltersChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Данные могли устареть');
    expect(markup).toContain('Повторить');
    expect(markup).toContain('Показать ещё');
    expect(markup).toContain('Требуют действий');
    expect(markup).toContain('Дата от включительно');
    expect(markup).toContain('Сбросить');
  });

  it('keeps filters mounted during initial loading and hides internal API errors', () => {
    const loadingMarkup = renderToStaticMarkup(
      <CommercialQueue
        items={[]}
        selectedId={null}
        status="loading"
        stale={false}
        error={null}
        hasMore={false}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        filters={{ mode: 'Текущие', from: '', to: '' }}
        onFiltersChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );
    const errorMarkup = renderToStaticMarkup(
      <CommercialQueue
        items={[]}
        selectedId={null}
        status="error"
        stale={false}
        error="Invalid persisted productionIndicator"
        hasMore={false}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        filters={{ mode: 'Текущие', from: '', to: '' }}
        onFiltersChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(loadingMarkup).toContain('class="commercial-live-filters"');
    expect(loadingMarkup).toContain('class="commercial-live-skeleton"');
    expect(errorMarkup).toContain('Проверьте подключение и повторите попытку.');
    expect(errorMarkup).not.toContain('Invalid persisted productionIndicator');
  });

  it('renders a rail-safe queue card with semantic progress and compact filters', () => {
    const markup = renderToStaticMarkup(
      <CommercialQueue
        items={[summary]}
        selectedId="order-1"
        status="ready"
        stale={false}
        error={null}
        hasMore={false}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        filters={{ mode: 'Текущие', from: '', to: '' }}
        onFiltersChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain('class="commercial-queue-mode"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Актуальные');
    expect(markup).toContain('Требуют действий');
    expect(markup).toContain('class="commercial-queue-period"');
    expect(markup).toContain('class="commercial-queue-count"');
    expect(markup).toContain('Загружено: 1');
    expect(markup).toContain('Ваше действие');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('Проверка склада');
    expect(markup).toContain('Готово 0/2');
    expect(markup).not.toContain('Запросить проверку склада');
  });

  it('exposes queue mode controls as an accessible group', () => {
    const markup = renderToStaticMarkup(
      <CommercialQueue
        items={[summary]}
        selectedId="order-1"
        status="ready"
        stale={false}
        error={null}
        hasMore={false}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        filters={{ mode: 'Текущие', from: '', to: '' }}
        onFiltersChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain(
      'class="commercial-queue-mode" role="group" aria-label="Режим очереди"',
    );
  });

  it('puts identity, the linear route, action and blockers in the first decision surface', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={detail}
        status="ready"
        error={null}
        onRetry={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('class="commercial-order-overview"');
    expect(markup).toContain('class="commercial-pipeline"');
    expect(markup.match(/class="commercial-pipeline-step /g)).toHaveLength(6);
    expect(markup).not.toContain('commercial-current-focus');
    expect(markup).not.toContain('Текущий этап');
    expect(markup).toMatch(/<button[^>]*>Запросить<\/button>/u);
    expect(markup).toContain('Не выбран маршрут покрытия');
    expect(markup).toContain('class="commercial-position-list"');
    expect(markup).toContain('Фактическая толщина');
    expect(markup).toContain('80');
  });

  it('places the editable order comment between overview and positions', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={{
          ...detail,
          comment: 'Позвонить перед запуском',
          commentVersion: 4,
          edit: { ...detail.edit, parametersAllowed: true },
        }}
        status="ready"
        error={null}
        onRetry={vi.fn()}
        onCommentUpdate={vi.fn().mockResolvedValue(true)}
      />,
    );
    const overviewIndex = markup.indexOf('class="commercial-order-overview"');
    const commentIndex = markup.indexOf('class="commercial-order-comment"');
    const positionsIndex = markup.indexOf('id="commercial-order-positions"');

    expect(overviewIndex).toBeGreaterThanOrEqual(0);
    expect(commentIndex).toBeGreaterThan(overviewIndex);
    expect(positionsIndex).toBeGreaterThan(commentIndex);
    expect(markup).toContain('Позвонить перед запуском');
    expect(markup).toContain('Изменить комментарий');
  });

  it('explains a blocked commercial action instead of presenting a dead primary action', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={{ ...detail, nextAction: { ...detail.nextAction, allowed: false } }}
        status="ready"
        error={null}
        onRetry={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('class="commercial-pipeline"');
    expect(markup).not.toContain('commercial-current-focus');
    expect(markup).toContain('Не выбран маршрут покрытия');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('disabled=');
  });

  it('renders a commercial-owned V2 wait code as progress instead of no-rights UI', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={{
          ...detail,
          nextAction: {
            code: 'wait_send_to_production',
            ownerRole: 'commercial',
            label: 'Ожидать передачу в производство',
            allowed: false,
          },
        }}
        status="ready"
        error={null}
        onRetry={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(markup).toContain('class="commercial-pipeline"');
    expect(markup).toContain('Передать в бухгалтерию');
    expect(markup).not.toContain('commercial-current-focus');
    expect(markup).not.toContain('Текущий этап');
    expect(markup).not.toMatch(/<button[^>]*disabled=/);
  });

  it('announces a mutation error inside the current next-action surface', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={detail}
        status="ready"
        error={null}
        onRetry={vi.fn()}
        mutationFeedback={{ status: 'error', message: 'Сервис временно недоступен' }}
      />,
    );

    expect(markup).not.toContain('commercial-current-focus');
    expect(markup).toContain('class="commercial-pipeline-feedback is-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Сервис временно недоступен');
  });

  it('keeps safe client and invoice facts secondary and human readable', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={{
          ...detail,
          financeSummary: { invoiceStatus: 'invoiced', paymentStatus: 'partial' },
        }}
        status="ready"
        error={null}
        onRetry={vi.fn()}
      />,
    );

    expect(markup).toContain('<summary>Клиент и бухгалтерия</summary>');
    expect(markup).toContain('ООО Контрагент');
    expect(markup).toContain('7700000000');
    expect(markup).toContain('Счёт выставлен');
    expect(markup).not.toContain('invoiced');
  });

  it('uses the explicit invoice edit policy instead of inferring amendment access', () => {
    const markup = renderToStaticMarkup(
      <CommercialOrderDetail
        detail={{
          ...detail,
          commercialStage: 'sent_to_finance',
          financeSummary: { invoiceStatus: 'invoiced', paymentStatus: 'unpaid' },
          edit: {
            ...detail.edit,
            parametersAllowed: false,
            parametersAmendable: false,
            parametersLockReason: 'invoice_issued',
          },
        }}
        status="ready"
        error={null}
        onRetry={vi.fn()}
        onPositionAmend={vi.fn().mockResolvedValue(true)}
        onPositionAdd={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(markup).toContain('Параметры закрыты после выставления счёта');
    expect(markup).not.toContain('Изменить параметры');
    expect(markup).not.toContain('Добавить позицию');
  });
});

it.each(['selected', 'last', 'selection_changed'] as const)(
  'does not resurrect a committed deletion from a stale list response: %s',
  async (scenario) => {
    vi.stubGlobal('window', { requestAnimationFrame: vi.fn(), cancelAnimationFrame: vi.fn() });
    const pendingPage = deferred<Response>();
    const deletion = deferred<Response>();
    const pendingSnapshot = deferred<object>();
    const refreshedPage = deferred<Response>();
    const pendingDeletedDetail = deferred<Response>();
    const other = { ...summary, id: 'order-2', orderNumber: 'A-2' };
    const initialItems = scenario === 'last' ? [summary] : [summary, other];
    const remaining = initialItems.filter((item) => item.id !== summary.id);
    let pageCalls = 0;
    let snapshotCalls = 0;
    let deleted = false;
    const controller = new LiveRefreshController<object>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/commercial/orders?')) {
          pageCalls++;
          if (pageCalls === 2) return pendingPage.promise;
          return deleted
            ? refreshedPage.promise
            : Promise.resolve(jsonResponse({ items: initialItems, nextCursor: null }));
        }
        if (url === '/api/commercial/orders/order-1' && init?.method === 'DELETE')
          return deletion.promise;
        if (url === '/api/commercial/orders/order-1')
          return deleted ? pendingDeletedDetail.promise : Promise.resolve(jsonResponse(detail));
        if (url === '/api/commercial/orders/order-2')
          return Promise.resolve(jsonResponse({ ...detail, ...other }));
        return Promise.resolve(jsonResponse([]));
      }),
    );
    function Harness() {
      const [selectedId, setSelectedId] = useState<string | null>('order-1');
      const [generation, setGeneration] = useState(0);
      useEffect(() => {
        controller.start({
          automatic: false,
          load: async () => (++snapshotCalls < 3 ? {} : pendingSnapshot.promise),
          apply: () => setGeneration((g) => g + 1),
        });
        return () => controller.stop();
      }, []);
      return (
        <CommercialWorkspace
          activeSection="Входящие заявки"
          selectedOrderId={selectedId}
          refreshGeneration={generation}
          onReconcileSelection={setSelectedId}
          onMutationSuccess={() => controller.invalidateAndRefresh()}
          onChangeSection={vi.fn()}
          onSelectOrder={setSelectedId}
        />
      );
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    expect(pageCalls).toBe(1);
    await act(async () => {
      controller.refresh();
    });
    expect(pageCalls).toBe(2);
    act(() => {
      void renderer.root.findByType(CommercialOrderDetail).props.onDelete();
    });
    if (scenario === 'selection_changed') {
      await act(async () => {
        renderer.root.findByType(CommercialQueue).props.onSelect('order-2');
      });
    }
    await act(async () => {
      deleted = true;
      deletion.resolve(new Response(null, { status: 204 }));
    });
    expect(
      renderer.root.findByType(CommercialQueue).props.items.map((i: { id: string }) => i.id),
    ).toEqual(remaining.map((item) => item.id));
    expect(renderer.root.findByType(CommercialQueue).props.selectedId).toBe(
      remaining[0]?.id ?? null,
    );
    expect(pageCalls).toBe(3);
    await act(async () => {
      pendingPage.resolve(jsonResponse({ items: initialItems, nextCursor: null }));
    });
    expect(
      renderer.root.findByType(CommercialQueue).props.items.map((item: { id: string }) => item.id),
    ).toEqual(remaining.map((item) => item.id));
    await act(async () => {
      refreshedPage.resolve(jsonResponse({ items: remaining, nextCursor: null }));
    });
    const state = {
      items: renderer.root.findByType(CommercialQueue).props.items.map((i: { id: string }) => i.id),
      selected: renderer.root.findByType(CommercialQueue).props.selectedId,
      detail: renderer.root.findByType(CommercialOrderDetail).props.detail?.id,
    };
    act(() => renderer.unmount());
    expect(state.items).toEqual(remaining.map((item) => item.id));
    expect(state.selected).toBe(remaining[0]?.id ?? null);
    expect(state.detail ?? null).toBe(remaining[0]?.id ?? null);
  },
);

it('shows the committed cancellation before a slow global snapshot refresh', async () => {
  let cancelled = false;
  const pendingSnapshot = deferred<object>();
  let snapshotCalls = 0;
  const controller = new LiveRefreshController<object>();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/cancellations')) {
        cancelled = true;
        return Promise.resolve(
          jsonResponse({ commandId: 'cancel-1', cancellationStatus: 'cancelled', orderVersion: 2 }),
        );
      }
      if (url.startsWith('/api/commercial/orders?'))
        return Promise.resolve(jsonResponse({ items: [summary], nextCursor: null }));
      if (url === '/api/commercial/orders/order-1')
        return Promise.resolve(
          jsonResponse(cancelled ? { ...detail, cancellation: { status: 'cancelled' } } : detail),
        );
      return Promise.resolve(jsonResponse([]));
    }),
  );
  function Harness() {
    const [selectedId, setSelectedId] = useState<string | null>('order-1');
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
      controller.start({
        automatic: false,
        load: async () => (++snapshotCalls === 1 ? {} : pendingSnapshot.promise),
        apply: () => setGeneration((g) => g + 1),
      });
      return () => controller.stop();
    }, []);
    return (
      <CommercialWorkspace
        activeSection="Входящие заявки"
        selectedOrderId={selectedId}
        refreshGeneration={generation}
        onReconcileSelection={setSelectedId}
        onMutationSuccess={() => controller.invalidateAndRefresh()}
        onChangeSection={vi.fn()}
        onSelectOrder={setSelectedId}
      />
    );
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    await renderer.root.findByType(CommercialOrderDetail).props.onCancel('Проверка отмены');
  });
  expect(cancelled).toBe(true);
  const state = renderer.root.findByType(CommercialOrderDetail).props.detail;
  const markup = JSON.stringify(renderer.toJSON());
  act(() => renderer.unmount());
  expect(markup).toContain('Действие выполнено.');
  expect(state.cancellation?.status).toBe('cancelled');
});

it('opens the editable parameters from the Исправить primary action', async () => {
  const focus = vi.fn();
  const getElementById = vi.fn(() => ({ focus }));
  vi.stubGlobal('window', {
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal('document', { getElementById });
  const corrected = {
    ...detail,
    edit: { ...detail.edit, parametersAllowed: true },
    nextAction: {
      code: 'correct_order_spec',
      ownerRole: 'commercial',
      allowed: true,
      label: 'Исправить параметры',
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        jsonResponse(
          url.startsWith('/api/commercial/orders?')
            ? { items: [summary], nextCursor: null }
            : url === '/api/commercial/orders/order-1'
              ? corrected
              : [],
        ),
      ),
    ),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <CommercialWorkspace
        activeSection="Входящие заявки"
        selectedOrderId="order-1"
        onChangeSection={vi.fn()}
        onSelectOrder={vi.fn()}
      />,
    );
  });
  focus.mockClear();
  getElementById.mockClear();
  act(() => {
    button(renderer.root, 'Исправить')?.props.onClick();
  });
  expect(getElementById).toHaveBeenCalledWith('commercial-order-positions');
  expect(focus).toHaveBeenCalledOnce();
  expect(renderer.root.findByProps({ id: 'commercial-order-positions' }).props.tabIndex).toBe(-1);
  act(() => renderer.unmount());
});
