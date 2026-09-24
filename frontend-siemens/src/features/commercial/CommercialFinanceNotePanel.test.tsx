import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { CommercialFinanceNotePanel } from './CommercialFinanceNotePanel';

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('CommercialFinanceNotePanel', () => {
  it('saves bounded free text without trying to interpret it as money', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CommercialFinanceNotePanel value="" editable onSave={onSave} />,
      );
    });
    const textarea = renderer.root.findByType('textarea');

    act(() =>
      textarea.props.onChange({
        currentTarget: { value: '1200 за 20 рулонов' },
      }),
    );
    const save = renderer.root
      .findAllByType('button')
      .find((button) => nodeText(button) === 'Сохранить комментарий');
    await act(async () => save?.props.onClick());

    expect(onSave).toHaveBeenCalledWith('1200 за 20 рулонов');
    expect(textarea.props.maxLength).toBe(2000);
  });

  it('locks an unavailable note without claiming an invoice was issued', () => {
    const renderer = TestRenderer.create(
      <CommercialFinanceNotePanel value="Ориентир" editable={false} onSave={vi.fn()} />,
    );

    expect(renderer.root.findByType('textarea').props.disabled).toBe(true);
    expect(nodeText(renderer.root)).toContain(
      'Редактирование недоступно',
    );
  });
});
