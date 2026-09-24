import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../api/client';
import type {
  ServerPayrollTariffMatrix,
  ServerPayrollTariffOrderList,
  ServerPayrollTariffOrderListItem,
  ServerPayrollTariffOrderView,
} from '../../../api/payrollTariffOrders';
import { editPayrollTariffOrderIdentity } from './payrollTariffOrderModel';
import {
  usePayrollTariffOrders,
  type PayrollTariffOrdersApi,
  type PayrollTariffOrdersController,
} from './usePayrollTariffOrders';

const ACTIVE_ID = 'payroll-tariff-order-8-09-25-2025-09-29';
const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_2_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_KEYS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
] as const;

function matrix(rate = 400): ServerPayrollTariffMatrix {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: rate,
          secondaryRateKopecksPerKg: 500,
        },
      ],
      urp24h: [
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: rate,
          secondaryRateKopecksPerKg: 500,
        },
      ],
      abc12h: [
        {
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
        },
      ],
      abc24h: [
        {
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
        },
      ],
    },
    specialRules: {
      thinRoll: { enabled: true, maxExclusiveGrams: 7_000, rateKopecksPerKg: 650 },
      alabuga: {
        enabled: true,
        machineFamily: 'abc_new',
        normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        rateKopecksPerKg: 400,
      },
    },
  };
}

function order(
  id: string,
  status: 'draft' | 'published',
  revision = 1,
  name = status === 'published' ? 'Приказ № 8-09/25' : 'Приказ № 9-08/26',
): ServerPayrollTariffOrderView {
  return {
    id,
    name,
    effectiveFrom: status === 'published' ? '2025-09-29' : '2026-08-15',
    currency: 'RUB',
    status,
    revision,
    createdAt: '2026-08-13T08:00:00.000Z',
    updatedAt: '2026-08-13T08:30:00.000Z',
    publishedAt: status === 'published' ? '2026-08-13T09:00:00.000Z' : null,
    matrix: matrix(),
    createdById: null,
    updatedById: null,
    publishedById: null,
  };
}

function listItem(value: ServerPayrollTariffOrderView): ServerPayrollTariffOrderListItem {
  const {
    matrix: _matrix,
    createdById: _createdById,
    updatedById: _updatedById,
    publishedById: _publishedById,
    ...item
  } = value;
  return item;
}

