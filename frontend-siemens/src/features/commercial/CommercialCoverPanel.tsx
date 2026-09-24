import { useState } from 'react';
import {
  coverageReasonLabel,
  type CommercialWarehouseCoverageEnvelopeView,
  type WarehouseCoverageTypeProjectionView,
} from '../../domain/warehouseCoverage';
import type {
  CommercialOrderPositionContract,
  WarehouseCoverProposalContract,
  WarehouseCoverRouteContract,
} from './contracts';

export type CommercialCoverAction = WarehouseCoverRouteContract | 'recheck';
export type CommercialCoverMutationStatus = 'idle' | 'submitting' | 'success' | 'error';

const CRITERION_LABELS: Record<keyof WarehouseCoverProposalContract['matches'][number]['criteria'], string> = {
  filmType: 'Тип плёнки',
  actualThickness: 'Фактическая толщина',
  birka: 'Бирка',
  spoolType: 'Шпуля',
  weight: 'Вес',
};

export function availableCoverActions(
  position: CommercialOrderPositionContract,
  proposal: WarehouseCoverProposalContract,
): CommercialCoverAction[] {
  if (proposal.commercialApproved || proposal.technicalApproved) return [];
  if (proposal.stale || proposal.status === 'recheck_requested') return ['recheck'];

  const compatibleQty = proposal.matches.filter((match) => match.compatible).length;
  if (compatibleQty === position.rollCount && compatibleQty > 0) {
    return ['full_cover', 'production_only', 'recheck'];
  }
  if (compatibleQty > 0 && compatibleQty < position.rollCount) {
    return ['partial_cover', 'production_only', 'recheck'];
  }
  return ['production_only', 'recheck'];
}

type LegacyCommercialCoverPanelProps = {
  warehouseCoverageWorkflowVersion?: 1;
  position: CommercialOrderPositionContract;
  proposal: WarehouseCoverProposalContract;
  status: CommercialCoverMutationStatus;
  error: string | null;
  onApprove: (route: WarehouseCoverRouteContract) => void;
  onRecheck: (reason: string) => void;
  onRetry: () => void;
};

type V2CommercialCoverPanelProps = {
  warehouseCoverageWorkflowVersion: 2;
  coverage: CommercialWarehouseCoverageEnvelopeView;
};

export type CommercialCoverPanelProps =
  | LegacyCommercialCoverPanelProps
  | V2CommercialCoverPanelProps;

export function CommercialCoverPanel(props: CommercialCoverPanelProps) {
  if (props.warehouseCoverageWorkflowVersion === 2) {
    return <CommercialCoverageSummary coverage={props.coverage} />;
  }

  return <LegacyCommercialCoverDecision {...props} />;
}

