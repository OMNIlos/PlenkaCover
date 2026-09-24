import type { ReactElement } from 'react';

import type {
  ServerDirectorAnalyticsShiftBalanceEvidence,
  ServerDirectorAnalyticsShiftPayroll,
} from '../../../api/director';
import {
  emptyShiftEvidenceFilterDraft,
  type DirectorShiftEvidenceFilterDraft,
} from '../../../domain/runtime/directorEvidenceFilters';
import {
  DirectorEvidenceTableToolbar,
  type DirectorEvidenceFilterField,
  type DirectorEvidenceFilterGroup,
  type EvidenceTableControl,
} from './DirectorEvidenceTableToolbar';
import {
  formatDate,
  formatKg,
  formatNumber,
  formatPayrollTariffRule,
  formatPayrollUnresolvedReasons,
  formatPercent,
  formatRubles,
  formatRublesPerKg,
  formatTimestamp,
} from './directorAnalyticsFormatters';

type DirectorShiftBalanceTableBaseProps = {
  balances: ServerDirectorAnalyticsShiftBalanceEvidence[];
  payrollBySessionId?: ReadonlyMap<string, ServerDirectorAnalyticsShiftPayroll>;
  pageNumber: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

type DirectorShiftBalanceTableProps = DirectorShiftBalanceTableBaseProps &
  EvidenceTableControl<DirectorShiftEvidenceFilterDraft>;

type DirectorShiftBalanceTableImplementationProps = DirectorShiftBalanceTableBaseProps &
  Partial<EvidenceTableControl<DirectorShiftEvidenceFilterDraft>>;

type ShiftFilterKey = keyof DirectorShiftEvidenceFilterDraft;

function shiftTextField(
  key: ShiftFilterKey,
  label: string,
): DirectorEvidenceFilterField<ShiftFilterKey> {
  return { key, label, kind: 'text' };
}

function shiftDateField(
  key: ShiftFilterKey,
  label: string,
): DirectorEvidenceFilterField<ShiftFilterKey> {
  return { key, label, kind: 'date' };
}

function shiftWeightField(
  key: ShiftFilterKey,
  label: string,
): DirectorEvidenceFilterField<ShiftFilterKey> {
  return { key, label, kind: 'number', min: 0, step: 0.001 };
}

function shiftCountField(
  key: ShiftFilterKey,
  label: string,
): DirectorEvidenceFilterField<ShiftFilterKey> {
  return { key, label, kind: 'number', min: 0, step: 1 };
}

function shiftSignedField(
  key: ShiftFilterKey,
  label: string,
): DirectorEvidenceFilterField<ShiftFilterKey> {
  return { key, label, kind: 'number', step: 0.001 };
}

const shiftGroups = [
  {
    id: 'shift-period',
    label: 'Смена / период',
    fields: [
      shiftTextField('shiftQuery', 'Смена'),
      shiftDateField('startedFrom', 'Начало смены, от'),
      shiftDateField('startedTo', 'Начало смены, до'),
      shiftDateField('endedFrom', 'Завершение смены, от'),
      shiftDateField('endedTo', 'Завершение смены, до'),
    ],
  },
  {
    id: 'operator-post',
    label: 'Оператор / пост',
    fields: [shiftTextField('operatorQuery', 'Оператор'), shiftTextField('postQuery', 'Пост')],
  },
  {
    id: 'start-remaining',
    label: 'Начало / остаток',
    fields: [
      shiftWeightField('startKgMin', 'Вес начала, от'),
      shiftWeightField('startKgMax', 'Вес начала, до'),
      shiftWeightField('remainingKgMin', 'Остаток, от'),
      shiftWeightField('remainingKgMax', 'Остаток, до'),
    ],
  },
  {
    id: 'actual-expected-usage',
    label: 'Расход факт / план',
    fields: [
      shiftWeightField('actualUsageKgMin', 'Фактический расход, от'),
      shiftWeightField('actualUsageKgMax', 'Фактический расход, до'),
      shiftWeightField('expectedUsageKgMin', 'Плановый расход, от'),
      shiftWeightField('expectedUsageKgMax', 'Плановый расход, до'),
    ],
  },
  {
    id: 'production-defects',
    label: 'Выпуск / брак',
    fields: [
      shiftWeightField('producedKgMin', 'Выпуск, кг от'),
      shiftWeightField('producedKgMax', 'Выпуск, кг до'),
      shiftCountField('rollCountMin', 'Рулоны, от'),
      shiftCountField('rollCountMax', 'Рулоны, до'),
      shiftWeightField('defectKgMin', 'Брак, кг от'),
      shiftWeightField('defectKgMax', 'Брак, кг до'),
      shiftCountField('defectCountMin', 'Брак, шт. от'),
      shiftCountField('defectCountMax', 'Брак, шт. до'),
      shiftCountField('unverifiedDefectCountMin', 'Без стабильного веса, от'),
      shiftCountField('unverifiedDefectCountMax', 'Без стабильного веса, до'),
    ],
  },
  {
    id: 'deviation',
    label: 'Отклонение',
    fields: [
      shiftSignedField('deviationKgMin', 'Отклонение, кг от'),
      shiftSignedField('deviationKgMax', 'Отклонение, кг до'),
      shiftSignedField('deviationPercentMin', 'Отклонение, % от'),
      shiftSignedField('deviationPercentMax', 'Отклонение, % до'),
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
          { value: 'pending', label: 'Ожидает фактов' },
          { value: 'ok', label: 'В норме' },
          { value: 'mismatch', label: 'Расхождение' },
        ],
      },
    ],
  },
  {
    id: 'source-freshness',
    label: 'Источник / свежесть',
    fields: [
      {
        key: 'freshness',
        label: 'Свежесть данных',
        kind: 'select',
        options: [
          { value: '', label: 'Любая свежесть' },
          { value: 'fresh', label: 'Актуально' },
          { value: 'stale', label: 'Устарело' },
          { value: 'unknown', label: 'Неизвестно' },
        ],
      },
      shiftDateField('latestEvidenceFrom', 'Последнее подтверждение, от'),
      shiftDateField('latestEvidenceTo', 'Последнее подтверждение, до'),
    ],
  },
] satisfies ReadonlyArray<DirectorEvidenceFilterGroup<ShiftFilterKey>>;

