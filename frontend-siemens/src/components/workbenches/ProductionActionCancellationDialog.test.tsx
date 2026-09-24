import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ProductionActionCancellationDialog } from './ProductionActionCancellationDialog';

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

describe('ProductionActionCancellationDialog', () => {
  it('requires a reason and explicit acknowledgement of the physical-fact boundary', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ProductionActionCancellationDialog
          title="Отменить назначение"
          detail="Сергей Волков · Станок 1"
          busy={false}
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Причина отмены действия' }).props.onChange({
        target: { value: 'Назначен не тот оператор' },
      });
      renderer.root.findByProps({ 'aria-label': 'Подтвердить безопасную отмену' }).props.onChange({
        currentTarget: { checked: true },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onConfirm).toHaveBeenCalledWith('Назначен не тот оператор');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('makes the non-destructive boundary explicit', () => {
    const markup = JSON.stringify(
      TestRenderer.create(
        <ProductionActionCancellationDialog
          title="Отменить смену станка"
          detail="POST-1 → POST-2"
          busy={false}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      ).toJSON(),
    );

    expect(markup).toContain('Физические факты не удаляются');
    expect(markup).toContain('будут проверены сессия оператора');
  });
});
