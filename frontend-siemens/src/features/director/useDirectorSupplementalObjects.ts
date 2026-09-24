import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkObject } from '../../domain/types';

export const DIRECTOR_SUPPLEMENTAL_SCOPES = ['finance', 'production', 'warehouse'] as const;

export type DirectorSupplementalScope = (typeof DIRECTOR_SUPPLEMENTAL_SCOPES)[number];
export type DirectorSupplementalLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type DirectorSupplementalSourceState = {
  status: DirectorSupplementalLoadStatus;
  objects: WorkObject[];
};

export type DirectorSupplementalState = Record<
  DirectorSupplementalScope,
  DirectorSupplementalSourceState
>;

type DirectorSupplementalLoader = (options: { signal: AbortSignal }) => Promise<WorkObject[]>;

type DirectorSupplementalLoaders = Record<DirectorSupplementalScope, DirectorSupplementalLoader>;

type RequestFrontier = {
  controller: AbortController | null;
  generation: number;
};

function emptySourceState(): DirectorSupplementalSourceState {
  return { status: 'idle', objects: [] };
}

export function emptyDirectorSupplementalState(): DirectorSupplementalState {
  return {
    finance: emptySourceState(),
    production: emptySourceState(),
    warehouse: emptySourceState(),
  };
}

function emptyRequestFrontiers(): Record<DirectorSupplementalScope, RequestFrontier> {
  return {
    finance: { controller: null, generation: 0 },
    production: { controller: null, generation: 0 },
    warehouse: { controller: null, generation: 0 },
  };
}

export function useDirectorSupplementalObjects({
  enabled,
  refreshGeneration,
  loaders,
}: {
  enabled: boolean;
  refreshGeneration: string | number;
  loaders: DirectorSupplementalLoaders;
}) {
  const [byScope, setByScope] = useState<DirectorSupplementalState>(emptyDirectorSupplementalState);
  const loadersRef = useRef(loaders);
  const frontiersRef = useRef(emptyRequestFrontiers());
  loadersRef.current = loaders;

  const abortAll = useCallback(() => {
    for (const scope of DIRECTOR_SUPPLEMENTAL_SCOPES) {
      const frontier = frontiersRef.current[scope];
      frontier.controller?.abort();
      frontier.controller = null;
      frontier.generation += 1;
    }
  }, []);

  const load = useCallback(async (
    scope: DirectorSupplementalScope,
    { keepVisible = false }: { keepVisible?: boolean } = {},
  ): Promise<boolean> => {
    const frontier = frontiersRef.current[scope];
    frontier.controller?.abort();
    frontier.generation += 1;
    const generation = frontier.generation;
    const controller = new AbortController();
    frontier.controller = controller;

    setByScope((current) =>
      // A periodic refresh leaves the loaded rows on screen. Blanking them made
      // every poll flash an "Обновляем данные" banner over the director surface.
      keepVisible && current[scope].status === 'ready'
        ? current
        : {
            ...current,
            [scope]: { status: 'loading', objects: [] },
          },
    );

    try {
      const objects = await loadersRef.current[scope]({ signal: controller.signal });
      if (controller.signal.aborted || frontier.generation !== generation) return false;
      frontier.controller = null;
      setByScope((current) => ({
        ...current,
        [scope]: { status: 'ready', objects },
      }));
      return true;
    } catch {
      if (controller.signal.aborted || frontier.generation !== generation) return false;
      frontier.controller = null;
      setByScope((current) => ({
        ...current,
        [scope]: { status: 'error', objects: [] },
      }));
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      abortAll();
      setByScope(emptyDirectorSupplementalState());
      return;
    }

    for (const scope of DIRECTOR_SUPPLEMENTAL_SCOPES) void load(scope, { keepVisible: true });
    return abortAll;
  }, [abortAll, enabled, load, refreshGeneration]);

  const retry = useCallback(
    (scope: DirectorSupplementalScope) => {
      if (!enabled) return Promise.resolve(false);
      return load(scope);
    },
    [enabled, load],
  );

  return { byScope, retry };
}
