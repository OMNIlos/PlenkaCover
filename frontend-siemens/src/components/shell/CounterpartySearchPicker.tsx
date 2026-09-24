import { useState } from 'react';

import type { Counterparty } from '../../domain/types';

export type CounterpartySearchPickerProps = {
  items: Counterparty[];
  value: string;
  selectedLabel?: string;
  labelledBy: string;
  onChange: (counterpartyId: string) => void;
  onSearch?: (query: string) => void;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onCreate?: () => void;
};

export function normalizeCounterpartySearch(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

export function CounterpartySearchPicker({
  items,
  value,
  selectedLabel,
  labelledBy,
  onChange,
  onSearch,
  loading = false,
  hasMore = false,
  onLoadMore,
  onCreate,
}: CounterpartySearchPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const queryValue = normalizeCounterpartySearch(query);
  const selectedItem = items.find((item) => item.id === value);
  const currentLabel = selectedLabel ?? selectedItem?.legalName ?? value;
  const filtered = onSearch
    ? items
    : items.filter(
        (item) =>
          item.id === value ||
          normalizeCounterpartySearch(`${item.legalName} ${item.alias}`).includes(queryValue),
      );
  const hasSyntheticSelection = Boolean(value && !selectedItem && currentLabel);

  return (
    <div className="counterparty-search-picker">
      <div className="counterparty-search-picker-field">
        <input
          type="search"
          aria-label="Поиск контрагента"
          placeholder="Поиск контрагента"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            onSearch?.(event.currentTarget.value);
          }}
        />
        <select
          aria-labelledby={labelledBy}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {!value && (
            <option value="" disabled>
              Выберите контрагента
            </option>
          )}
          {hasSyntheticSelection && <option value={value}>{currentLabel}</option>}
          {filtered.map((item) => (
            <option key={item.id} value={item.id}>
              {item.legalName}
            </option>
          ))}
          {filtered.length === 0 && !hasSyntheticSelection && !loading && (
            <option value="" disabled>
              Контрагенты не найдены
            </option>
          )}
        </select>
      </div>
      {(hasMore && onLoadMore) || onCreate ? (
        <div className="counterparty-search-picker-actions">
          {hasMore && onLoadMore ? (
            <button
              type="button"
              className="counterparty-search-picker-more"
              disabled={loading}
              onClick={onLoadMore}
            >
              Показать ещё
            </button>
          ) : null}
          {onCreate ? (
            <button
              type="button"
              className="counterparty-search-picker-create"
              onClick={onCreate}
            >
              Новый контрагент
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
