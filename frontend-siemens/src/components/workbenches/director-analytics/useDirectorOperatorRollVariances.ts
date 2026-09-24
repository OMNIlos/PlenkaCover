import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  fetchDirectorOperatorRollVariances,
  type ServerDirectorOperatorRollVariancePage,
} from '../../../api/director';

export type RollPageState =
  | { status: 'idle'; page: null; error: null }
  | { status: 'loading'; page: null; error: null }
  | { status: 'ready'; page: ServerDirectorOperatorRollVariancePage; error: null }
  | { status: 'error'; page: null; error: string };

type RollPageModel = {
  rangeKey: string;
  cursorStack: Array<string | undefined>;
  pageIndex: number;
  pageState: RollPageState;
};

type UseDirectorOperatorRollVariancesInput = {
  enabled: boolean;
  range: { from: string; to: string };
  limit?: number;
};

export type DirectorOperatorRollVariancesResult = RollPageState & {
  pageNumber: number;
  canBack: boolean;
  canNext: boolean;
  next: () => void;
  back: () => void;
  retry: () => void;
};

const IDLE_PAGE: RollPageState = { status: 'idle', page: null, error: null };

function rangeKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось загрузить данные';
}

export function useDirectorOperatorRollVariances({
  enabled,
  range,
  limit = 25,
}: UseDirectorOperatorRollVariancesInput): DirectorOperatorRollVariancesResult {
  const activeRangeKey = rangeKey(range.from, range.to);
  const [model, setModel] = useState<RollPageModel>(() => ({
    rangeKey: activeRangeKey,
    cursorStack: [undefined],
    pageIndex: 0,
    pageState: IDLE_PAGE,
  }));
  const generation = useRef(0);
  const currentRangeKey = useRef(activeRangeKey);
  const inFlight = useRef<{ key: string; token: symbol } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (currentRangeKey.current === activeRangeKey) return;
    currentRangeKey.current = activeRangeKey;
    generation.current += 1;
    setModel({
      rangeKey: activeRangeKey,
      cursorStack: [undefined],
      pageIndex: 0,
      pageState: IDLE_PAGE,
    });
  }, [activeRangeKey]);

  const requestPage = useCallback(
    (
      cursor: string | undefined,
      pageIndex: number,
      expectedRangeKey: string,
      expectedGeneration: number,
    ) => {
      const requestKey = JSON.stringify([expectedRangeKey, pageIndex, cursor ?? null]);
      if (inFlight.current?.key === requestKey) return;

      const token = Symbol(requestKey);
      inFlight.current = { key: requestKey, token };
      setModel((current) =>
        current.rangeKey === expectedRangeKey && current.pageIndex === pageIndex
          ? {
              ...current,
              pageState: { status: 'loading', page: null, error: null },
            }
          : current,
      );

      let request: Promise<ServerDirectorOperatorRollVariancePage>;
      try {
        request = fetchDirectorOperatorRollVariances({
          from: range.from,
          to: range.to,
          cursor,
          limit,
        });
      } catch (error) {
        request = Promise.reject(error);
      }

      void request
        .then((page) => {
          if (
            !mounted.current ||
            generation.current !== expectedGeneration ||
            currentRangeKey.current !== expectedRangeKey
          ) {
            return;
          }
          setModel((current) =>
            current.rangeKey === expectedRangeKey && current.pageIndex === pageIndex
              ? {
                  ...current,
                  pageState: { status: 'ready', page, error: null },
                }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (
            !mounted.current ||
            generation.current !== expectedGeneration ||
            currentRangeKey.current !== expectedRangeKey
          ) {
            return;
          }
          setModel((current) =>
            current.rangeKey === expectedRangeKey && current.pageIndex === pageIndex
              ? {
                  ...current,
                  pageState: {
                    status: 'error',
                    page: null,
                    error: errorMessage(error),
                  },
                }
              : current,
          );
        })
        .finally(() => {
          if (inFlight.current?.token === token) inFlight.current = null;
        });
    },
    [limit, range.from, range.to],
  );

  useEffect(() => {
    if (!enabled || model.rangeKey !== activeRangeKey || model.pageState.status !== 'idle') {
      return;
    }
    requestPage(
      model.cursorStack[model.pageIndex],
      model.pageIndex,
      model.rangeKey,
      generation.current,
    );
  }, [
    activeRangeKey,
    enabled,
    model.cursorStack,
    model.pageIndex,
    model.pageState.status,
    model.rangeKey,
    requestPage,
  ]);

  const next = useCallback(() => {
    setModel((current) => {
      if (current.pageState.status !== 'ready' || current.pageState.page.nextCursor === null) {
        return current;
      }
      return {
        ...current,
        cursorStack: [
          ...current.cursorStack.slice(0, current.pageIndex + 1),
          current.pageState.page.nextCursor,
        ],
        pageIndex: current.pageIndex + 1,
        pageState: IDLE_PAGE,
      };
    });
  }, []);

  const back = useCallback(() => {
    setModel((current) =>
      current.pageIndex === 0
        ? current
        : {
            ...current,
            pageIndex: current.pageIndex - 1,
            pageState: IDLE_PAGE,
          },
    );
  }, []);

  const retry = useCallback(() => {
    setModel((current) =>
      current.pageState.status === 'error' ? { ...current, pageState: IDLE_PAGE } : current,
    );
  }, []);

  const visibleModel =
    model.rangeKey === activeRangeKey
      ? model
      : {
          rangeKey: activeRangeKey,
          cursorStack: [undefined],
          pageIndex: 0,
          pageState: IDLE_PAGE,
        };
  const { pageState } = visibleModel;

  return {
    ...pageState,
    pageNumber: visibleModel.pageIndex + 1,
    canBack: visibleModel.pageIndex > 0 && pageState.status !== 'loading',
    canNext: pageState.status === 'ready' && pageState.page.nextCursor !== null,
    next,
    back,
    retry,
  };
}
