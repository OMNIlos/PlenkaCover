import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type ApiRequestOptions } from '../../../api/client';
import { isDeliveryUncertain } from '../../../api/idempotentOperation';
import {
  createPayrollTariffOrder,
  fetchPayrollTariffOrder,
  fetchPayrollTariffOrders,
  publishPayrollTariffOrder,
  reviewPayrollTariffOrder,
  updatePayrollTariffOrder,
  type CreatePayrollTariffOrderInput,
  type PublishPayrollTariffOrderInput,
  type ReviewPayrollTariffOrderInput,
  type ServerPayrollTariffOrderFieldError,
  type ServerPayrollTariffOrderList,
  type ServerPayrollTariffOrderListItem,
  type ServerPayrollTariffOrderResult,
  type ServerPayrollTariffOrderReview,
  type ServerPayrollTariffOrderView,
  type UpdatePayrollTariffOrderInput,
} from '../../../api/payrollTariffOrders';
import {
  acceptPayrollTariffOrderReview,
  acceptSavedPayrollTariffOrder,
  createPayrollTariffOrderCopy,
  createPayrollTariffOrderEditor,
  type PayrollTariffOrderEditor,
} from './payrollTariffOrderModel';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type MutationStatus = 'idle' | 'saving' | 'reviewing' | 'publishing';
type ListLoadResult =
  | { status: 'ready'; list: ServerPayrollTariffOrderList }
  | { status: 'failed' | 'stale' };

export type PayrollTariffOrderConflict = {
  code: string;
  message: string;
};

export type PayrollTariffOrdersState = {
  isOpen: boolean;
  listStatus: LoadStatus;
  detailStatus: LoadStatus;
  mutationStatus: MutationStatus;
  list: ServerPayrollTariffOrderList | null;
  selectedOrderId: string | null;
  editor: PayrollTariffOrderEditor | null;
  error: string | null;
  fieldErrors: ServerPayrollTariffOrderFieldError[];
  conflict: PayrollTariffOrderConflict | null;
  lastMutationReplayed: boolean;
};

export type PayrollTariffOrdersApi = {
  list(options?: ApiRequestOptions): Promise<ServerPayrollTariffOrderList>;
  detail(id: string, options?: ApiRequestOptions): Promise<ServerPayrollTariffOrderView>;
  create(
    input: CreatePayrollTariffOrderInput,
    options?: ApiRequestOptions,
  ): Promise<ServerPayrollTariffOrderResult>;
  update(
    id: string,
    input: UpdatePayrollTariffOrderInput,
    options?: ApiRequestOptions,
  ): Promise<ServerPayrollTariffOrderResult>;
  review(
    id: string,
    input: ReviewPayrollTariffOrderInput,
    options?: ApiRequestOptions,
  ): Promise<ServerPayrollTariffOrderReview>;
  publish(
    id: string,
    input: PublishPayrollTariffOrderInput,
    options?: ApiRequestOptions,
  ): Promise<ServerPayrollTariffOrderResult>;
};

export const livePayrollTariffOrdersApi: PayrollTariffOrdersApi = {
  list: fetchPayrollTariffOrders,
  detail: fetchPayrollTariffOrder,
  create: createPayrollTariffOrder,
  update: updatePayrollTariffOrder,
  review: reviewPayrollTariffOrder,
  publish: publishPayrollTariffOrder,
};

export type PayrollTariffOrdersController = {
  state: PayrollTariffOrdersState;
  openCreate(): Promise<boolean>;
  openOrder(id: string): Promise<boolean>;
  close(): void;
  refreshList(): Promise<boolean>;
  selectOrder(id: string): Promise<boolean>;
  startNew(): Promise<boolean>;
  edit(update: (editor: PayrollTariffOrderEditor) => PayrollTariffOrderEditor): void;
  save(): Promise<boolean>;
  review(): Promise<boolean>;
  publish(): Promise<boolean>;
  reloadLatestRevision(): Promise<boolean>;
};

type OperationKind = 'create' | 'update' | 'publish';

type OperationIntent = {
  kind: OperationKind;
  signature: string;
  operationKey: string;
  deliveryUncertain: boolean;
};

const initialState: PayrollTariffOrdersState = {
  isOpen: false,
  listStatus: 'idle',
  detailStatus: 'idle',
  mutationStatus: 'idle',
  list: null,
  selectedOrderId: null,
  editor: null,
  error: null,
  fieldErrors: [],
  conflict: null,
  lastMutationReplayed: false,
};

function defaultOperationKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('Браузер не поддерживает безопасные ключи операций');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function listItem(order: ServerPayrollTariffOrderView): ServerPayrollTariffOrderListItem {
  const {
    matrix: _matrix,
    createdById: _createdById,
    updatedById: _updatedById,
    publishedById: _publishedById,
    ...item
  } = order;
  return item;
}