function list(...orders: ServerPayrollTariffOrderView[]): ServerPayrollTariffOrderList {
  return {
    items: orders.map(listItem),
    activeOrderId: ACTIVE_ID,
    latestPublishedOrderId: ACTIVE_ID,
    minimumPublishEffectiveFrom: '2026-08-14',
    timezone: 'Europe/Moscow',
    generatedAt: '2026-08-13T09:30:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createApi(overrides: Partial<PayrollTariffOrdersApi> = {}): PayrollTariffOrdersApi {
  const active = order(ACTIVE_ID, 'published');
  const draft = order(DRAFT_ID, 'draft', 2);
  return {
    list: vi.fn().mockResolvedValue(list(active, draft)),
    detail: vi.fn(async (id) => (id === ACTIVE_ID ? active : draft)),
    create: vi.fn().mockResolvedValue({ order: draft, replayed: false }),
    update: vi.fn().mockResolvedValue({ order: { ...draft, revision: 3 }, replayed: false }),
    review: vi.fn().mockResolvedValue({
      orderId: DRAFT_ID,
      revision: 3,
      matrixHash: 'a'.repeat(64),
      minimumPublishEffectiveFrom: '2026-08-14',
      publishable: true,
      fieldErrors: [],
    }),
    publish: vi.fn().mockResolvedValue({
      order: { ...draft, status: 'published', revision: 3, publishedAt: '2026-08-14T08:00:00.000Z' },
      replayed: true,
    }),
    ...overrides,
  };
}

function renderHook(api: PayrollTariffOrdersApi) {
  let controller!: PayrollTariffOrdersController;
  let keyIndex = 0;
  function Harness() {
    controller = usePayrollTariffOrders({
      api,
      createOperationKey: () => OPERATION_KEYS[keyIndex++] ?? OPERATION_KEYS.at(-1)!,
    });
    return null;
  }
  const view = create(createElement(Harness));
  return { current: () => controller, view };
}

describe('usePayrollTariffOrders', () => {
  it('opens a local copy of the active order and Cancel before Save creates no draft', async () => {
    const api = createApi();
    const state = renderHook(api);

    await act(async () => {
      await expect(state.current().openCreate()).resolves.toBe(true);
    });

    expect(api.list).toHaveBeenCalledOnce();
    expect(api.detail).toHaveBeenCalledWith(ACTIVE_ID, expect.any(Object));
    expect(state.current().state.editor).toMatchObject({
      orderId: null,
      status: 'local',
      effectiveFrom: '2026-08-14',
    });
    expect(state.current().state.selectedOrderId).toBeNull();
    expect(state.current().state.editor?.matrix).not.toBe(matrix());

    act(() => state.current().close());
    expect(state.current().state.isOpen).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
    state.view.unmount();
  });

  it('finishes the editor loading state when its prerequisite list fails', async () => {
    const api = createApi({ list: vi.fn().mockRejectedValue(new Error('network')) });
    const state = renderHook(api);

    await act(async () => {
      await expect(state.current().openCreate()).resolves.toBe(false);
    });

    expect(state.current().state).toMatchObject({
      isOpen: true,
      listStatus: 'error',
      detailStatus: 'error',
      editor: null,
      error: 'network',
    });
    state.view.unmount();
  });

  it('cancels a pending prerequisite list when the dialog closes', async () => {
    const active = order(ACTIVE_ID, 'published');
    const pendingList = deferred<ServerPayrollTariffOrderList>();
    const api = createApi({ list: vi.fn(() => pendingList.promise) });
    const state = renderHook(api);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = state.current().openCreate();
      state.current().close();
    });
    pendingList.resolve(list(active));
    await act(async () => {
      await expect(openPromise).resolves.toBe(false);
    });

    expect(state.current().state.isOpen).toBe(false);
    expect(api.detail).not.toHaveBeenCalled();
    state.view.unmount();
  });

  it('uses create then update, tracks saved revision, and invalidates review after editing', async () => {
    const api = createApi();
    const state = renderHook(api);
    await act(async () => {
      await state.current().openCreate();
    });

    act(() => {
      state.current().edit((editor) =>
        editPayrollTariffOrderIdentity(editor, 'name', 'Приказ № 10-08/26'),
      );
    });
    await act(async () => {
      await expect(state.current().save()).resolves.toBe(true);
    });
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: OPERATION_KEYS[0],
        name: 'Приказ № 10-08/26',
      }),
      expect.any(Object),
    );
    expect(state.current().state.editor).toMatchObject({
      orderId: DRAFT_ID,
      status: 'draft',
      revision: 2,
    });

    act(() => {
      state.current().edit((editor) =>
        editPayrollTariffOrderIdentity(editor, 'name', 'Приказ № 10-08/26, редакция 2'),
      );
    });
    await act(async () => {
      await state.current().save();
    });
    expect(api.update).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.objectContaining({
        operationKey: OPERATION_KEYS[1],
        expectedRevision: 2,
      }),
      expect.any(Object),
    );
    expect(state.current().state.editor?.revision).toBe(3);

    await act(async () => {
      await state.current().review();
    });
    expect(state.current().state.editor?.review?.matrixHash).toBe('a'.repeat(64));
    act(() => {
      state.current().edit((editor) =>
        editPayrollTariffOrderIdentity(editor, 'effectiveFrom', '2026-08-16'),
      );
    });
    expect(state.current().state.editor?.review).toBeNull();
    state.view.unmount();
  });

  it('publishes only the reviewed revision and accepts an idempotent replay as success', async () => {
    const draft = order(DRAFT_ID, 'draft', 3);
    const api = createApi({
      detail: vi.fn().mockResolvedValue(draft),
    });
    const state = renderHook(api);

    await act(async () => {
      await state.current().openOrder(DRAFT_ID);
    });
    await act(async () => {
      await state.current().review();
    });
    await act(async () => {
      await expect(state.current().publish()).resolves.toBe(true);
    });

    expect(api.publish).toHaveBeenCalledWith(
      DRAFT_ID,
      {
        operationKey: OPERATION_KEYS[0],
        expectedRevision: 3,
        reviewedMatrixHash: 'a'.repeat(64),
      },
      expect.any(Object),
    );
    expect(state.current().state.editor?.status).toBe('published');
    expect(state.current().state.lastMutationReplayed).toBe(true);
    state.view.unmount();
  });

  it('retains local input on stale conflict, merges the latest revision, and uses a new key', async () => {
    const initial = order(DRAFT_ID, 'draft', 2);
    const latest = order(DRAFT_ID, 'draft', 4, 'Серверная редакция');
    const saved = order(DRAFT_ID, 'draft', 5, 'Локальное название');
    const api = createApi({
      detail: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(latest),
      update: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(
            409,
            'Черновик изменён другим пользователем',
            'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
          ),
        )
        .mockResolvedValueOnce({ order: saved, replayed: false }),
    });
    const state = renderHook(api);
    await act(async () => {
      await state.current().openOrder(DRAFT_ID);
    });
    act(() => {
      state.current().edit((editor) =>
        editPayrollTariffOrderIdentity(editor, 'name', 'Локальное название'),
      );
    });

    await act(async () => {
      await expect(state.current().save()).resolves.toBe(false);
    });
    expect(state.current().state.editor?.name).toBe('Локальное название');
    expect(state.current().state.conflict?.code).toBe('PAYROLL_TARIFF_ORDER_DRAFT_STALE');

    await act(async () => {
      await expect(state.current().reloadLatestRevision()).resolves.toBe(true);
    });
    expect(state.current().state.editor).toMatchObject({
      name: 'Локальное название',
      revision: 4,
    });
    await act(async () => {
      await state.current().save();
    });
    expect(api.update).toHaveBeenLastCalledWith(
      DRAFT_ID,
      expect.objectContaining({ operationKey: OPERATION_KEYS[1], expectedRevision: 4 }),
      expect.any(Object),
    );
    state.view.unmount();
  });

  it('forks retained local input into a new draft when the conflicting revision was published', async () => {
    const initial = order(DRAFT_ID, 'draft', 2);
    const latest = order(DRAFT_ID, 'published', 4, 'Опубликованная редакция');
    const forked = order(DRAFT_2_ID, 'draft', 1, 'Локальное название');
    const api = createApi({
      detail: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(latest),
      update: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(
            409,
            'Черновик уже опубликован другим пользователем',
            'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
          ),
        ),
      create: vi.fn().mockResolvedValueOnce({ order: forked, replayed: false }),
    });
    const state = renderHook(api);
    await act(async () => {
      await state.current().openOrder(DRAFT_ID);
    });
    act(() => {
      state.current().edit((editor) =>
        editPayrollTariffOrderIdentity(editor, 'name', 'Локальное название'),
      );
    });

    await act(async () => {
      await expect(state.current().save()).resolves.toBe(false);
      await expect(state.current().reloadLatestRevision()).resolves.toBe(true);
    });

    expect(state.current().state.editor).toMatchObject({
      name: 'Локальное название',
      orderId: null,
      revision: null,
      status: 'local',
    });
    await act(async () => {
      await expect(state.current().save()).resolves.toBe(true);
    });
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: OPERATION_KEYS[1], name: 'Локальное название' }),
      expect.any(Object),
    );
    state.view.unmount();
  });

  it('reuses an operation key only for an uncertain retry of the unchanged intent', async () => {
    const uncertain = new TypeError('Failed to fetch');
    const draft = order(DRAFT_ID, 'draft', 2);
    const api = createApi({
      create: vi
        .fn()
        .mockRejectedValueOnce(uncertain)
        .mockResolvedValueOnce({ order: draft, replayed: true }),
    });
    const state = renderHook(api);
    await act(async () => {
      await state.current().openCreate();
    });

    await act(async () => {
      await state.current().save();
    });
    await act(async () => {
      await state.current().save();
    });
    expect(vi.mocked(api.create).mock.calls.map(([input]) => input.operationKey)).toEqual([
      OPERATION_KEYS[0],
      OPERATION_KEYS[0],
    ]);
    state.view.unmount();
  });

  it('retains the last successful list/detail on errors and suppresses stale detail responses', async () => {
    const active = order(ACTIVE_ID, 'published');
    const first = deferred<ServerPayrollTariffOrderView>();
    const second = deferred<ServerPayrollTariffOrderView>();
    const api = createApi({
      list: vi
        .fn()
        .mockResolvedValueOnce(list(active, order(DRAFT_ID, 'draft'), order(DRAFT_2_ID, 'draft')))
        .mockRejectedValueOnce(new Error('network')),
      detail: vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    });
    const state = renderHook(api);
    await act(async () => {
      await state.current().openCreate();
    });

    await act(async () => {
      await expect(state.current().refreshList()).resolves.toBe(false);
    });
    expect(state.current().state.list?.items).toHaveLength(3);
    expect(state.current().state.editor?.matrix).toEqual(active.matrix);

    let firstRequest!: Promise<boolean>;
    let secondRequest!: Promise<boolean>;
    act(() => {
      firstRequest = state.current().selectOrder(DRAFT_ID);
      secondRequest = state.current().selectOrder(DRAFT_2_ID);
    });
    await act(async () => {
      second.resolve(order(DRAFT_2_ID, 'draft', 4, 'Новая выбранная версия'));
      await expect(secondRequest).resolves.toBe(true);
    });
    await act(async () => {
      first.resolve(order(DRAFT_ID, 'draft', 2, 'Устаревший ответ'));
      await expect(firstRequest).resolves.toBe(false);
    });
    expect(state.current().state.editor).toMatchObject({
      orderId: DRAFT_2_ID,
      name: 'Новая выбранная версия',
    });
    state.view.unmount();
  });

  it('keeps the successful version selected when a replacement detail fails', async () => {
    const draft = order(DRAFT_ID, 'draft', 2);
    const api = createApi({
      detail: vi.fn().mockResolvedValueOnce(draft).mockRejectedValueOnce(new Error('network')),
    });
    const state = renderHook(api);
    await act(async () => {
      await state.current().openOrder(DRAFT_ID);
      await expect(state.current().selectOrder(DRAFT_2_ID)).resolves.toBe(false);
    });

    expect(state.current().state).toMatchObject({
      selectedOrderId: DRAFT_ID,
      detailStatus: 'error',
      editor: { orderId: DRAFT_ID },
    });
    state.view.unmount();
  });

  it('freezes navigation, closing and edits until an in-flight mutation settles', async () => {
    const pendingCreate = deferred<Awaited<ReturnType<PayrollTariffOrdersApi['create']>>>();
    const api = createApi({ create: vi.fn(() => pendingCreate.promise) });
    const state = renderHook(api);
    await act(async () => {
      await state.current().openCreate();
    });
    const initialName = state.current().state.editor?.name;

    let savePromise!: Promise<boolean>;
    act(() => {
      savePromise = state.current().save();
    });
    expect(state.current().state.mutationStatus).toBe('saving');
    await act(async () => {
      await expect(state.current().save()).resolves.toBe(false);
    });
    expect(api.create).toHaveBeenCalledOnce();

    act(() => {
      state.current().edit((current) =>
        editPayrollTariffOrderIdentity(current, 'name', 'Несохранённая правка'),
      );
      state.current().close();
    });
    await act(async () => {
      await expect(state.current().selectOrder(DRAFT_ID)).resolves.toBe(false);
    });

    expect(state.current().state.isOpen).toBe(true);
    expect(state.current().state.editor?.name).toBe(initialName);
    expect(api.detail).toHaveBeenCalledOnce();

    pendingCreate.resolve({ order: order(DRAFT_ID, 'draft', 2), replayed: false });
    await act(async () => {
      await expect(savePromise).resolves.toBe(true);
    });
    expect(state.current().state.mutationStatus).toBe('idle');
    state.view.unmount();
  });

  it('invalidates an in-flight detail before waiting for a new create list', async () => {
    const active = order(ACTIVE_ID, 'published');
    const draft = order(DRAFT_ID, 'draft', 2, 'Устаревшая выбранная версия');
    const staleDetail = deferred<ServerPayrollTariffOrderView>();
    const createList = deferred<ServerPayrollTariffOrderList>();
    const api = createApi({
      list: vi
        .fn()
        .mockResolvedValueOnce(list(active, draft))
        .mockReturnValueOnce(createList.promise),
      detail: vi.fn().mockReturnValueOnce(staleDetail.promise).mockResolvedValueOnce(active),
    });
    const state = renderHook(api);

    let staleOpen!: Promise<boolean>;
    await act(async () => {
      staleOpen = state.current().openOrder(DRAFT_ID);
      await Promise.resolve();
      await Promise.resolve();
    });

    let createOpen!: Promise<boolean>;
    act(() => {
      createOpen = state.current().openCreate();
    });
    await act(async () => {
      staleDetail.resolve(draft);
      await expect(staleOpen).resolves.toBe(false);
    });
    expect(state.current().state.editor).toBeNull();

    await act(async () => {
      createList.resolve(list(active, draft));
      await expect(createOpen).resolves.toBe(true);
    });
    expect(state.current().state.editor).toMatchObject({
      orderId: null,
      status: 'local',
    });
    state.view.unmount();
  });
});
