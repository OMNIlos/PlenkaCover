import type { ComponentProps } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { CommercialOrderComment } from './CommercialOrderComment';

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

function textarea(root: ReactTestInstance, label: string) {
  return root
    .findAllByType('textarea')
    .find((candidate) => candidate.props['aria-label'] === label);
}

function renderComment(
  props: ComponentProps<typeof CommercialOrderComment>,
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CommercialOrderComment {...props} />);
  });
  return renderer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('CommercialOrderComment', () => {
  it('disables every draft-changing control while a deferred save is pending', async () => {
    const pending = deferred<boolean>();
    const renderer = renderComment({
      comment: 'Старый',
      version: 4,
      editable: true,
      onSave: vi.fn().mockReturnValue(pending.promise),
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Отправленный снимок' },
      }),
    );
    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(textarea(renderer.root, 'Комментарий к заявке')?.props.disabled).toBe(true);
    expect(button(renderer.root, 'Отмена')?.props.disabled).toBe(true);
    expect(button(renderer.root, 'Сохраняем…')?.props.disabled).toBe(true);

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(renderer.root.findAllByType('form')).toHaveLength(0);
  });

  it('saves trimmed text with commentVersion and exits edit mode only on success', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const renderer = renderComment({
      comment: 'Старый',
      version: 4,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: '  Новый  ' },
      }),
    );
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onSave).toHaveBeenCalledWith({ expectedVersion: 4, comment: 'Новый' });
    expect(button(renderer.root, 'Изменить комментарий')).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('Старый');
  });

  it('keeps the editor and draft visible when save returns false', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    const renderer = renderComment({
      comment: null,
      version: 1,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Добавить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Повторить' },
      }),
    );
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(textarea(renderer.root, 'Комментарий к заявке')?.props.value).toBe('Повторить');
  });

  it('keeps the editor and draft visible when save rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Сеть недоступна'));
    const renderer = renderComment({
      comment: 'Старый',
      version: 2,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Черновик' },
      }),
    );
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(textarea(renderer.root, 'Комментарий к заявке')?.props.value).toBe('Черновик');
  });

  it('submits the version captured when editing started after props refresh', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    const renderer = renderComment({
      comment: 'Версия 4',
      version: 4,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Черновик версии 4' },
      }),
    );
    act(() => {
      renderer.update(
        <CommercialOrderComment
          comment="Версия 5"
          version={5}
          editable
          onSave={onSave}
        />,
      );
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onSave).toHaveBeenCalledWith({
      expectedVersion: 4,
      comment: 'Черновик версии 4',
    });
    expect(textarea(renderer.root, 'Комментарий к заявке')?.props.value).toBe(
      'Черновик версии 4',
    );
  });

  it('closes and hard-disables an open editor when edit permission is revoked', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const renderer = renderComment({
      comment: 'Сохранённый текст',
      version: 4,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    const submit = renderer.root.findByType('form').props.onSubmit;
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'Несохранённый текст' },
      }),
    );
    act(() => {
      renderer.update(
        <CommercialOrderComment
          comment="Сохранённый текст"
          version={5}
          editable={false}
          onSave={onSave}
        />,
      );
    });
    await act(async () => {
      await submit({ preventDefault: vi.fn() });
    });

    expect(renderer.root.findAllByType('form')).toHaveLength(0);
    expect(button(renderer.root, 'Сохранить')).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('Сохранённый текст');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Несохранённый текст');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('recaptures comment and version after cancel and after a successful refresh', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const renderer = renderComment({
      comment: 'Версия 1',
      version: 1,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() => button(renderer.root, 'Отмена')?.props.onClick());
    act(() => {
      renderer.update(
        <CommercialOrderComment comment="Версия 2" version={2} editable onSave={onSave} />,
      );
    });
    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    act(() => {
      renderer.update(
        <CommercialOrderComment comment="Версия 3" version={3} editable onSave={onSave} />,
      );
    });
    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onSave.mock.calls).toEqual([
      [{ expectedVersion: 2, comment: 'Версия 2' }],
      [{ expectedVersion: 3, comment: 'Версия 3' }],
    ]);
  });

  it('shows the character count and disables save above 1,000 characters', () => {
    const renderer = renderComment({
      comment: null,
      version: 1,
      editable: true,
      onSave: vi.fn().mockResolvedValue(true),
    });

    act(() => button(renderer.root, 'Добавить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: 'я'.repeat(1001) },
      }),
    );

    expect(
      renderer.root.findByProps({ 'aria-live': 'polite' }).children.join(''),
    ).toBe('1001 / 1000');
    expect(button(renderer.root, 'Сохранить')?.props.disabled).toBe(true);
  });

  it('allows whitespace to clear an existing comment', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const renderer = renderComment({
      comment: 'Убрать',
      version: 8,
      editable: true,
      onSave,
    });

    act(() => button(renderer.root, 'Изменить комментарий')?.props.onClick());
    act(() =>
      textarea(renderer.root, 'Комментарий к заявке')?.props.onChange({
        currentTarget: { value: '   ' },
      }),
    );
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onSave).toHaveBeenCalledWith({ expectedVersion: 8, comment: '' });
  });

  it('does not expose mutation controls when editing parameters is locked', () => {
    const renderer = renderComment({
      comment: 'Только чтение',
      version: 3,
      editable: false,
      onSave: vi.fn().mockResolvedValue(true),
    });

    expect(button(renderer.root, 'Изменить комментарий')).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('Только чтение');
  });
});
