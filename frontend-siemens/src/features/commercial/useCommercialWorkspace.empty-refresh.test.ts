import { describe, expect, it } from 'vitest';
import {
  commercialWorkspaceReducer,
  initialCommercialWorkspaceState,
} from './useCommercialWorkspace';

describe('commercial workspace empty refresh', () => {
  it('keeps a resolved empty queue visible during background refresh', () => {
    const ready = commercialWorkspaceReducer(initialCommercialWorkspaceState, {
      type: 'page_succeeded',
      items: [],
      nextCursor: null,
      append: false,
    });

    expect(ready.status).toBe('ready');

    const refreshing = commercialWorkspaceReducer(ready, { type: 'page_requested' });

    expect(refreshing.status).toBe('refreshing');
    expect(refreshing.items).toEqual([]);
  });
});
