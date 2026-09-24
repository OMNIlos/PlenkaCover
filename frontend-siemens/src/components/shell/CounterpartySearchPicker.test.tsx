import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Counterparty } from '../../domain/types';
import { CounterpartySearchPicker, normalizeCounterpartySearch } from './CounterpartySearchPicker';

function input(view: ReturnType<typeof create>) {
  return view.root.findByProps({ 'aria-label': 'Поиск контрагента' });
}

function select(view: ReturnType<typeof create>) {
  return view.root.findByType('select');
}

function button(view: ReturnType<typeof create>, label: string) {
  return view.root
    .findAllByType('button')
    .find((node) => node.props.children === label) as ReactTestInstance;
}

function text(view: ReturnType<typeof create>) {
  return view.toJSON() ? JSON.stringify(view.toJSON()) : '';
}

describe('CounterpartySearchPicker', () => {
  it('uses one searchable native selector without repeating the selected counterparty', () => {
    const view = create(
      <CounterpartySearchPicker
        items={[
          { id: 'cp-1', legalName: 'ООО Ромашка', alias: 'Ромашка' } as Counterparty,
          { id: 'cp-2', legalName: 'АО Контур', alias: 'Контур' } as Counterparty,
        ]}
        value="cp-2"
        labelledBy="counterparty-label"
        onChange={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(view.root.findAllByType('select')).toHaveLength(1);
    expect(view.root.findByType('select').props.value).toBe('cp-2');
    expect(
      view.root.findAllByProps({ className: 'counterparty-search-picker-selected' }),
    ).toHaveLength(0);
  });

  it('matches a counterparty by a normalized name and preserves selection', () => {
    const onChange = vi.fn();
    const onCreate = vi.fn();

    expect(normalizeCounterpartySearch('  ООО   РОМАШКА ')).toBe('ооо ромашка');
    const view = create(
      <CounterpartySearchPicker
        items={[
          { id: 'cp-1', legalName: 'ООО Ромашка', alias: 'Ромашка' } as Counterparty,
          { id: 'cp-2', legalName: 'АО Контур', alias: 'Контур' } as Counterparty,
        ]}
        value="cp-2"
        labelledBy="counterparty-label"
        onChange={onChange}
        onCreate={onCreate}
      />,
    );

    act(() => input(view).props.onChange({ currentTarget: { value: '  РОМАШКА ' } }));

    expect(view.root.findAllByType('option').map((node) => node.props.children)).toEqual(
      expect.arrayContaining(['ООО Ромашка', 'АО Контур']),
    );
    act(() => select(view).props.onChange({ target: { value: 'cp-1' } }));
    expect(onChange).toHaveBeenCalledWith('cp-1');
  });

  it('shows an empty option for unmatched search and keeps quick create available', () => {
    const onCreate = vi.fn();
    const view = create(
      <CounterpartySearchPicker
        items={[{ id: 'cp-1', legalName: 'ООО Ромашка', alias: 'Ромашка' } as Counterparty]}
        value=""
        labelledBy="counterparty-label"
        onChange={vi.fn()}
        onCreate={onCreate}
      />,
    );
    const search = input(view);

    act(() => search.props.onChange({ currentTarget: { value: 'нет такого' } }));
    expect(text(view)).toContain('Контрагенты не найдены');
    act(() => button(view, 'Новый контрагент').props.onClick());
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(button(view, 'Новый контрагент')).toBeDefined();
  });

  it('renders a quick-created counterparty as the current native option', () => {
    const view = create(
      <CounterpartySearchPicker
        items={[]}
        value="__new__"
        selectedLabel="Новый: ООО Покупатель"
        labelledBy="counterparty-label"
        onChange={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(select(view).props.value).toBe('__new__');
    expect(view.root.findAllByType('option').map((node) => node.props.children)).toContain(
      'Новый: ООО Покупатель',
    );
  });

  it('delegates live queries to the server and keeps the selected id pinned', () => {
    const onSearch = vi.fn();
    const view = create(
      <CounterpartySearchPicker
        items={[{ id: 'cp-new', legalName: 'Новый результат', alias: '' } as Counterparty]}
        value="cp-selected"
        selectedLabel="Выбранный контрагент"
        labelledBy="counterparty-label"
        onChange={vi.fn()}
        onSearch={onSearch}
      />,
    );

    act(() => input(view).props.onChange({ currentTarget: { value: 'поиск по ИНН' } }));

    expect(onSearch).toHaveBeenCalledWith('поиск по ИНН');
    expect(select(view).props.value).toBe('cp-selected');
    expect(
      view.root.findAllByType('option').map((node) => [node.props.value, node.props.children]),
    ).toEqual(
      expect.arrayContaining([
        ['cp-selected', 'Выбранный контрагент'],
        ['cp-new', 'Новый результат'],
      ]),
    );
  });

  it('exposes bounded pagination without hiding quick create', () => {
    const onLoadMore = vi.fn();
    const onCreate = vi.fn();
    const view = create(
      <CounterpartySearchPicker
        items={[]}
        value=""
        labelledBy="counterparty-label"
        onChange={vi.fn()}
        onCreate={onCreate}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );

    act(() => button(view, 'Показать ещё').props.onClick());
    act(() => button(view, 'Новый контрагент').props.onClick());

    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('groups pagination and quick create into one compact action stack', () => {
    const view = create(
      <CounterpartySearchPicker
        items={[]}
        value=""
        labelledBy="counterparty-label"
        onChange={vi.fn()}
        onCreate={vi.fn()}
        hasMore
        onLoadMore={vi.fn()}
      />,
    );

    const actions = view.root.findByProps({
      className: 'counterparty-search-picker-actions',
    });

    expect(actions.findAllByType('button').map((node) => node.props.children)).toEqual([
      'Показать ещё',
      'Новый контрагент',
    ]);
  });
});