function upsertListOrder(
  list: ServerPayrollTariffOrderList | null,
  order: ServerPayrollTariffOrderView,
): ServerPayrollTariffOrderList | null {
  if (!list) return list;
  const nextItem = listItem(order);
  const index = list.items.findIndex(({ id }) => id === order.id);
  const items = [...list.items];
  if (index >= 0) items[index] = nextItem;
  else items.unshift(nextItem);
  return { ...list, items };
}

function conflictFrom(error: unknown): PayrollTariffOrderConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  return {
    code: error.code ?? 'PAYROLL_TARIFF_ORDER_CONFLICT',
    message: error.message,
  };
}

function fieldErrorsFrom(error: unknown): ServerPayrollTariffOrderFieldError[] {
  if (!(error instanceof ApiError)) return [];
  return [...(error.details.fieldErrors ?? [])];
}

export function usePayrollTariffOrders({
  api = livePayrollTariffOrdersApi,
  createOperationKey = defaultOperationKey,
}: {
  api?: PayrollTariffOrdersApi;
  createOperationKey?: () => string;
} = {}): PayrollTariffOrdersController {
  const [state, setState] = useState<PayrollTariffOrdersState>(initialState);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const mutationInFlightRef = useRef(false);
  const operationIntentRef = useRef<OperationIntent | null>(null);
  stateRef.current = state;

  useEffect(
    () => () => {
      mountedRef.current = false;
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
    },
    [],
  );

  const patchState = useCallback((patch: Partial<PayrollTariffOrdersState>) => {
    if (!mountedRef.current) return;
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const loadList = useCallback(async (): Promise<ListLoadResult> => {
    const generation = listGenerationRef.current + 1;
    listGenerationRef.current = generation;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    patchState({ listStatus: 'loading', error: null });
    try {
      const nextList = await api.list({ signal: controller.signal });
      if (!mountedRef.current || generation !== listGenerationRef.current) {
        return { status: 'stale' };
      }
      patchState({ list: nextList, listStatus: 'ready' });
      return { status: 'ready', list: nextList };
    } catch (error: unknown) {
      if (!mountedRef.current || generation !== listGenerationRef.current || isAbort(error)) {
        return { status: 'stale' };
      }
      patchState({
        listStatus: 'error',
        error: errorMessage(error, 'Не удалось загрузить приказы по тарифам'),
      });
      return { status: 'failed' };
    }
  }, [api, patchState]);

  const loadDetail = useCallback(
    async (
      id: string,
      mode: 'edit' | 'copy',
      minimumPublishEffectiveFrom?: string,
    ): Promise<boolean> => {
      const previousSelectedOrderId = stateRef.current.editor
        ? stateRef.current.selectedOrderId
        : null;
      const generation = detailGenerationRef.current + 1;
      detailGenerationRef.current = generation;
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      patchState({
        selectedOrderId: mode === 'copy' ? null : id,
        detailStatus: 'loading',
        error: null,
        fieldErrors: [],
        conflict: null,
        lastMutationReplayed: false,
      });
      try {
        const order = await api.detail(id, { signal: controller.signal });
        if (!mountedRef.current || generation !== detailGenerationRef.current) return false;
        const editor =
          mode === 'copy'
            ? createPayrollTariffOrderCopy(
                order,
                minimumPublishEffectiveFrom ??
                  stateRef.current.list?.minimumPublishEffectiveFrom ??
                  order.effectiveFrom,
              )
            : createPayrollTariffOrderEditor(order);
        operationIntentRef.current = null;
        patchState({ editor, detailStatus: 'ready' });
        return true;
      } catch (error: unknown) {
        if (!mountedRef.current || generation !== detailGenerationRef.current || isAbort(error)) {
          return false;
        }
        patchState({
          selectedOrderId: previousSelectedOrderId,
          detailStatus: 'error',
          error: errorMessage(error, 'Не удалось загрузить приказ по тарифам'),
        });
        return false;
      }
    },
    [api, patchState],
  );

  const refreshList = useCallback(async () => (await loadList()).status === 'ready', [loadList]);

  const prepareOpen = useCallback((selectedOrderId: string | null) => {
    detailGenerationRef.current += 1;
    detailAbortRef.current?.abort();
    operationIntentRef.current = null;
    patchState({
      isOpen: true,
      detailStatus: 'loading',
      editor: null,
      selectedOrderId,
      error: null,
      fieldErrors: [],
      conflict: null,
      lastMutationReplayed: false,
    });
  }, [patchState]);

  const openCreate = useCallback(async (): Promise<boolean> => {
    if (mutationInFlightRef.current) return false;
    prepareOpen(null);
    const result = await loadList();
    if (result.status !== 'ready') {
      if (result.status === 'failed') patchState({ detailStatus: 'error' });
      return false;
    }
    const { list } = result;
    if (!list.activeOrderId) {
      patchState({
        detailStatus: 'error',
        error: 'Нет действующего приказа, который можно взять за основу',
      });
      return false;
    }
    return loadDetail(list.activeOrderId, 'copy', list.minimumPublishEffectiveFrom);
  }, [loadDetail, loadList, patchState, prepareOpen]);

  const openOrder = useCallback(
    async (id: string): Promise<boolean> => {
      if (mutationInFlightRef.current) return false;
      prepareOpen(id);
      const result = await loadList();
      if (result.status !== 'ready') {
        if (result.status === 'failed') patchState({ detailStatus: 'error' });
        return false;
      }
      return loadDetail(id, 'edit');
    },
    [loadDetail, loadList, patchState, prepareOpen],
  );

  const selectOrder = useCallback(
    async (id: string): Promise<boolean> => {
      if (mutationInFlightRef.current) return false;
      return loadDetail(id, 'edit');
    },
    [loadDetail],
  );

  const close = useCallback(() => {
    if (mutationInFlightRef.current) return;
    listGenerationRef.current += 1;
    detailGenerationRef.current += 1;
    listAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    patchState({ isOpen: false });
  }, [patchState]);

  const edit = useCallback(
    (update: (editor: PayrollTariffOrderEditor) => PayrollTariffOrderEditor) => {
      const editor = stateRef.current.editor;
      if (
        !editor ||
        editor.status === 'published' ||
        mutationInFlightRef.current
      ) {
        return;
      }
      operationIntentRef.current = null;
      patchState({
        editor: update(editor),
        fieldErrors: [],
        conflict: null,
        error: null,
        lastMutationReplayed: false,
      });
    },
    [patchState],
  );

  const operationKeyFor = useCallback(
    (kind: OperationKind, signature: string): string => {
      const previous = operationIntentRef.current;
      if (
        previous?.kind === kind &&
        previous.signature === signature &&
        previous.deliveryUncertain
      ) {
        previous.deliveryUncertain = false;
        return previous.operationKey;
      }
      const operationKey = createOperationKey();
      operationIntentRef.current = {
        kind,
        signature,
        operationKey,
        deliveryUncertain: false,
      };
      return operationKey;
    },
    [createOperationKey],
  );

  const mutationFailed = useCallback(
    (error: unknown, fallback: string) => {
      if (isDeliveryUncertain(error) && operationIntentRef.current) {
        operationIntentRef.current.deliveryUncertain = true;
      } else {
        operationIntentRef.current = null;
      }
      patchState({
        mutationStatus: 'idle',
        error: errorMessage(error, fallback),
        fieldErrors: fieldErrorsFrom(error),
        conflict: conflictFrom(error),
      });
    },
    [patchState],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const editor = stateRef.current.editor;
    if (!editor || editor.status === 'published' || mutationInFlightRef.current) return false;
    const kind: OperationKind = editor.orderId === null ? 'create' : 'update';
    const signature = JSON.stringify({
      kind,
      orderId: editor.orderId,
      revision: editor.revision,
      name: editor.name,
      effectiveFrom: editor.effectiveFrom,
      matrix: editor.matrix,
    });
    const operationKey = operationKeyFor(kind, signature);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    mutationInFlightRef.current = true;
    patchState({
      mutationStatus: 'saving',
      error: null,
      fieldErrors: [],
      conflict: null,
      lastMutationReplayed: false,
    });
    try {
      const common = {
        operationKey,
        name: editor.name,
        effectiveFrom: editor.effectiveFrom,
        matrix: editor.matrix,
      };
      const result =
        editor.orderId === null
          ? await api.create(common, { signal: controller.signal })
          : await api.update(
              editor.orderId,
              { ...common, expectedRevision: editor.revision ?? 0 },
              { signal: controller.signal },
            );
      if (!mountedRef.current) return false;
      operationIntentRef.current = null;
      setState((current) => ({
        ...current,
        mutationStatus: 'idle',
        selectedOrderId: result.order.id,
        editor: acceptSavedPayrollTariffOrder(result.order),
        list: upsertListOrder(current.list, result.order),
        error: null,
        fieldErrors: [],
        conflict: null,
        lastMutationReplayed: result.replayed,
      }));
      return true;
    } catch (error: unknown) {
      if (isAbort(error)) return false;
      mutationFailed(error, 'Не удалось сохранить черновик');
      return false;
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      mutationInFlightRef.current = false;
    }
  }, [api, mutationFailed, operationKeyFor, patchState]);

  const review = useCallback(async (): Promise<boolean> => {
    const editor = stateRef.current.editor;
    if (
      !editor?.orderId ||
      editor.status !== 'draft' ||
      editor.revision === null ||
      mutationInFlightRef.current
    ) {
      return false;
    }
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    mutationInFlightRef.current = true;
    patchState({
      mutationStatus: 'reviewing',
      error: null,
      fieldErrors: [],
      conflict: null,
      lastMutationReplayed: false,
    });
    try {
      const result = await api.review(
        editor.orderId,
        { expectedRevision: editor.revision },
        { signal: controller.signal },
      );
      if (!mountedRef.current) return false;
      operationIntentRef.current = null;
      patchState({
        mutationStatus: 'idle',
        editor: acceptPayrollTariffOrderReview(editor, result),
        fieldErrors: [...result.fieldErrors],
      });
      return result.publishable;
    } catch (error: unknown) {
      if (isAbort(error)) return false;
      mutationFailed(error, 'Не удалось проверить приказ');
      return false;
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      mutationInFlightRef.current = false;
    }
  }, [api, mutationFailed, patchState]);

  const publish = useCallback(async (): Promise<boolean> => {
    const editor = stateRef.current.editor;
    const review = editor?.review;
    if (
      !editor?.orderId ||
      editor.status !== 'draft' ||
      editor.revision === null ||
      !review?.publishable ||
      review.orderId !== editor.orderId ||
      review.revision !== editor.revision ||
      mutationInFlightRef.current
    ) {
      return false;
    }
    const signature = JSON.stringify({
      kind: 'publish',
      orderId: editor.orderId,
      revision: editor.revision,
      reviewedMatrixHash: review.matrixHash,
    });
    const operationKey = operationKeyFor('publish', signature);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    mutationInFlightRef.current = true;
    patchState({
      mutationStatus: 'publishing',
      error: null,
      fieldErrors: [],
      conflict: null,
      lastMutationReplayed: false,
    });
    try {
      const result = await api.publish(
        editor.orderId,
        {
          operationKey,
          expectedRevision: editor.revision,
          reviewedMatrixHash: review.matrixHash,
        },
        { signal: controller.signal },
      );
      if (!mountedRef.current) return false;
      operationIntentRef.current = null;
      setState((current) => ({
        ...current,
        mutationStatus: 'idle',
        editor: acceptSavedPayrollTariffOrder(result.order),
        list: upsertListOrder(current.list, result.order),
        error: null,
        fieldErrors: [],
        conflict: null,
        lastMutationReplayed: result.replayed,
      }));
      return true;
    } catch (error: unknown) {
      if (isAbort(error)) return false;
      mutationFailed(error, 'Не удалось опубликовать приказ');
      return false;
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      mutationInFlightRef.current = false;
    }
  }, [api, mutationFailed, operationKeyFor, patchState]);

  const reloadLatestRevision = useCallback(async (): Promise<boolean> => {
    const editor = stateRef.current.editor;
    if (!editor?.orderId || mutationInFlightRef.current) return false;
    const local = editor;
    const generation = detailGenerationRef.current + 1;
    detailGenerationRef.current = generation;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    patchState({ detailStatus: 'loading', error: null });
    try {
      const latest = await api.detail(editor.orderId, { signal: controller.signal });
      if (!mountedRef.current || generation !== detailGenerationRef.current) return false;
      operationIntentRef.current = null;
      const latestWasPublished = latest.status === 'published';
      patchState({
        detailStatus: 'ready',
        selectedOrderId: latestWasPublished ? null : latest.id,
        editor: latestWasPublished
          ? {
              ...local,
              orderId: null,
              status: 'local',
              revision: null,
              review: null,
            }
          : {
              ...local,
              orderId: latest.id,
              status: latest.status,
              revision: latest.revision,
              review: null,
            },
        list: upsertListOrder(stateRef.current.list, latest),
        conflict: null,
        fieldErrors: [],
      });
      return true;
    } catch (error: unknown) {
      if (!mountedRef.current || generation !== detailGenerationRef.current || isAbort(error)) {
        return false;
      }
      patchState({
        detailStatus: 'error',
        error: errorMessage(error, 'Не удалось загрузить актуальную редакцию'),
      });
      return false;
    }
  }, [api, patchState]);

  return {
    state,
    openCreate,
    openOrder,
    close,
    refreshList,
    selectOrder,
    startNew: openCreate,
    edit,
    save,
    review,
    publish,
    reloadLatestRevision,
  };
}
