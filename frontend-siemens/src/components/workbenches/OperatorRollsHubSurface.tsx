import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IxEmptyState } from '@siemens/ix-react';

import { applyDateScope, DateScopeDropdown } from '../shell/DateScopeDropdown';
import {
  operatorRollHubGroups,
  operatorRollHubRows,
  sortOperatorRollHubRows,
} from '../../domain/operatorRuntime';
import type { QueueDateScope } from '../../domain/types';
import type {
  OperatorOrderHubGroup,
  OperatorRollHubRow,
  OperatorRollHubSortDirection,
  OperatorRollHubSortKey,
  OperatorRuntimeState,
} from '../../domain/operatorRuntime';

type HubFilter = 'active' | 'defect' | 'archive';
type HubScope = 'all' | 'handover';
type HubViewMode = 'orders' | 'queue';

type OperatorScrollTarget = {
  scrollTo: (options: { top: number; behavior: 'auto' }) => void;
};

export function isOperatorWorkstationWidth(
  viewportWidth: number,
  outerWidth = viewportWidth,
  devicePixelRatio = 1,
) {
  const physicalWindowWidth = Math.max(viewportWidth, outerWidth) * Math.max(1, devicePixelRatio);
  const isFullSizePhysicalWorkstation = viewportWidth >= 800 && physicalWindowWidth >= 1000;
  return viewportWidth > 0 && viewportWidth <= 999 && !isFullSizePhysicalWorkstation;
}
export function resetOperatorScrollTargets(
  viewportWidth: number,
  targets: Array<OperatorScrollTarget | null | undefined>,
) {
  if (!isOperatorWorkstationWidth(viewportWidth)) return false;
  const uniqueTargets = new Set(
    targets.filter((target): target is OperatorScrollTarget => Boolean(target)),
  );
  for (const target of uniqueTargets) target.scrollTo({ top: 0, behavior: 'auto' });
  return true;
}

export function resetOperatorSectionScrollTargets(
  targets: Array<OperatorScrollTarget | null | undefined>,
) {
  const uniqueTargets = new Set(
    targets.filter((target): target is OperatorScrollTarget => Boolean(target)),
  );
  for (const target of uniqueTargets) target.scrollTo({ top: 0, behavior: 'auto' });
}

export function OperatorRollsHubPageLayout({
  detailFirst,
  hasDetail,
  navigation,
  hub,
  detail,
}: {
  detailFirst: boolean;
  hasDetail: boolean;
  navigation: ReactNode;
  hub: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div
      className="operator-rolls-hub-page"
      data-detail-first={detailFirst ? 'true' : 'false'}
      data-has-detail={hasDetail ? 'true' : 'false'}
    >
      {navigation}
      {!hasDetail ? (
        hub
      ) : detailFirst ? (
        <>
          {detail}
          {hub}
        </>
      ) : (
        <>
          {hub}
          {detail}
        </>
      )}
    </div>
  );
}

const hubFilters: Array<{ id: HubFilter; label: string }> = [
  { id: 'active', label: 'Активные' },
  { id: 'defect', label: 'Брак' },
  { id: 'archive', label: 'Завершенные' },
];

const columns: Array<{
  key: OperatorRollHubSortKey;
  dataColumn: string;
  label: string;
}> = [
  { key: 'queue', dataColumn: 'queue', label: '#' },
  { key: 'roll', dataColumn: 'roll', label: 'Рулон' },
  { key: 'order', dataColumn: 'order', label: 'Заказ' },
  { key: 'priority', dataColumn: 'priority', label: 'Приоритет' },
  { key: 'status', dataColumn: 'status', label: 'Статус' },
  { key: 'step', dataColumn: 'step', label: 'Шаг' },
  { key: 'machine', dataColumn: 'machine', label: 'Станок' },
  { key: 'parameters', dataColumn: 'parameters', label: 'Параметры' },
  { key: 'weight', dataColumn: 'weight', label: 'План/факт' },
  { key: 'qr', dataColumn: 'qrWarehouse', label: 'QR/склад' },
  { key: 'blocker', dataColumn: 'blocker', label: 'Блокер' },
  { key: 'updated', dataColumn: 'updated', label: 'Обновлено' },
];

