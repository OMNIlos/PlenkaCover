import { useMemo } from 'react';

import type { PenaltySnapshotFilters, PenaltySnapshotRuntime } from '../../api/penalties';
import { penaltyStatusLabel } from '../../domain/runtime/penaltyView';

type EmployeeOption = {
  id: string;
  name: string;
  role: string;
};

function moneyLabel(kopecks: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(kopecks / 100)} ₽`;
}

function filterEmployees(
  snapshot: PenaltySnapshotRuntime,
  selectedEmployeeId?: string,
): EmployeeOption[] {
  const employees = new Map<string, EmployeeOption>();
  for (const penalty of snapshot.items) {
    if (!penalty.employeeId) continue;
    employees.set(penalty.employeeId, {
      id: penalty.employeeId,
      name:
        penalty.employeeName === 'Сотрудник не найден'
          ? `Сотрудник не найден (${penalty.employeeId})`
          : penalty.employeeName,
      role: penalty.employeeRole,
    });
  }
  if (selectedEmployeeId && !employees.has(selectedEmployeeId)) {
    employees.set(selectedEmployeeId, {
      id: selectedEmployeeId,
      name: `Сотрудник не найден (${selectedEmployeeId})`,
      role: 'Роль не указана',
    });
  }
  return [...employees.values()];
}

export function SharedPenaltySnapshot({
  snapshot,
  filters,
  selectedPenaltyId,
  onFiltersChange,
  onSelectPenalty,
}: {
  snapshot: PenaltySnapshotRuntime;
  filters: PenaltySnapshotFilters;
  selectedPenaltyId?: string | null;
  onFiltersChange: (filters: PenaltySnapshotFilters) => void | Promise<unknown>;
  onSelectPenalty: (penaltyId: string) => void;
}) {
  const employees = useMemo(
    () => filterEmployees(snapshot, filters.employeeId),
    [filters.employeeId, snapshot],
  );

  function changeFilter(next: PenaltySnapshotFilters) {
    void onFiltersChange(next);
  }

  return (
    <section className="penalty-page-body" aria-label="Журнал штрафов">
      <div className="penalty-summary-grid" aria-label="Сводка штрафов">
        <div className="penalty-metric-tile">
          <span>Всего</span>
          <strong>{snapshot.summary.totalCount}</strong>
        </div>
        <div className="penalty-metric-tile">
          <span>Сумма</span>
          <strong>{moneyLabel(snapshot.summary.totalAmountKopecks)}</strong>
        </div>
        <div className="penalty-metric-tile">
          <span>Топ причина</span>
          <strong>{snapshot.summary.topReason ?? 'нет'}</strong>
        </div>
      </div>

      <div className="penalty-filters" aria-label="Фильтры штрафов">
        <label>
          <span>Роль</span>
          <select
            value={filters.targetRole ?? ''}
            onChange={(event) =>
              changeFilter({
                ...filters,
                targetRole: (event.currentTarget.value || undefined) as
                  | PenaltySnapshotFilters['targetRole']
                  | undefined,
              })
            }
          >
            <option value="">Все роли</option>
            <option value="operator">Оператор</option>
            <option value="production_lead">Зав. производства</option>
          </select>
        </label>
        <label>
          <span>Статус</span>
          <select
            value={filters.status ?? ''}
            onChange={(event) =>
              changeFilter({
                ...filters,
                status: (event.currentTarget.value || undefined) as
                  | PenaltySnapshotFilters['status']
                  | undefined,
              })
            }
          >
            <option value="">Все статусы</option>
            <option value="issued">Назначен</option>
            <option value="disputed">На проверке</option>
            <option value="cancelled">Отменен</option>
          </select>
        </label>
        <label>
          <span>Сотрудник</span>
          <select
            value={filters.employeeId ?? ''}
            onChange={(event) =>
              changeFilter({ ...filters, employeeId: event.currentTarget.value || undefined })
            }
          >
            <option value="">Все сотрудники</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name} · {employee.role}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="director-table-header compact">
        <div>
          <span className="eyebrow">Журнал</span>
          <h2>Журнал штрафов</h2>
        </div>
        <span className="panel-count-label" aria-label={`В журнале ${snapshot.summary.totalCount}`}>
          {snapshot.summary.totalCount}
        </span>
      </div>

      {snapshot.items.length === 0 ? (
        <p className="penalty-empty-state">Штрафов нет</p>
      ) : (
        <div
          className="director-table-wrap"
          role="region"
          aria-label="Прокручиваемый журнал штрафов"
          tabIndex={0}
        >
          <table className="director-table">
            <thead>
              <tr>
                <th>Штраф</th>
                <th>Сотрудник</th>
                <th>Роль</th>
                <th>Сумма</th>
                <th>Статус</th>
                <th>Причина</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.items.map((penalty) => (
                <tr
                  key={penalty.penaltyId}
                  data-penalty-row
                  className={selectedPenaltyId === penalty.penaltyId ? 'is-selected' : undefined}
                  onClick={() => onSelectPenalty(penalty.penaltyId)}
                >
                  <td data-label="Штраф">
                    <button type="button">{penalty.penaltyId}</button>
                  </td>
                  <td data-label="Сотрудник">{penalty.employeeName}</td>
                  <td data-label="Роль">{penalty.employeeRole}</td>
                  <td data-label="Сумма">{penalty.amountLabel}</td>
                  <td data-label="Статус">{penaltyStatusLabel(penalty.status)}</td>
                  <td data-label="Причина">{penalty.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
