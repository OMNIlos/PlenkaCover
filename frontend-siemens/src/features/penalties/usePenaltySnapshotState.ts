import { useCallback, useEffect, useRef, useState } from 'react';

import type { PenaltySnapshotFilters, PenaltySnapshotRuntime } from '../../api/penalties';

export type PenaltySnapshotRole = 'production' | 'director';

type RolePenaltySnapshotState = {
  snapshot: PenaltySnapshotRuntime;
  filters: PenaltySnapshotFilters;
  pending: boolean;
};

type PenaltySnapshotStateByRole = Record<PenaltySnapshotRole, RolePenaltySnapshotState>;

type FetchPenaltySnapshot = (
  filters: PenaltySnapshotFilters,
  options: { signal: AbortSignal },
) => Promise<PenaltySnapshotRuntime>;

type RequestOutcome = 'success' | 'failed' | 'superseded';

type RequestFrontier = {
  generation: number;
  controller: AbortController | null;
  pending: boolean;
  filterRequest: Promise<RequestOutcome> | null;
  refreshRequest: Promise<boolean> | null;
  resetEpoch: number;
};

export type PenaltySnapshotStateController = {
  byRole: PenaltySnapshotStateByRole;
  changeFilters: (role: PenaltySnapshotRole, filters: PenaltySnapshotFilters) => Promise<boolean>;
  refresh: (role: PenaltySnapshotRole) => Promise<boolean>;
  applyPeriodicSnapshot: (
    role: PenaltySnapshotRole,
    filters: PenaltySnapshotFilters,
    snapshot: PenaltySnapshotRuntime,
    requestVersion: number,
  ) => void;
  getAppliedFilters: (role: PenaltySnapshotRole) => PenaltySnapshotFilters;
  getRequestVersion: (role: PenaltySnapshotRole) => number;
  reset: (role: PenaltySnapshotRole) => void;
};

export function emptyPenaltySnapshot(): PenaltySnapshotRuntime {
  return {
    items: [],
    summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
  };
}

function emptyRoleState(): RolePenaltySnapshotState {
  return { snapshot: emptyPenaltySnapshot(), filters: {}, pending: false };
}

function initialState(): PenaltySnapshotStateByRole {
  return { production: emptyRoleState(), director: emptyRoleState() };
}

function sameFilters(left: PenaltySnapshotFilters, right: PenaltySnapshotFilters): boolean {
  return (
    left.targetRole === right.targetRole &&
    left.status === right.status &&
    left.employeeId === right.employeeId
  );
}

function copyFilters(filters: PenaltySnapshotFilters): PenaltySnapshotFilters {
  return { ...filters };
}

function emptyRequestFrontier(): RequestFrontier {
  return {
    generation: 0,
    controller: null,
    pending: false,
    filterRequest: null,
    refreshRequest: null,
    resetEpoch: 0,
  };
}