function filterRows(rows: OperatorRollHubRow[], filter: HubFilter, scope: HubScope) {
  if (scope === 'handover') return rows.filter((row) => row.isArchived);
  if (filter === 'archive') return rows.filter((row) => row.isArchived);
  if (filter === 'defect') {
    return rows.filter((row) => row.roll.status === 'defect');
  }
  return rows.filter((row) => !row.isArchived && row.roll.status !== 'defect');
}

function sortAria(
  isActive: boolean,
  direction: OperatorRollHubSortDirection,
): 'none' | 'ascending' | 'descending' {
  if (!isActive) return 'none';
  return direction === 'asc' ? 'ascending' : 'descending';
}

function rowSearchText(row: OperatorRollHubRow) {
  return [
    row.id,
    row.orderCode,
    row.priority,
    row.status,
    row.step,
    row.machine,
    row.parameters,
    row.recipe,
    row.plannedWeight,
    row.weight,
    row.qrWarehouse,
    row.blocker,
  ]
    .join(' ')
    .toLowerCase();
}

function OrderGroupBand({
  group,
  expanded,
  onToggle,
}: {
  group: OperatorOrderHubGroup;
  expanded: boolean;
  onToggle: (groupId: string) => void;
}) {
  return (
    <div className={`operator-rolls-hub-order-band ${expanded ? 'is-expanded' : ''}`} role="row">
      <button
        type="button"
        onClick={() => onToggle(group.id)}
        aria-expanded={expanded}
        aria-controls={`operator-order-group-${group.id}`}
      >
        <span className="operator-rolls-hub-disclosure" aria-hidden="true">
          {expanded ? 'v' : '>'}
        </span>
        <span>
          <strong>Заказ {group.orderCode}</strong>
          <small>{group.status}</small>
        </span>
        <span>
          <b>{group.rows.length}</b>
          <small>рулонов</small>
        </span>
        <span>
          <b>{group.progress}</b>
          <small>закрыто</small>
        </span>
        <span>
          <b>{group.priority}</b>
          <small>{group.updated}</small>
        </span>
        {group.blockedRolls > 0 && <em>{group.blockedRolls} блок.</em>}
      </button>
    </div>
  );
}

function RollRow({
  row,
  selected,
  onSelect,
}: {
  row: OperatorRollHubRow;
  selected: boolean;
  onSelect: (rollId: string) => void;
}) {
  const select = () => onSelect(row.id);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  };

  return (
    <div
      className={`operator-rolls-hub-row severity-${row.severity} ${row.isCurrent ? 'is-current' : ''} ${row.isArchived ? 'is-archived' : ''} ${selected ? 'is-selected' : ''}`}
      role="row"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={`Открыть рулон ${row.id}, рецептура ${row.recipe}, плановый вес ${row.plannedWeight}, заказ ${row.orderCode}, ${row.status}, ${row.step}`}
      title={`${row.id} · ${row.recipe} · Плановый вес: ${row.plannedWeight}`}
      onClick={select}
      onKeyDown={handleKeyDown}
    >
      <span role="cell" data-column="queue" data-label="#">
        <strong>{row.queueRank}</strong>
      </span>
      <span role="cell" data-column="roll" data-label="Рулон" className="operator-rolls-hub-main">
        <strong title={row.recipe}>{row.recipe}</strong>
        <small>План: {row.plannedWeight}</small>
      </span>
      <span role="cell" data-column="order" data-label="Заказ">
        <strong>{row.orderCode}</strong>
        <small>Производственное задание</small>
      </span>
      <span role="cell" data-column="priority" data-label="Приоритет">
        <strong>{row.priority}</strong>
      </span>
      <span role="cell" data-column="status" data-label="Статус">
        <strong>{row.status}</strong>
      </span>
      <span role="cell" data-column="step" data-label="Шаг">
        <strong>{row.step}</strong>
      </span>
      <span role="cell" data-column="machine" data-label="Станок">
        <strong>{row.machine}</strong>
      </span>
      <span role="cell" data-column="parameters" data-label="Параметры">
        <strong>{row.parameters}</strong>
      </span>
      <span role="cell" data-column="weight" data-label="План/факт">
        <strong>{row.weight}</strong>
      </span>
      <span role="cell" data-column="qrWarehouse" data-label="QR/склад">
        <strong>{row.qrWarehouse}</strong>
      </span>
      <span
        role="cell"
        data-column="blocker"
        data-label="Блокер"
        className={row.blocker !== 'Нет' ? 'has-blocker' : ''}
      >
        <strong>{row.blocker}</strong>
      </span>
      <span role="cell" data-column="updated" data-label="Обновлено">
        <strong>{row.updated}</strong>
      </span>
    </div>
  );
}

