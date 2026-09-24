import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { DirectorSupplementalState } from '../../features/director/useDirectorSupplementalObjects';
import { DirectorSupplementalAvailability } from './directorWorkbench';

describe('DirectorSupplementalAvailability', () => {
  it('shows each unavailable source independently and retries only the failed source', () => {
    const state: DirectorSupplementalState = {
      finance: { status: 'error', objects: [] },
      production: { status: 'loading', objects: [] },
      warehouse: { status: 'ready', objects: [] },
    };
    const onRetry = vi.fn();
    const view = create(<DirectorSupplementalAvailability state={state} onRetry={onRetry} />);

    const finance = view.root.findByProps({ 'data-director-supplemental': 'finance' });
    const production = view.root.findByProps({ 'data-director-supplemental': 'production' });
    expect(finance.props['data-load-state']).toBe('error');
    expect(production.props['data-load-state']).toBe('loading');
    expect(view.root.findAllByProps({ 'data-director-supplemental': 'warehouse' })).toHaveLength(0);

    finance.findByType('button').props.onClick();
    expect(onRetry).toHaveBeenCalledWith('finance');
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
