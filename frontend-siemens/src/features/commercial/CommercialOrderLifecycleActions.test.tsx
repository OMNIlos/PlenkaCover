import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommercialOrderLifecycleActions } from './CommercialOrderLifecycleActions';

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

describe('CommercialOrderLifecycleActions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires a reason and cancels active orders without deleting them', async () => {
    const onCancel = vi.fn().mockResolvedValue(true);
    const onDelete = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderLifecycleActions
          orderNumber="З-1"
          cancelled={false}
          busy={false}
          onCancel={onCancel}
          onDelete={onDelete}
        />,
      );
    });

    act(() => button(renderer.root, 'Отменить заказ')?.props.onClick());
    expect(button(renderer.root, 'Подтвердить отмену')?.props.disabled).toBe(true);
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Причина отмены заказа' }).props.onChange({
        currentTarget: { value: '  Клиент отменил остаток  ' },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onCancel).toHaveBeenCalledWith('Клиент отменил остаток');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('keeps irreversible deletion explicit for an already cancelled order', () => {
    const confirm = vi.fn().mockReturnValue(true);
    const onDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('confirm', confirm);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderLifecycleActions
          orderNumber="З-2"
          cancelled
          busy={false}
          onCancel={vi.fn()}
          onDelete={onDelete}
        />,
      );
    });

    act(() => button(renderer.root, 'Удалить заказ')?.props.onClick());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/без возможности восстанов/iu));
  });
});