export function OperatorRollsHubSurface({
  runtime,
  selectedRollId,
  onSelectRoll,
  scope = 'all',
}: {
  runtime: OperatorRuntimeState;
  selectedRollId: string | null;
  onSelectRoll: (rollId: string, scrollToDetail?: boolean) => void;
  scope?: HubScope;
}) {
  const [filter, setFilter] = useState<HubFilter>('active');
  const [dateScope, setDateScope] = useState<QueueDateScope>('all');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<HubViewMode>('orders');
  const [sort, setSort] = useState<{
    key: OperatorRollHubSortKey;
    direction: OperatorRollHubSortDirection;
  }>({ key: 'queue', direction: 'asc' });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const isHandoverScope = scope === 'handover';

  const allRows = useMemo(() => operatorRollHubRows(runtime), [runtime]);
  const scopedRows = useMemo(() => filterRows(allRows, filter, scope), [allRows, filter, scope]);
  const dateRows = useMemo(() => applyDateScope(scopedRows, dateScope), [dateScope, scopedRows]);
  const rows = useMemo(() => {
    const queryText = query.trim().toLowerCase();
    const filtered = dateRows.filter((row) => !queryText || rowSearchText(row).includes(queryText));
    return sortOperatorRollHubRows(filtered, sort.key, sort.direction);
  }, [dateRows, query, sort]);
  const groups = useMemo(() => operatorRollHubGroups(rows), [rows]);
  const displayedColumns = useMemo(
    () =>
      isHandoverScope
        ? columns.map((column) =>
            column.key === 'updated' ? { ...column, label: 'Передано' } : column,
          )
        : columns,
    [isHandoverScope],
  );
  const activeCount = allRows.filter(
    (row) => !row.isArchived && row.roll.status !== 'defect',
  ).length;
  const actionCount = allRows.filter((row) => !row.isArchived && row.isCurrent).length;
  const defectCount = allRows.filter((row) => row.roll.status === 'defect').length;
  const archiveCount = allRows.filter((row) => row.isArchived).length;
  const receivedCount = allRows.filter(
    (row) => row.roll.warehouseState === 'received' || row.roll.warehouseState === 'delivered',
  ).length;

  useEffect(() => {
    setFilter(isHandoverScope ? 'archive' : 'active');
    setDateScope('all');
    setQuery('');
  }, [isHandoverScope]);

  useEffect(() => {
    if (selectedRollId && rows[0] && !allRows.some((row) => row.id === selectedRollId)) {
      onSelectRoll(rows[0].id, false);
    }
  }, [allRows, onSelectRoll, rows, selectedRollId]);

  function toggleSort(key: OperatorRollHubSortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  }

  function changeViewMode(nextMode: HubViewMode) {
    setViewMode(nextMode);
    if (nextMode === 'queue') setSort({ key: 'queue', direction: 'asc' });
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <section
      className={`surface operator-rolls-hub severity-info ${isHandoverScope ? 'is-handover-mode' : ''}`}
      aria-label={
        isHandoverScope ? 'Переданные на склад рулоны оператора' : 'Рулоны и заказы оператора'
      }
    >
      <header className="operator-rolls-hub-header">
        <div>
          <span className="eyebrow">Оператор</span>
          <h2 tabIndex={-1} data-dialog-focus-fallback>
            {isHandoverScope ? 'Переданы на склад' : 'Рулоны и заказы'}
          </h2>
        </div>
        <div className="operator-rolls-hub-counts" aria-label="Сводка рулонов">
          {isHandoverScope ? (
            <>
              <span>
                <b>{archiveCount}</b>передано
              </span>
              <span>
                <b>{receivedCount}</b>принято
              </span>
              <span>
                <b>{dateRows.length}</b>по дате
              </span>
              <span>
                <b>{rows.length}</b>найдено
              </span>
            </>
          ) : (
            <>
              <span>
                <b>{activeCount}</b>активные
              </span>
              <span>
                <b>{actionCount}</b>в работе
              </span>
              <span>
                <b>{defectCount}</b>брак
              </span>
              <span>
                <b>{archiveCount}</b>закрыто
              </span>
            </>
          )}
        </div>
      </header>

      <div className="operator-rolls-hub-toolbar" aria-label="Фильтры рулонов">
        <div className="operator-rolls-hub-filter-stack">
          {!isHandoverScope && (
            <>
              <div
                className="operator-rolls-hub-view-toggle"
                role="radiogroup"
                aria-label="Вид списка рулонов"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={viewMode === 'orders'}
                  className={viewMode === 'orders' ? 'is-active' : ''}
                  onClick={() => changeViewMode('orders')}
                >
                  По заказам
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={viewMode === 'queue'}
                  className={viewMode === 'queue' ? 'is-active' : ''}
                  onClick={() => changeViewMode('queue')}
                >
                  По очереди
                </button>
              </div>
              <div
                className="operator-rolls-hub-filters"
                role="radiogroup"
                aria-label="Показать рулоны"
              >
                {hubFilters.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={filter === item.id}
                    className={filter === item.id ? 'is-active' : ''}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="operator-rolls-hub-tools">
          <DateScopeDropdown
            items={scopedRows}
            rangeSelection
            scope={dateScope}
            onChange={setDateScope}
          />
          <label className="operator-rolls-hub-search">
            <span>Поиск</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="рулон, заказ, станок"
            />
          </label>
        </div>
      </div>

      {rows.length === 0 ? (
        <IxEmptyState
          header={filter === 'defect' ? 'Брака нет' : 'Рулоны не найдены'}
          subHeader={
            filter === 'defect'
              ? 'У текущего оператора нет бракованных рулонов.'
              : 'Измените дату, фильтр или поиск.'
          }
        />
      ) : (
        <div
          className="operator-rolls-hub-table"
          role="table"
          aria-label="Единая таблица рулонов оператора"
        >
          <div className="operator-rolls-hub-row is-head" role="row">
            {displayedColumns.map((column) => (
              <span
                key={column.key}
                role="columnheader"
                data-column={column.dataColumn}
                aria-sort={sortAria(sort.key === column.key, sort.direction)}
              >
                <button
                  type="button"
                  className={sort.key === column.key ? 'is-active' : ''}
                  onClick={() => toggleSort(column.key)}
                  aria-label={`Сортировать рулоны: ${column.label}`}
                >
                  <span>{column.label}</span>
                  <small aria-hidden="true">
                    {sort.key === column.key ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
                  </small>
                </button>
              </span>
            ))}
          </div>

          {viewMode === 'queue'
            ? rows.map((row) => (
                <RollRow
                  key={row.id}
                  row={row}
                  selected={selectedRollId === row.id}
                  onSelect={onSelectRoll}
                />
              ))
            : groups.map((group) => {
                const expanded = !collapsedGroups.has(group.id);
                return (
                  <div
                    key={group.id}
                    id={`operator-order-group-${group.id}`}
                    className="operator-rolls-hub-group"
                  >
                    <OrderGroupBand group={group} expanded={expanded} onToggle={toggleGroup} />
                    {expanded &&
                      group.rows.map((row) => (
                        <RollRow
                          key={row.id}
                          row={row}
                          selected={selectedRollId === row.id}
                          onSelect={onSelectRoll}
                        />
                      ))}
                  </div>
                );
              })}
        </div>
      )}
    </section>
  );
}
