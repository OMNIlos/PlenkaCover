import type { ReactElement } from 'react';

import type { ServerDirectorAnalyticsBigBagEvidence } from '../../../api/director';
import {
  emptyBigBagEvidenceFilterDraft,
  type DirectorBigBagEvidenceFilterDraft,
} from '../../../domain/runtime/directorEvidenceFilters';
import {
  DirectorEvidenceTableToolbar,
  type DirectorEvidenceFilterField,
  type DirectorEvidenceFilterGroup,
  type EvidenceTableControl,
} from './DirectorEvidenceTableToolbar';
import {
  formatKg,
  formatRubles,
  formatRublesPerKg,
  formatTimestamp,
} from './directorAnalyticsFormatters';

type DirectorBigBagFactsBaseProps = {
  bags: ServerDirectorAnalyticsBigBagEvidence[];
  pageNumber: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

type DirectorBigBagFactsProps = DirectorBigBagFactsBaseProps &
  EvidenceTableControl<DirectorBigBagEvidenceFilterDraft>;

type DirectorBigBagFactsImplementationProps = DirectorBigBagFactsBaseProps &
  Partial<EvidenceTableControl<DirectorBigBagEvidenceFilterDraft>>;

type BigBagFilterKey = keyof DirectorBigBagEvidenceFilterDraft;

function bigBagTextField(
  key: BigBagFilterKey,
  label: string,
): DirectorEvidenceFilterField<BigBagFilterKey> {
  return { key, label, kind: 'text' };
}

function bigBagDateField(
  key: BigBagFilterKey,
  label: string,
): DirectorEvidenceFilterField<BigBagFilterKey> {
  return { key, label, kind: 'date' };
}

function bigBagWeightField(
  key: BigBagFilterKey,
  label: string,
): DirectorEvidenceFilterField<BigBagFilterKey> {
  return { key, label, kind: 'number', min: 0, step: 0.001 };
}

function bigBagCountField(
  key: BigBagFilterKey,
  label: string,
): DirectorEvidenceFilterField<BigBagFilterKey> {
  return { key, label, kind: 'number', min: 0, step: 1 };
}

function bigBagSignedField(
  key: BigBagFilterKey,
  label: string,
): DirectorEvidenceFilterField<BigBagFilterKey> {
  return { key, label, kind: 'number', step: 0.001 };
}

const bigBagGroups = [
  {
    id: 'big-bag-material',
    label: 'Big-Bag / материал',
    fields: [
      bigBagTextField('bigBagQuery', 'BigBag'),
      bigBagTextField('materialQuery', 'Материал'),
      {
        key: 'bigBagStatus',
        label: 'Статус BigBag',
        kind: 'select',
        options: [
          { value: '', label: 'Все статусы BigBag' },
          { value: 'available', label: 'Доступен' },
          { value: 'in_use', label: 'В работе' },
          { value: 'consumed', label: 'Израсходован' },
        ],
      },
    ],
  },
  {
    id: 'shift-actor',
    label: 'Смена / исполнитель',
    fields: [
      bigBagTextField('shiftQuery', 'Смена'),
      bigBagTextField('operatorQuery', 'Оператор'),
      bigBagTextField('postQuery', 'Пост'),
      bigBagDateField('openedFrom', 'Открыт, от'),
      bigBagDateField('openedTo', 'Открыт, до'),
      bigBagDateField('closedFrom', 'Закрыт, от'),
      bigBagDateField('closedTo', 'Закрыт, до'),
      {
        key: 'usageState',
        label: 'Состояние использования',
        kind: 'select',
        options: [
          { value: '', label: 'Любое состояние' },
          { value: 'open', label: 'Открыто' },
          { value: 'closed', label: 'Закрыто' },
        ],
      },
    ],
  },
  {
    id: 'start-end-current',
    label: 'Начало / конец / текущий',
    fields: [
      bigBagWeightField('startKgMin', 'Вес начала, от'),
      bigBagWeightField('startKgMax', 'Вес начала, до'),
      bigBagWeightField('endKgMin', 'Вес конца, от'),
      bigBagWeightField('endKgMax', 'Вес конца, до'),
      bigBagWeightField('currentKgMin', 'Текущий вес, от'),
      bigBagWeightField('currentKgMax', 'Текущий вес, до'),
    ],
  },
  {
    id: 'bag-shift-usage',
    label: 'Big-Bag расход / план смены',
    fields: [
      bigBagWeightField('bagUsageKgMin', 'Расход BigBag, от'),
      bigBagWeightField('bagUsageKgMax', 'Расход BigBag, до'),
      bigBagWeightField('actualUsageKgMin', 'Фактический расход смены, от'),
      bigBagWeightField('actualUsageKgMax', 'Фактический расход смены, до'),
      bigBagWeightField('expectedUsageKgMin', 'Плановый расход смены, от'),
      bigBagWeightField('expectedUsageKgMax', 'Плановый расход смены, до'),
    ],
  },
  {
    id: 'production',
    label: 'Выпуск',
    fields: [
      bigBagWeightField('producedKgMin', 'Выпуск, кг от'),
      bigBagWeightField('producedKgMax', 'Выпуск, кг до'),
      bigBagCountField('rollCountMin', 'Рулоны, от'),
      bigBagCountField('rollCountMax', 'Рулоны, до'),
    ],
  },
  {
    id: 'defects',
    label: 'Брак',
    fields: [
      bigBagWeightField('defectKgMin', 'Брак, кг от'),
      bigBagWeightField('defectKgMax', 'Брак, кг до'),
      bigBagCountField('defectCountMin', 'Брак, шт. от'),
      bigBagCountField('defectCountMax', 'Брак, шт. до'),
      bigBagCountField('unverifiedDefectCountMin', 'Без стабильного веса, от'),
      bigBagCountField('unverifiedDefectCountMax', 'Без стабильного веса, до'),
    ],
  },
  {
    id: 'deviation-status',
    label: 'Отклонение / статус',
    fields: [
      bigBagSignedField('deviationKgMin', 'Отклонение, кг от'),
      bigBagSignedField('deviationKgMax', 'Отклонение, кг до'),
      bigBagSignedField('deviationPercentMin', 'Отклонение, % от'),
      bigBagSignedField('deviationPercentMax', 'Отклонение, % до'),
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
      bigBagDateField('latestEvidenceFrom', 'Последнее подтверждение, от'),
      bigBagDateField('latestEvidenceTo', 'Последнее подтверждение, до'),
    ],
  },
] satisfies ReadonlyArray<DirectorEvidenceFilterGroup<BigBagFilterKey>>;

function factKg(value: number | null): string {
  return value === null ? 'Нет данных' : formatKg(value);
}

function signedKg(value: number | null): string {
  if (value === null) return 'Нет данных';
  return `${value > 0 ? '+' : ''}${formatKg(value)}`;
}

export function DirectorBigBagFacts(props: DirectorBigBagFactsBaseProps): ReactElement;
export function DirectorBigBagFacts(props: DirectorBigBagFactsProps): ReactElement;
export function DirectorBigBagFacts({
  bags,
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
}: DirectorBigBagFactsImplementationProps): ReactElement {
  const filters = controlledFilters ?? emptyBigBagEvidenceFilterDraft;
  const hasActiveFilters = Object.values(filters).some((value) => value.trim().length > 0);

  return (
    <section className="director-analytics-panel is-wide" aria-label="Факты BigBag">
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
            ? `Факты BigBag · Показано: ${bags.length}`
            : `Факты BigBag (${bags.length} на странице)`}
        </summary>
        {controlledFilters ? (
          <DirectorEvidenceTableToolbar
            tableId="big-bag"
            search={filters.q}
            groups={bigBagGroups}
            values={filters}
            errors={errors}
            onSearchChange={(value) => onFilterChange?.('q', value)}
            onValueChange={(key, value) => onFilterChange?.(key, value)}
            onReset={() => onResetFilters?.()}
          />
        ) : null}
        <p>Показан расчёт остатка и отклонения отдельно для каждого BigBag.</p>
        <div className="director-analytics-table-scroll">
          <table className="director-analytics-table is-big-bag-evidence">
            <caption>Неизменяемые факты BigBag</caption>
            <thead>
              <tr>
                <th scope="col">BigBag / материал</th>
                <th scope="col">Начальный вес</th>
                <th scope="col">Фактический остаток</th>
                <th scope="col">Расчётный расход</th>
                <th scope="col">Расчётный остаток</th>
                <th scope="col">Отклонение, кг</th>
                <th scope="col">Эквивалент, ₽</th>
              </tr>
            </thead>
            <tbody>
              {bags.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {!controlledFilters
                      ? 'По выбранным фильтрам фактов BigBag нет.'
                      : hasActiveFilters
                        ? 'По выбранным фильтрам фактов BigBag нет.'
                        : 'За выбранный период фактов BigBag нет.'}
                  </td>
                </tr>
              ) : (
                bags.map((bag) => {
                  const hasCalculation = bag.deviationKg !== null;
                  return (
                    <tr key={bag.id}>
                      <th scope="row">
                        <strong>{bag.bigBagCode}</strong>
                        <small>{bag.material}</small>
                      </th>
                      <td>{factKg(bag.startKg)}</td>
                      <td>
                        {factKg(bag.currentKg)}
                        <small>Замер: {formatTimestamp(bag.currentMeasuredAt)}</small>
                      </td>
                      <td>
                        {hasCalculation ? factKg(bag.expectedUsageKg) : 'Нет данных'}
                        <small>
                          Рулоны: {hasCalculation ? factKg(bag.producedKg) : 'Нет данных'} · брак:{' '}
                          {hasCalculation ? factKg(bag.defectKg) : 'Нет данных'}
                        </small>
                      </td>
                      <td>{factKg(bag.calculatedRemainderKg)}</td>
                      <td>{signedKg(bag.deviationKg)}</td>
                      <td>
                        {formatRubles(bag.totalKopecks)}
                        <small>Цена склада: {formatRublesPerKg(bag.priceKopecksPerKg)}</small>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <nav className="director-analytics-pagination" aria-label="Страницы фактов BigBag">
          <button
            type="button"
            aria-label={
              hasPrevious ? 'Предыдущая страница фактов BigBag' : 'Предыдущих страниц нет'
            }
            title={hasPrevious ? undefined : 'Предыдущих страниц нет'}
            disabled={!hasPrevious}
            onClick={onPrevious}
          >
            Предыдущая
          </button>
          <span>Стр. {pageNumber}</span>
          <button
            type="button"
            aria-label={hasNext ? 'Следующая страница фактов BigBag' : 'Следующих страниц нет'}
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
