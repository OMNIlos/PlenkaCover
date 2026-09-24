import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DirectorRefreshButton } from './DirectorRefreshButton';

describe('DirectorRefreshButton', () => {
  it('keeps one accessible refresh action disabled while busy', () => {
    const onRefresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(<DirectorRefreshButton busy onRefresh={onRefresh} />);
    });

    const button = renderer.root.findByProps({
      'aria-label': 'Обновить данные вкладки',
    });
    expect(button.props.disabled).toBe(true);
    expect(button.props['aria-busy']).toBe(true);
    expect(button.children).toContain('Обновить');

    act(() => button.props.onClick());
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('runs one explicit refresh command when ready', () => {
    const onRefresh = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(<DirectorRefreshButton busy={false} onRefresh={onRefresh} />);
    });

    const button = renderer.root.findByProps({
      'aria-label': 'Обновить данные вкладки',
    });
    act(() => button.props.onClick());

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
