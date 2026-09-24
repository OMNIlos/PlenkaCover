import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mergeTableFilterSearchParams,
  parseTableFilterState,
  reconcileTableFilterState,
  updateTableFilterState,
  type TableFilterStateChange,
  type TableFilterStateV1,
  type TableFilterUrlContract,
} from '../../domain/tableFiltering';

function readInitialState(
  scope: string,
  defaults: TableFilterStateV1,
  contract: TableFilterUrlContract,
) {
  if (typeof window === 'undefined') return defaults;
  return parseTableFilterState(
    scope,
    new URLSearchParams(window.location.search),
    defaults,
    contract,
  );
}

export function usePlenkiTableState({
  scope,
  defaults,
  contract,
  contextKey = scope,
  urlSyncEnabled = true,
}: {
  scope: string;
  defaults: TableFilterStateV1;
  contract: TableFilterUrlContract;
  contextKey?: string;
  urlSyncEnabled?: boolean;
}) {
  const defaultsRef = useRef(defaults);
  const contractRef = useRef(contract);
  const previousContextRef = useRef(contextKey);
  const skipUrlSyncRef = useRef(true);
  defaultsRef.current = defaults;
  contractRef.current = contract;
  const [state, setState] = useState<TableFilterStateV1>(() =>
    readInitialState(scope, defaults, contract),
  );

  const replaceUrlState = useCallback(
    (nextState: TableFilterStateV1) => {
      if (typeof window === 'undefined') return;
      const params = mergeTableFilterSearchParams(
        new URLSearchParams(window.location.search),
        scope,
        nextState,
      );
      const search = params.toString();
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
      );
    },
    [scope],
  );

  const change = useCallback((changeEvent: TableFilterStateChange) => {
    setState((current) => updateTableFilterState(current, changeEvent));
  }, []);

  const reset = useCallback(() => {
    change({ type: 'reset', defaults: defaultsRef.current });
  }, [change]);

  useEffect(() => {
    if (previousContextRef.current === contextKey) return;
    previousContextRef.current = contextKey;
    skipUrlSyncRef.current = true;
    setState(readInitialState(scope, defaultsRef.current, contractRef.current));
  }, [contextKey, scope]);

  const pageSizeContractKey = contract.pageSizes.join('|');
  useEffect(() => {
    setState((current) =>
      reconcileTableFilterState(current, defaultsRef.current, contractRef.current),
    );
  }, [pageSizeContractKey, defaults.pageSize]);

  useEffect(() => {
    if (!urlSyncEnabled) return;
    if (skipUrlSyncRef.current) {
      skipUrlSyncRef.current = false;
      return;
    }
    replaceUrlState(state);
  }, [replaceUrlState, state, urlSyncEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPopState = () =>
      setState(
        parseTableFilterState(
          scope,
          new URLSearchParams(window.location.search),
          defaultsRef.current,
          contractRef.current,
        ),
      );
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [scope]);

  return { state, change, reset };
}
