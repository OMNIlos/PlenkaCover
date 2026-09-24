import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError } from '../../api/client';
import {
  buildCommercialOrderQuery,
  fetchCommercialOrderDetail,
  fetchCommercialOrderPage,
  type CommercialOrderFilterInput,
} from './api';
import type {
  CommercialLoadStatus,
  CommercialOrderCommentContract,
  CommercialOrderDetailContract,
  CommercialOrderSummaryContract,
} from './contracts';

export type CommercialWorkspaceState = {
  items: CommercialOrderSummaryContract[];
  nextCursor: string | null;
  selectedId: string | null;
  selectionSource: 'queue' | 'external' | null;
  detail: CommercialOrderDetailContract | null;
  status: CommercialLoadStatus;
  detailStatus: CommercialLoadStatus;
  error: string | null;
  detailError: string | null;
  stale: boolean;
  pageRevision: number;
};

export type CommercialWorkspaceAction =
  | { type: 'page_requested' }
  | {
      type: 'page_succeeded';
      items: CommercialOrderSummaryContract[];
      nextCursor: string | null;
      append: boolean;
    }
  | { type: 'page_failed'; message: string }
  | { type: 'selected'; id: string | null; source?: 'queue' | 'external' }
  | { type: 'detail_requested' }
  | { type: 'detail_succeeded'; id: string; detail: CommercialOrderDetailContract }
  | { type: 'detail_failed'; id: string; message: string }
  | { type: 'detail_not_found'; id: string }
  | { type: 'comment_reconciled'; id: string; comment: CommercialOrderCommentContract }
  | { type: 'reset' };

export const initialCommercialWorkspaceState: CommercialWorkspaceState = {
  items: [],
  nextCursor: null,
  selectedId: null,
  selectionSource: null,
  detail: null,
  status: 'idle',
  detailStatus: 'idle',
  error: null,
  detailError: null,
  stale: false,
  pageRevision: 0,
};

export function preserveSelection(
  selectedId: string | null,
  items: ReadonlyArray<{ id: string }>,
): string | null {
  if (selectedId === null) return null;
  if (selectedId && items.some((item) => item.id === selectedId)) return selectedId;
  return items[0]?.id ?? null;
}

