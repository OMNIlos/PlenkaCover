import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  DirectorEvidenceTableToolbar,
  type DirectorEvidenceFilterGroup,
} from './DirectorEvidenceTableToolbar';

type ShiftField = 'operatorQuery' | 'startKgMin' | 'status';

const shiftGroups = [
  {
    id: 'operator',
    label: 'Оператор / пост',
    fields: [
      {
        key: 'operatorQuery',
        label: 'Оператор',
        kind: 'text',
      },
    ],
  },
  {
    id: 'weight',
    label: 'Начало / остаток',
    fields: [
      {
        key: 'startKgMin',
        label: 'Вес начала, от',
        kind: 'number',
        min: 0,
        step: 0.001,
      },
    ],
  },
  {
    id: 'status',
    label: 'Статус',
    fields: [
      {
        key: 'status',
        label: 'Статус сверки',
        kind: 'select',
        options: [
          { value: '', label: 'Все статусы' },
          { value: 'ok', label: 'В норме' },
        ],
      },
    ],
  },
] as const satisfies ReadonlyArray<DirectorEvidenceFilterGroup<ShiftField>>;

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function buttonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root
    .findAllByType('button')
    .find((button) => textContent(button) === text)!;
}

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof DirectorEvidenceTableToolbar<ShiftField>>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DirectorEvidenceTableToolbar
        tableId="shift"
        search="Анна"
        groups={shiftGroups}
        values={{ operatorQuery: 'Анна', startKgMin: '20', status: '' }}
        errors={{}}
        onSearchChange={vi.fn()}
        onValueChange={vi.fn()}
        onReset={vi.fn()}
        {...overrides}
      />,
    );
  });
  return renderer;
}

describe('DirectorEvidenceTableToolbar', () => {
  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('keeps native %s activation on the filter toggle', (_label, key) => {
    const renderer = renderToolbar();
    const toggle = buttonByText(renderer.root, 'Фильтры · 2');

    expect(toggle.props.type).toBe('button');
    expect(toggle.props.tabIndex).toBeUndefined();
    expect(toggle.props.onKeyDown).toBeUndefined();

    act(() => toggle.props.onClick({ detail: 0, key }));

    expect(buttonByText(renderer.root, 'Фильтры · 2').props['aria-expanded']).toBe(true);
  });

  it('opens typed filter groups and exposes the active advanced-filter count', () => {
    const renderer = renderToolbar();
    const toggle = buttonByText(renderer.root, 'Фильтры · 2');

    expect(toggle.type).toBe('button');
    expect(toggle.props.type).toBe('button');
    expect(toggle.props['aria-expanded']).toBe(false);

    act(() => toggle.props.onClick());

    expect(buttonByText(renderer.root, 'Фильтры · 2').props['aria-expanded']).toBe(true);
    const startInput = renderer.root.findByProps({ id: 'shift-filter-startKgMin' });
    const startLabel = renderer.root.findByProps({ htmlFor: 'shift-filter-startKgMin' });
    expect(startInput.props.type).toBe('number');
    expect(startInput.props.value).toBe('20');
    expect(startInput.props.min).toBe(0);
    expect(startInput.props.step).toBe(0.001);
    expect(textContent(startLabel)).toBe('Вес начала, от');
    expect(
      renderer.root.findAllByType('legend').map((legend) => textContent(legend)),
    ).toEqual(['Оператор / пост', 'Начало / остаток', 'Статус']);
  });

  it('changes search and fields, and removes a chip through the typed callback', () => {
    const onSearchChange = vi.fn();
    const onValueChange = vi.fn();
    const renderer = renderToolbar({ onSearchChange, onValueChange });

    act(() => {
      renderer.root
        .findByProps({ id: 'shift-search' })
        .props.onChange({ currentTarget: { value: 'Смена 2' } });
    });
    expect(onSearchChange).toHaveBeenCalledWith('Смена 2');

    const removeOperator = renderer.root.findByProps({
      'aria-label': 'Удалить фильтр Оператор: Анна',
    });
    expect(removeOperator.type).toBe('button');
    expect(removeOperator.props.type).toBe('button');
    act(() => removeOperator.props.onClick());
    expect(onValueChange).toHaveBeenCalledWith('operatorQuery', '');

    act(() => buttonByText(renderer.root, 'Фильтры · 2').props.onClick());
    act(() => {
      renderer.root
        .findByProps({ id: 'shift-filter-status' })
        .props.onChange({ currentTarget: { value: 'ok' } });
    });
    expect(onValueChange).toHaveBeenCalledWith('status', 'ok');
  });

  it('associates inline errors with fields and keeps every action keyboard-operable', () => {
    const onReset = vi.fn();
    const renderer = renderToolbar({
      errors: { startKgMin: 'Значение не может быть отрицательным.' },
      onReset,
    });

    act(() => buttonByText(renderer.root, 'Фильтры · 2').props.onClick());

    const startInput = renderer.root.findByProps({ id: 'shift-filter-startKgMin' });
    const errorId = startInput.props['aria-describedby'];
    expect(startInput.props['aria-invalid']).toBe(true);
    expect(errorId).toBe('shift-filter-startKgMin-error');
    expect(textContent(renderer.root.findByProps({ id: errorId }))).toBe(
      'Значение не может быть отрицательным.',
    );

    const reset = buttonByText(renderer.root, 'Сбросить');
    expect(reset.type).toBe('button');
    expect(reset.props.type).toBe('button');
    act(() => reset.props.onClick());
    expect(onReset).toHaveBeenCalledOnce();
  });
});