export function DirectorShiftBalanceTable(props: DirectorShiftBalanceTableBaseProps): ReactElement;
export function DirectorShiftBalanceTable(props: DirectorShiftBalanceTableProps): ReactElement;
export function DirectorShiftBalanceTable({
  balances,
  payrollBySessionId,
  pageNumber,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  open,
  filters: controlledFilters,
  errors = {},
  updating = false,
  onOpenChange,
  onFilterChange,
  onResetFilters,
}: DirectorShiftBalanceTableImplementationProps): ReactElement {
  const filters = controlledFilters ?? emptyShiftEvidenceFilterDraft;
  const hasActiveFilters = Object.values(filters).some((value) => value.trim().length > 0);

  return (
    <section className="director-analytics-panel is-wide" aria-label="Баланс смен">
      <details
        className="director-analytics-evidence"
        open={controlledFilters ? open : undefined}
        aria-busy={controlledFilters ? updating : undefined}
        onToggle={
          controlledFilters
            ? (event) => {
                if (open === undefined || event.currentTarget.open === open) return;
                onOpenChange?.(event.currentTarget.open);
              }
            : undefined
        }
      >
        <summary>
          {controlledFilters
            ? `Баланс смен · Показано: ${balances.length}`
            : `Баланс смен (${balances.length} на странице)`}
        </summary>
        {controlledFilters ? (
          <DirectorEvidenceTableToolbar
            tableId="shift"
            search={filters.q}
            groups={shiftGroups}
            values={filters}
            errors={errors}
            onSearchChange={(value) => onFilterChange?.('q', value)}
            onValueChange={(key, value) => onFilterChange?.(key, value)}
            onReset={() => onResetFilters?.()}
          />
        ) : null}
        <div className="director-analytics-table-scroll">
          <table className="director-analytics-table is-shift-balance">
            <caption>Точный баланс смен</caption>
            <thead>
              <tr>
                <th scope="col">Смена / период</th>
                <th scope="col">Оператор / пост</th>
                <th scope="col">Начало / остаток</th>
                <th scope="col">Расход факт / план</th>
                <th scope="col">Выпуск / брак</th>
                <th scope="col">Отклонение</th>
                <th scope="col">Начисление, ₽</th>
              </tr>
            </thead>
            <tbody>
              {balances.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {!controlledFilters
                      ? 'По выбранным фильтрам смен не найдено.'
                      : hasActiveFilters
                        ? 'По выбранным фильтрам смен не найдено.'
                        : 'За выбранный период смен не найдено.'}
                  </td>
                </tr>
              ) : (
                balances.map((balance) => {
                  const payroll = payrollBySessionId?.get(balance.sessionId) ?? null;
                  return (
                    <tr key={balance.sessionId} className={`is-${balance.status}`}>
                      <th scope="row">
                        <strong>{balance.shiftLabel ?? balance.sessionId}</strong>
                        <small>Сессия {balance.sessionId}</small>
                        <small>
                          <time dateTime={balance.startedAt}>
                            {formatTimestamp(balance.startedAt)}
                          </time>
                          {' — '}
                          <time dateTime={balance.endedAt}>{formatTimestamp(balance.endedAt)}</time>
                        </small>
                        <small>
                          {balance.bigBags.length > 0
                            ? `BigBag ${balance.bigBags.map((bag) => bag.bigBagCode).join(', ')}`
                            : 'BigBag не связан'}
                        </small>
                      </th>
                      <td>
                        <strong>{balance.operatorName}</strong>
                        <small>
                          {balance.postCode} · {balance.postName}
                        </small>
                      </td>
                      <td>
                        {formatKg(balance.startKg)} / {formatKg(balance.endKg ?? balance.currentKg)}
                      </td>
                      <td>
                        {formatKg(balance.actualUsageKg)} / {formatKg(balance.expectedUsageKg)}
                      </td>
                      <td>
                        {formatKg(balance.producedKg)} / {formatKg(balance.defectKg)}
                        <small>
                          {formatNumber(balance.rollCount)} рул. ·{' '}
                          {formatNumber(balance.defectCount)} брак
                        </small>
                        {balance.unverifiedDefectCount > 0 ? (
                          <small>
                            Без стабильного веса: {formatNumber(balance.unverifiedDefectCount)}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {formatKg(balance.deviationKg)}
                        <small>{formatPercent(balance.deviationPercent)}</small>
                      </td>
                      <td>
                        {payroll?.status === 'resolved'
                          ? formatRubles(payroll.amountKopecks)
                          : '—'}
                        {payroll?.status === 'resolved' ? (
                          <>
                            <small>
                              {payroll.tariffRule === null
                                ? 'Несколько ставок'
                                : `${formatRublesPerKg(payroll.rateKopecksPerKg)} · ${formatPayrollTariffRule(payroll.tariffRule)}`}
                            </small>
                            <small>
                              {payroll.tariffOrder.name} · действует с{' '}
                              {formatDate(payroll.tariffOrder.effectiveFrom)}
                            </small>
                            <small style={{ whiteSpace: 'normal' }}>{payroll.basisLabel}</small>
                          </>
                        ) : (
                          <small>
                            {payroll
                              ? formatPayrollUnresolvedReasons(payroll)
                              : 'Расчёт зарплаты недоступен'}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <nav className="director-analytics-pagination" aria-label="Страницы баланса смен">
          <button
            type="button"
            aria-label={hasPrevious ? 'Предыдущая страница баланса смен' : 'Предыдущих страниц нет'}
            title={hasPrevious ? undefined : 'Предыдущих страниц нет'}
            disabled={!hasPrevious}
            onClick={onPrevious}
          >
            Предыдущая
          </button>
          <span>Стр. {pageNumber}</span>
          <button
            type="button"
            aria-label={hasNext ? 'Следующая страница баланса смен' : 'Следующих страниц нет'}
            title={hasNext ? undefined : 'Следующих страниц нет'}
            disabled={!hasNext}
            onClick={onNext}
          >
            Следующая
          </button>
        </nav>
      </details>
    </section>
  );
}