function appendUnique(
  current: CommercialOrderSummaryContract[],
  incoming: CommercialOrderSummaryContract[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

export function replaceCommercialOrders<T extends { id: string }>(
  _current: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
): T[] {
  return incoming.map((item) => ({ ...item }));
}

export function commercialWorkspaceReducer(
  state: CommercialWorkspaceState,
  action: CommercialWorkspaceAction,
): CommercialWorkspaceState {
  switch (action.type) {
    case 'page_requested':
      return {
        ...state,
        status: state.status === 'idle' ? 'loading' : 'refreshing',
        error: null,
      };
    case 'page_succeeded': {
      const items = action.append
        ? appendUnique(state.items, action.items)
        : replaceCommercialOrders(state.items, action.items);
      const selectedId =
        state.selectionSource === 'external' && state.selectedId !== null
          ? state.selectedId
          : preserveSelection(state.selectedId, items);
      const selectionSource =
        selectedId === null
          ? null
          : selectedId === state.selectedId
            ? state.selectionSource
            : 'queue';
      return {
        ...state,
        items,
        nextCursor: action.nextCursor,
        selectedId,
        selectionSource,
        detail: selectedId === state.selectedId ? state.detail : null,
        status: 'ready',
        error: null,
        stale: false,
        pageRevision: state.pageRevision + 1,
      };
    }
    case 'page_failed':
      return {
        ...state,
        status: 'error',
        error: action.message,
        stale: state.items.length > 0,
      };
    case 'selected':
      return {
        ...state,
        selectedId: action.id,
        selectionSource: action.id === null ? null : (action.source ?? 'queue'),
        detail: action.id === state.selectedId ? state.detail : null,
        detailError: null,
      };
    case 'detail_requested':
      return {
        ...state,
        detailStatus: state.detail ? 'refreshing' : 'loading',
        detailError: null,
      };
    case 'detail_succeeded': {
      if (action.id !== state.selectedId) return state;
      const detail =
        state.detail?.id === action.id && state.detail.commentVersion > action.detail.commentVersion
          ? {
              ...action.detail,
              comment: state.detail.comment,
              commentVersion: state.detail.commentVersion,
            }
          : action.detail;
      return { ...state, detail, detailStatus: 'ready', detailError: null };
    }
    case 'detail_failed':
      if (action.id !== state.selectedId) return state;
      return { ...state, detailStatus: 'error', detailError: action.message };
    case 'detail_not_found': {
      const items = state.items.filter((item) => item.id !== action.id);
      if (action.id !== state.selectedId) return { ...state, items };
      const selectedId = items[0]?.id ?? null;
      return {
        ...state,
        items,
        selectedId,
        selectionSource: selectedId === null ? null : 'queue',
        detail: null,
        detailStatus: 'idle',
        detailError: null,
      };
    }
    case 'comment_reconciled':
      if (action.id !== state.selectedId || state.detail?.id !== action.id) return state;
      if (action.comment.commentVersion < state.detail.commentVersion) return state;
      return {
        ...state,
        detail: {
          ...state.detail,
          comment: action.comment.comment,
          commentVersion: action.comment.commentVersion,
        },
      };
    case 'reset':
      return initialCommercialWorkspaceState;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось загрузить данные.';
}

export function isCommercialDetailNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export class CommercialRequestGeneration {
  private value = 0;

  begin() {
    this.value += 1;
    return this.value;
  }

  capture() {
    return this.value;
  }

  invalidate(generation?: number) {
    if (generation === undefined || generation === this.value) this.value += 1;
  }

  isCurrent(generation: number) {
    return generation === this.value;
  }
}

export async function settleCommercialRequest<T>(
  requests: CommercialRequestGeneration,
  generation: number,
  request: Promise<T>,
  onSuccess: (value: T) => void,
  onFailure: (error: unknown) => void,
) {
  try {
    const value = await request;
    if (requests.isCurrent(generation)) onSuccess(value);
  } catch (error) {
    if (requests.isCurrent(generation)) onFailure(error);
  }
}

export function useCommercialWorkspace(
  input: CommercialOrderFilterInput & { enabled?: boolean; refreshGeneration?: number },
) {
  const [state, dispatch] = useReducer(commercialWorkspaceReducer, initialCommercialWorkspaceState);
  const [reloadVersion, requestReload] = useReducer((value: number) => value + 1, 0);
  const requestGeneration = useRef<CommercialRequestGeneration | null>(null);
  requestGeneration.current ??= new CommercialRequestGeneration();
  const requests = requestGeneration.current;
  const enabled = input.enabled ?? true;
  const { section, mode, from, to, limit, refreshGeneration = 0 } = input;

  useEffect(() => {
    const generation = requests.begin();
    if (!enabled) return;
    let cancelled = false;
    dispatch({ type: 'page_requested' });
    void settleCommercialRequest(
      requests,
      generation,
      fetchCommercialOrderPage(buildCommercialOrderQuery({ section, mode, from, to, limit })),
      (page) => {
        if (!cancelled) {
          dispatch({ type: 'page_succeeded', ...page, append: false });
        }
      },
      (error) => {
        if (!cancelled) {
          dispatch({ type: 'page_failed', message: errorMessage(error) });
        }
      },
    );
    return () => {
      cancelled = true;
      requests.invalidate(generation);
    };
  }, [enabled, from, limit, mode, refreshGeneration, reloadVersion, requests, section, to]);

  useEffect(() => {
    if (!enabled || !state.selectedId) return;
    const selectedId = state.selectedId;
    const generation = requests.capture();
    let cancelled = false;
    dispatch({ type: 'detail_requested' });
    void settleCommercialRequest(
      requests,
      generation,
      fetchCommercialOrderDetail(selectedId),
      (detail) => {
        if (!cancelled) {
          dispatch({ type: 'detail_succeeded', id: selectedId, detail });
        }
      },
      (error) => {
        if (!cancelled) {
          dispatch(
            isCommercialDetailNotFound(error)
              ? { type: 'detail_not_found', id: selectedId }
              : { type: 'detail_failed', id: selectedId, message: errorMessage(error) },
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, requests, state.pageRevision, state.selectedId]);

  const loadMore = useCallback(() => {
    if (!enabled || !state.nextCursor || state.status === 'refreshing') return;
    const generation = requests.capture();
    dispatch({ type: 'page_requested' });
    void settleCommercialRequest(
      requests,
      generation,
      fetchCommercialOrderPage(
        buildCommercialOrderQuery({
          section,
          mode,
          from,
          to,
          cursor: state.nextCursor,
          limit,
        }),
      ),
      (page) => dispatch({ type: 'page_succeeded', ...page, append: true }),
      (error) => dispatch({ type: 'page_failed', message: errorMessage(error) }),
    );
  }, [enabled, from, limit, mode, requests, section, state.nextCursor, state.status, to]);

  return {
    ...state,
    select: (id: string | null) => dispatch({ type: 'selected', id, source: 'queue' }),
    selectExternal: (id: string | null) => dispatch({ type: 'selected', id, source: 'external' }),
    remove: (id: string) => {
      requests.invalidate();
      dispatch({ type: 'detail_not_found', id });
      requestReload();
    },
    reconcileComment: (id: string, comment: CommercialOrderCommentContract) =>
      dispatch({ type: 'comment_reconciled', id, comment }),
    retry: () => {
      requests.invalidate();
      requestReload();
    },
    reset: () => {
      requests.invalidate();
      dispatch({ type: 'reset' });
    },
    loadMore,
  };
}