export function usePenaltySnapshotState({
  fetchSnapshot,
  onError,
}: {
  fetchSnapshot: FetchPenaltySnapshot;
  onError: (role: PenaltySnapshotRole, error: unknown) => void;
}): PenaltySnapshotStateController {
  const [byRole, setByRole] = useState<PenaltySnapshotStateByRole>(initialState);
  const fetchSnapshotRef = useRef(fetchSnapshot);
  const onErrorRef = useRef(onError);
  const appliedFiltersRef = useRef<Record<PenaltySnapshotRole, PenaltySnapshotFilters>>({
    production: {},
    director: {},
  });
  const frontiersRef = useRef<Record<PenaltySnapshotRole, RequestFrontier>>({
    production: emptyRequestFrontier(),
    director: emptyRequestFrontier(),
  });
  fetchSnapshotRef.current = fetchSnapshot;
  onErrorRef.current = onError;

  const performRequest = useCallback(
    async (
      role: PenaltySnapshotRole,
      requestedFilters: PenaltySnapshotFilters,
    ): Promise<RequestOutcome> => {
      const filters = copyFilters(requestedFilters);
      const frontier = frontiersRef.current[role];
      frontier.controller?.abort();
      frontier.generation += 1;
      const generation = frontier.generation;
      const controller = new AbortController();
      frontier.controller = controller;
      frontier.pending = true;
      setByRole((current) => ({
        ...current,
        [role]: { ...current[role], pending: true },
      }));

      try {
        const snapshot = await fetchSnapshotRef.current(filters, { signal: controller.signal });
        if (controller.signal.aborted || generation !== frontier.generation) return 'superseded';
        appliedFiltersRef.current[role] = filters;
        frontier.pending = false;
        frontier.controller = null;
        setByRole((current) => ({
          ...current,
          [role]: { snapshot, filters, pending: false },
        }));
        return 'success';
      } catch (error) {
        if (controller.signal.aborted || generation !== frontier.generation) return 'superseded';
        frontier.pending = false;
        frontier.controller = null;
        setByRole((current) => ({
          ...current,
          [role]: { ...current[role], pending: false },
        }));
        onErrorRef.current(role, error);
        return 'failed';
      }
    },
    [],
  );

  const changeFilters = useCallback(
    (role: PenaltySnapshotRole, filters: PenaltySnapshotFilters) => {
      const frontier = frontiersRef.current[role];
      const request = performRequest(role, filters);
      const trackedRequest = request.then((outcome) => {
        if (frontier.filterRequest === trackedRequest) frontier.filterRequest = null;
        return outcome;
      });
      frontier.filterRequest = trackedRequest;
      return trackedRequest.then((outcome) => outcome === 'success');
    },
    [performRequest],
  );

  const refresh = useCallback(
    (role: PenaltySnapshotRole) => {
      const frontier = frontiersRef.current[role];
      if (frontier.refreshRequest) return frontier.refreshRequest;
      const resetEpoch = frontier.resetEpoch;
      const request = (async () => {
        while (frontier.resetEpoch === resetEpoch) {
          const filterRequest = frontier.filterRequest;
          if (filterRequest) {
            await filterRequest;
            continue;
          }
          const outcome = await performRequest(role, appliedFiltersRef.current[role]);
          if (outcome === 'success') return true;
          if (outcome === 'failed') return false;
        }
        return false;
      })();
      const trackedRequest = request.then((result) => {
        if (frontier.refreshRequest === trackedRequest) frontier.refreshRequest = null;
        return result;
      });
      frontier.refreshRequest = trackedRequest;
      return trackedRequest;
    },
    [performRequest],
  );

  const applyPeriodicSnapshot = useCallback(
    (
      role: PenaltySnapshotRole,
      filters: PenaltySnapshotFilters,
      snapshot: PenaltySnapshotRuntime,
      requestVersion: number,
    ) => {
      const frontier = frontiersRef.current[role];
      if (
        frontier.pending ||
        requestVersion !== frontier.generation ||
        !sameFilters(filters, appliedFiltersRef.current[role])
      ) {
        return;
      }
      setByRole((current) => ({
        ...current,
        [role]: { ...current[role], snapshot },
      }));
    },
    [],
  );

  const getAppliedFilters = useCallback(
    (role: PenaltySnapshotRole) => copyFilters(appliedFiltersRef.current[role]),
    [],
  );

  const getRequestVersion = useCallback(
    (role: PenaltySnapshotRole) => frontiersRef.current[role].generation,
    [],
  );

  const reset = useCallback((role: PenaltySnapshotRole) => {
    const frontier = frontiersRef.current[role];
    frontier.controller?.abort();
    frontier.generation += 1;
    frontier.resetEpoch += 1;
    frontier.controller = null;
    frontier.pending = false;
    frontier.filterRequest = null;
    frontier.refreshRequest = null;
    appliedFiltersRef.current[role] = {};
    setByRole((current) => ({ ...current, [role]: emptyRoleState() }));
  }, []);

  useEffect(
    () => () => {
      for (const role of ['production', 'director'] as const) {
        const frontier = frontiersRef.current[role];
        frontier.controller?.abort();
        frontier.generation += 1;
        frontier.resetEpoch += 1;
        frontier.filterRequest = null;
        frontier.refreshRequest = null;
      }
    },
    [],
  );

  return {
    byRole,
    changeFilters,
    refresh,
    applyPeriodicSnapshot,
    getAppliedFilters,
    getRequestVersion,
    reset,
  };
}