function LegacyCommercialCoverDecision({
  position,
  proposal,
  status,
  error,
  onApprove,
  onRecheck,
  onRetry,
}: LegacyCommercialCoverPanelProps) {
  const actions = availableCoverActions(position, proposal);
  const busy = status === 'submitting';
  const compatibleQty = proposal.matches.filter((match) => match.compatible).length;
  const [recheckReason, setRecheckReason] = useState('');
  const matchCards = proposal.matches.map((match) => (
    <article key={match.rollId} role="listitem">
      <strong>{match.rollCode}</strong>
      <span>{match.compatible ? 'Совместим' : 'Требует перепроверки'}</span>
      <dl>
        {Object.entries(match.criteria).map(([key, criterion]) => (
          <div key={key}>
            <dt>{CRITERION_LABELS[key as keyof typeof CRITERION_LABELS]}</dt>
            <dd>
              {criterion.matches ? 'Совпадает' : 'Не совпадает'}: {factLabel(criterion.actual)}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  ));

  return (
    <section className="commercial-cover-panel" aria-label="Покрытие склада" aria-busy={busy}>
      <header>
        <div>
          <span className="eyebrow">Предложение склада</span>
          <h4>
            {compatibleQty} из {position.rollCount} рул.
          </h4>
        </div>
        <span>{proposal.stale ? 'Данные устарели' : `Версия ${proposal.version}`}</span>
      </header>

      {error && (
        <div role="alert">
          <strong>{error}</strong>
          <button type="button" onClick={onRetry}>
            Обновить данные
          </button>
        </div>
      )}

      <dl className="commercial-cover-summary" aria-label="Маршрут позиции">
        <div>
          <dt>Заказано</dt>
          <dd>{position.rollCount} рул.</dd>
        </div>
        <div>
          <dt>Со склада предложено</dt>
          <dd>{proposal.coverQty} рул.</dd>
        </div>
        <div>
          <dt>В резерве</dt>
          <dd>{proposal.reserveQty} рул.</dd>
        </div>
        <div>
          <dt>Подтверждено</dt>
          <dd>
            {proposal.commercialApproved ? `${proposal.coverQty} рул.` : 'Ожидает решения'}
          </dd>
        </div>
        <div>
          <dt>В производство</dt>
          <dd>{proposal.productionQty} рул.</dd>
        </div>
      </dl>

      {!error && actions.length > 0 && (
        <div className="commercial-cover-actions">
          {actions.includes('full_cover') && (
            <button type="button" disabled={busy} onClick={() => onApprove('full_cover')}>
              Закрыть полностью со склада
            </button>
          )}
          {actions.includes('partial_cover') && (
            <button type="button" disabled={busy} onClick={() => onApprove('partial_cover')}>
              Принять резерв и произвести остаток
            </button>
          )}
          {actions.includes('production_only') && (
            <button type="button" disabled={busy} onClick={() => onApprove('production_only')}>
              Произвести всё
            </button>
          )}
          {actions.includes('recheck') && (
            <label>
              Причина перепроверки
              <textarea
                value={recheckReason}
                maxLength={1000}
                onChange={(event) => setRecheckReason(event.target.value)}
              />
              <button
                type="button"
                disabled={busy || !recheckReason.trim()}
                onClick={() => onRecheck(recheckReason.trim())}
              >
                Запросить перепроверку
              </button>
            </label>
          )}
        </div>
      )}

      {proposal.commercialApproved && (
        <p>
          Маршрут коммерции подтверждён: {routeLabel(proposal.route)}.
          {proposal.route === 'production_only'
            ? ' Техническое подтверждение не требуется.'
            : proposal.technicalApproved
              ? ' Техническое подтверждение получено.'
              : ' Ожидается зав. производства.'}
        </p>
      )}

      <details className="commercial-cover-evidence">
        <summary>Совместимость и факты · {proposal.matches.length}</summary>
        {proposal.matches.length === 0 ? (
          <p>Совместимые складские рулоны не найдены.</p>
        ) : (
          <div className="commercial-cover-matches" role="list">
            {matchCards}
          </div>
        )}
      </details>
    </section>
  );
}

function CommercialCoverageSummary({
  coverage,
}: {
  coverage: CommercialWarehouseCoverageEnvelopeView;
}) {
  const canCorrectOrderSpec =
    coverage.nextOwner === 'commercial' &&
    coverage.availableActions.includes('correct_order_spec');
  const typeCoverage =
    !coverage.stale &&
    coverage.state !== 'calculating' &&
    coverage.state !== 'stale' &&
    coverage.availability === 'verified_full'
      ? (coverage.typeCoverage ?? [])
      : [];
  const calculatedAt = coverage.calculatedAt
    ? new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(coverage.calculatedAt))
    : 'ещё не рассчитано';

  return (
    <section
      className="commercial-cover-panel commercial-cover-panel-v2"
      aria-label="Покрытие склада"
    >
      <header>
        <div>
          <span className="eyebrow">Покрытие склада · автоматически</span>
          <h4>
            {coverage.matchedRollCount} из {coverage.requiredRollCount} рулонов
          </h4>
          <p className="commercial-cover-state">{coverageStateLabel(coverage.state)}</p>
        </div>
        <span>{coverage.stale ? 'Расчёт устарел' : `Расчёт №${coverage.generation ?? '—'}`}</span>
      </header>

      <dl className="commercial-cover-summary" aria-label="Итог автоматической проверки">
        <div>
          <dt>Требуют уточнения</dt>
          <dd>{coverage.uncertainRollCount} рул.</dd>
        </div>
        <div>
          <dt>Проверено</dt>
          <dd>{calculatedAt}</dd>
        </div>
      </dl>

      {typeCoverage.length > 0 && coverage.matchedRollCount > 0 && (
        <section className="commercial-coverage-by-type" aria-label="Покрытие по позициям">
          <div className="commercial-coverage-type-list" role="list">
            {typeCoverage.map((item) => (
              <CoverageTypeCard key={item.positionId} item={item} />
            ))}
          </div>
        </section>
      )}

      <details className="commercial-cover-route-evidence">
        <summary>Почему такой маршрут</summary>
        {coverage.reasonCodes.length > 0 ? (
          <ul className="commercial-cover-reasons" aria-label="Причины состояния">
            {coverage.reasonCodes.map((reason) => (
              <li key={reason}>{coverageReasonLabel(reason)}</li>
            ))}
          </ul>
        ) : (
          <p>Расчёт завершён без предупреждений.</p>
        )}
      </details>

      {canCorrectOrderSpec && (
        <a className="commercial-cover-remediation" href="#commercial-order-positions">
          Исправить спецификацию заказа
        </a>
      )}
    </section>
  );
}

function CoverageTypeCard({ item }: { item: WarehouseCoverageTypeProjectionView }) {
  const tokens = [
    item.requested.filmType,
    formatUnit(item.requested.actualThicknessMicron, 'мкм'),
    formatUnit(item.requested.widthMm, 'мм'),
  ].filter((token): token is string => Boolean(token));

  return (
    <article
      className="commercial-coverage-type"
      data-testid="warehouse-coverage-type"
      role="listitem"
    >
      <header>
        <div>
          <h5>{item.label}</h5>
          <p>
            Можно покрыть {item.matchedRollCount} из {item.requiredRollCount}
          </p>
        </div>
        {tokens.length > 0 && (
          <ul className="commercial-coverage-type-tokens" aria-label="Параметры заказа">
            {tokens.map((token) => (
              <li key={token}>{token}</li>
            ))}
          </ul>
        )}
      </header>

      <details className="commercial-coverage-type-details">
        <summary>Заказ / Резерв</summary>
        <dl className="commercial-coverage-comparison">
          {coverageComparisonRows(item).map((row) => (
            <div
              key={row.label}
              className={row.matches ? 'is-match' : 'is-different'}
            >
              <dt>{row.label}</dt>
              <dd>
                <span>Заказ</span>
                <strong>{row.requested}</strong>
              </dd>
              <dd>
                <span>Резерв</span>
                <strong>{row.matched}</strong>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </article>
  );
}

function coverageComparisonRows(item: WarehouseCoverageTypeProjectionView) {
  return [
    {
      label: 'Тип плёнки',
      requested: formatText(item.requested.filmType),
      matched: formatText(item.matched.filmType),
      matches: item.comparison.filmType,
    },
    {
      label: 'Фактическая толщина',
      requested: formatValue(item.requested.actualThicknessMicron, 'мкм'),
      matched: formatValue(item.matched.actualThicknessMicron, 'мкм'),
      matches: item.comparison.actualThickness,
    },
    {
      label: 'Учётная толщина',
      requested: formatValue(item.requested.accountingThicknessMicron, 'мкм'),
      matched: formatValue(item.matched.accountingThicknessMicron, 'мкм'),
      matches: item.comparison.accountingThickness,
    },
    {
      label: 'Ширина',
      requested: formatValue(item.requested.widthMm, 'мм'),
      matched: formatValue(item.matched.widthMm, 'мм'),
      matches: item.comparison.width,
    },
    {
      label: 'Плановая длина',
      requested: formatValue(item.requested.plannedLengthM, 'м'),
      matched: formatValue(item.matched.plannedLengthM, 'м'),
      matches: item.comparison.plannedLength,
    },
    {
      label: 'Вес рулона',
      requested: formatValue(item.requested.weightKg, 'кг'),
      matched: formatMatchedWeight(item.matched.weightKg),
      matches: item.comparison.weightTolerance,
    },
    {
      label: 'Шпуля',
      requested: formatText(item.requested.spoolType),
      matched: formatText(item.matched.spoolType),
      matches: item.comparison.spoolType,
    },
    {
      label: 'Бирка',
      requested: formatText(item.requested.birka),
      matched: formatText(item.matched.birka),
      matches: item.comparison.birka,
    },
    {
      label: 'Состав',
      requested: formatComposition(item.requested.recipeName, item.requested.ingredients),
      matched: formatComposition(item.matched.recipeName, item.matched.ingredients),
      matches: item.comparison.ingredients,
    },
  ];
}

const COVERAGE_NUMBER_FORMAT = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
});

function formatUnit(value: number | null, unit: string) {
  return value === null ? null : `${COVERAGE_NUMBER_FORMAT.format(value)} ${unit}`;
}

function formatValue(value: number | null, unit: string) {
  return formatUnit(value, unit) ?? 'Не указано';
}

function formatText(value: string | null) {
  return value ?? 'Не указано';
}

function formatMatchedWeight(
  weight: WarehouseCoverageTypeProjectionView['matched']['weightKg'],
) {
  if (!weight) return 'Не указано';
  const range =
    weight.min === weight.max
      ? COVERAGE_NUMBER_FORMAT.format(weight.min)
      : `${COVERAGE_NUMBER_FORMAT.format(weight.min)}–${COVERAGE_NUMBER_FORMAT.format(weight.max)}`;
  return `${range} кг · всего ${COVERAGE_NUMBER_FORMAT.format(weight.total)} кг`;
}

function formatComposition(
  recipeName: string | null,
  ingredients: WarehouseCoverageTypeProjectionView['requested']['ingredients'],
) {
  const ingredientSummary = ingredients
    .map(
      ({ name, shareBasisPoints }) =>
        `${name} · ${COVERAGE_NUMBER_FORMAT.format(shareBasisPoints / 100)}%`,
    )
    .join(', ');
  return [recipeName, ingredientSummary].filter(Boolean).join(' · ') || 'Не указано';
}

function coverageStateLabel(
  state: CommercialWarehouseCoverageEnvelopeView['state'],
) {
  switch (state) {
    case 'calculating':
      return 'Проверка выполняется';
    case 'awaiting_finance':
      return 'Доступность рассчитана';
    case 'production_required':
      return 'Требуется производство';
    case 'unknown':
      return 'Нужно уточнить данные';
    case 'recheck_requested':
      return 'Склад перепроверяет';
    case 'warehouse_reserved':
      return 'Рулоны зарезервированы';
    case 'stale':
      return 'Нужно обновить расчёт';
  }
}

function routeLabel(route: WarehouseCoverRouteContract) {
  if (route === 'full_cover') return 'полное покрытие';
  if (route === 'partial_cover') return 'частичное покрытие';
  return 'только производство';
}

function factLabel(value: string | number | null) {
  return value === null ? 'факт отсутствует' : String(value);
}
