import { useEffect, useRef, useState } from 'react';

import {
  fetchDirectorPayrollPreview,
  type ServerDirectorPayrollBreakdownRow,
  type ServerDirectorPayrollMachineFamily,
  type ServerDirectorPayrollPreview,
  type ServerDirectorPayrollUnresolvedReason,
} from '../../api/directorPayroll';
import type {
  ServerAppliedPayrollTariffOrder,
  ServerPayrollTariffAbcBand,
  ServerPayrollTariffLadderKey,
  ServerPayrollTariffOrderList,
  ServerPayrollTariffOrderView,
  ServerPayrollTariffUrpBand,
} from '../../api/payrollTariffOrders';
import { demoDirectorPayrollPreview } from '../../domain/fixtures/directorPayroll';
import { DirectorAnalyticsRequestGate } from '../../domain/runtime/directorAnalyticsView';
import {
  createDirectorPayrollRange,
  type DirectorPayrollPreset,
  type DirectorPayrollRange,
} from '../../domain/runtime/directorPayrollView';
import { PayrollTariffOrderDialog } from '../../features/director/payroll-tariffs/PayrollTariffOrderDialog';
import {
  livePayrollTariffOrdersApi,
  usePayrollTariffOrders,
  type PayrollTariffOrdersApi,
} from '../../features/director/payroll-tariffs/usePayrollTariffOrders';
import { SiemensIcon } from '../shell/SiemensIcon';

type PayrollLoadState =
  | { status: 'loading'; preview: ServerDirectorPayrollPreview | null; error: null }
  | { status: 'ready' | 'empty'; preview: ServerDirectorPayrollPreview; error: null }
  | { status: 'error'; preview: ServerDirectorPayrollPreview | null; error: string };

type RangeResolution = {
  range: DirectorPayrollRange | null;
  validation: string | null;
};

const rubles = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
});
const kilograms = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const moscowDateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const machineFamilyLabels: Record<ServerDirectorPayrollMachineFamily, string> = {
  urp: 'УРП',
  matil: 'Матиль',
  kitayka: 'Китайка',
  abc_old: 'АВС старая',
  abc_new: 'АВС новая',
};

const unresolvedReasonLabels: Record<ServerDirectorPayrollUnresolvedReason, string> = {
  before_policy_effective_date: 'До вступления приказа в силу',
  shift_not_closed: 'Смена не закрыта',
  production_operator_unresolved: 'Оператор не определён',
  post_session_unresolved: 'Сессия поста не определена',
  shift_unresolved: 'Смена не определена',
  machine_family_unresolved: 'Семейство станка не определено',
  shift_duration_unresolved: 'Длительность смены не определена',
  material_class_unresolved: 'Сырьё не определено как первичное или вторичное',
  film_type_unresolved: 'Тип плёнки не определён',
  counterparty_unresolved: 'Контрагент не определён',
};

const demoAppliedTariffOrder = demoDirectorPayrollPreview.appliedTariffOrders[0];

if (!demoAppliedTariffOrder) {
  throw new Error('Демонстрационный приказ по тарифам не настроен');
}

const demoPayrollTariffOrderView: ServerPayrollTariffOrderView = {
  ...demoAppliedTariffOrder,
  status: 'published',
  revision: 1,
  createdAt: '2025-09-29T00:00:00.000Z',
  updatedAt: '2025-09-29T00:00:00.000Z',
  publishedAt: '2025-09-29T00:00:00.000Z',
  createdById: null,
  updatedById: null,
  publishedById: null,
};

const demoPayrollTariffOrderList: ServerPayrollTariffOrderList = {
  items: [
    {
      id: demoPayrollTariffOrderView.id,
      name: demoPayrollTariffOrderView.name,
      effectiveFrom: demoPayrollTariffOrderView.effectiveFrom,
      currency: demoPayrollTariffOrderView.currency,
      status: demoPayrollTariffOrderView.status,
      revision: demoPayrollTariffOrderView.revision,
      createdAt: demoPayrollTariffOrderView.createdAt,
      updatedAt: demoPayrollTariffOrderView.updatedAt,
      publishedAt: demoPayrollTariffOrderView.publishedAt,
    },
  ],
  activeOrderId: demoPayrollTariffOrderView.id,
  latestPublishedOrderId: demoPayrollTariffOrderView.id,
  minimumPublishEffectiveFrom: '2026-08-14',
  timezone: 'Europe/Moscow',
  generatedAt: '2026-08-13T09:30:00.000Z',
};

async function demoMutationUnavailable(): Promise<never> {
  throw new Error('Изменение приказов недоступно в демонстрационном режиме');
}

const demoPayrollTariffOrdersApi: PayrollTariffOrdersApi = {
  list: async () => demoPayrollTariffOrderList,
  detail: async (id) => {
    if (id !== demoPayrollTariffOrderView.id) throw new Error('Приказ не найден');
    return demoPayrollTariffOrderView;
  },
  create: demoMutationUnavailable,
  update: demoMutationUnavailable,
  review: demoMutationUnavailable,
  publish: demoMutationUnavailable,
};

function isEmptyPreview(preview: ServerDirectorPayrollPreview): boolean {
  if (preview.status === 'empty') return true;
  const { summary } = preview;
  return (
    summary.payableAmountKopecks === 0 &&
    summary.payableKg === 0 &&
    summary.operatorCount === 0 &&
    summary.unresolvedFactCount === 0
  );
}

function readyPayrollState(preview: ServerDirectorPayrollPreview): PayrollLoadState {
  return {
    status: isEmptyPreview(preview) ? 'empty' : 'ready',
    preview,
    error: null,
  };
}

function resolvePayrollRange(
  preset: DirectorPayrollPreset,
  now: Date,
  customFrom: string,
  customTo: string,
): RangeResolution {
  if (preset !== 'custom') {
    return { range: createDirectorPayrollRange(preset, now), validation: null };
  }
  if (!customFrom || !customTo) {
    return { range: null, validation: 'Укажите обе даты периода' };
  }

  try {
    return {
      range: createDirectorPayrollRange('custom', now, {
        from: customFrom,
        to: customTo,
      }),
      validation: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('must not be after')) {
      return {
        range: null,
        validation: 'Дата начала должна быть не позже даты окончания',
      };
    }
    if (message.includes('366 days')) {
      return { range: null, validation: 'Период не должен превышать 366 дней' };
    }
    return { range: null, validation: 'Проверьте даты периода' };
  }
}

function formatKopecks(value: number): string {
  return rubles.format(value / 100);
}

function formatKilograms(value: number): string {
  return `${kilograms.format(value)} кг`;
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${formatKopecks(value)}/кг`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : moscowDateTime.format(date);
}

function machineLabel(row: ServerDirectorPayrollBreakdownRow): string {
  const family = machineFamilyLabels[row.machineFamily];
  return row.postName === family ? family : `${row.postName} · ${family}`;
}

function initialLoadState(useLiveData: boolean): PayrollLoadState {
  return useLiveData
    ? { status: 'loading', preview: null, error: null }
    : readyPayrollState(demoDirectorPayrollPreview);
}

export function DirectorPayrollSurface({
  useLiveData,
  refreshGeneration = 0,
}: {
  useLiveData: boolean;
  refreshGeneration?: string | number;
}) {
  const [calendarNow] = useState(() => new Date());
  const [preset, setPreset] = useState<DirectorPayrollPreset>('current_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [loadState, setLoadState] = useState<PayrollLoadState>(() => initialLoadState(useLiveData));
  const tariffOrders = usePayrollTariffOrders({
    api: useLiveData ? livePayrollTariffOrdersApi : demoPayrollTariffOrdersApi,
  });
  const requestGate = useRef(new DirectorAnalyticsRequestGate());
  const lastSuccessfulRange = useRef<string | null>(null);
  const rangeResolution = resolvePayrollRange(preset, calendarNow, customFrom, customTo);
  const requestFrom = rangeResolution.range?.from ?? null;
  const requestTo = rangeResolution.range?.to ?? null;

  useEffect(() => {
    const gate = requestGate.current;
    if (!useLiveData) {
      gate.invalidate();
      lastSuccessfulRange.current = null;
      setLoadState(readyPayrollState(demoDirectorPayrollPreview));
      return;
    }
    if (!requestFrom || !requestTo) {
      gate.invalidate();
      lastSuccessfulRange.current = null;
      setLoadState({ status: 'loading', preview: null, error: null });
      return;
    }

    const requestRange = `${requestFrom}:${requestTo}`;
    const generation = gate.begin();
    const controller = new AbortController();
    // Keep the previous figures on screen: dropping them made the tab blink on
    // every refresh instead of quietly replacing the numbers.
    setLoadState((current) => ({
      status: 'loading',
      preview: lastSuccessfulRange.current === requestRange ? current.preview : null,
      error: null,
    }));
    void fetchDirectorPayrollPreview(
      { from: requestFrom, to: requestTo },
      { signal: controller.signal },
    ).then(
      (preview) => {
        if (!gate.isCurrent(generation)) return;
        lastSuccessfulRange.current = requestRange;
        setLoadState(readyPayrollState(preview));
      },
      () => {
        if (!gate.isCurrent(generation)) return;
        setLoadState((current) => ({
          status: 'error',
          preview: lastSuccessfulRange.current === requestRange ? current.preview : null,
          error: 'Не удалось загрузить расчёт зарплаты',
        }));
      },
    );

    return () => {
      gate.invalidate(generation);
      controller.abort();
    };
  }, [refreshGeneration, requestFrom, requestTo, retryGeneration, useLiveData]);

  const selectPreset = (nextPreset: DirectorPayrollPreset) => {
    setPreset(nextPreset);
  };
  const retry = () => setRetryGeneration((current) => current + 1);

  return (
    <section className="director-payroll-surface" aria-label="Предварительный расчёт зарплаты">
      <header className="director-payroll-header">
        <div>
          <span className="eyebrow">Сдельный расчёт</span>
          <h2>Предварительный сдельный расчёт</h2>
        </div>
        <p className="director-payroll-boundary">
          {useLiveData ? 'По подтверждённой выработке' : 'Демонстрационный расчёт'} · предварительно
        </p>
      </header>

      <div className="director-payroll-toolbar" aria-label="Период расчёта зарплаты">
        <div className="director-payroll-presets" role="group" aria-label="Быстрый выбор периода">
          <PeriodButton
            active={preset === 'current_month'}
            label="Текущий месяц"
            onClick={() => selectPreset('current_month')}
          />
          <PeriodButton
            active={preset === 'previous_month'}
            label="Предыдущий месяц"
            onClick={() => selectPreset('previous_month')}
          />
          <PeriodButton
            active={preset === 'current_week'}
            label="Текущая неделя"
            onClick={() => selectPreset('current_week')}
          />
          <PeriodButton
            active={preset === 'custom'}
            label="Свой период"
            onClick={() => selectPreset('custom')}
          />
        </div>

        {preset === 'custom' ? (
          <div className="director-payroll-custom-range">
            <label htmlFor="director-payroll-from">
              С
              <input
                id="director-payroll-from"
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.currentTarget.value)}
              />
            </label>
            <label htmlFor="director-payroll-to">
              По
              <input
                id="director-payroll-to"
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.currentTarget.value)}
              />
            </label>
          </div>
        ) : null}
      </div>

      {rangeResolution.validation ? (
        <p className="director-payroll-validation" role="alert">
          {rangeResolution.validation}
        </p>
      ) : null}

      {loadState.status === 'loading' &&
      loadState.preview === null &&
      !rangeResolution.validation ? (
        <div className="director-payroll-state" role="status" aria-live="polite">
          Загрузка расчёта зарплаты
        </div>
      ) : null}

      {loadState.status === 'error' ? (
        <div className="director-payroll-state director-payroll-error" role="alert">
          <p>{loadState.error}</p>
          <button type="button" onClick={retry}>
            Повторить
          </button>
        </div>
      ) : null}

      {loadState.status === 'empty' ? (
        <div className="director-payroll-state director-payroll-empty" role="status">
          Нет завершённой выработки за период
        </div>
      ) : null}

      {loadState.preview !== null ? (
        <PayrollPreviewContent
          preview={loadState.preview}
          onCreateTariffOrder={() => void tariffOrders.openCreate()}
        />
      ) : null}
      <PayrollTariffOrderDialog controller={tariffOrders} canManage={useLiveData} />
    </section>
  );
}

function PeriodButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? 'is-active' : undefined}
      type="button"
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function PayrollPreviewContent({
  preview,
  onCreateTariffOrder,
}: {
  preview: ServerDirectorPayrollPreview;
  onCreateTariffOrder: () => void;
}) {
  const orderNames = new Map(preview.appliedTariffOrders.map((order) => [order.id, order.name]));
  return (
    <div className="director-payroll-content">
      <dl className="director-payroll-summary" aria-label="Итоги расчёта">
        <SummaryFact
          label="Начислено"
          value={formatKopecks(preview.summary.payableAmountKopecks)}
        />
        <SummaryFact label="Учтено, кг" value={formatKilograms(preview.summary.payableKg)} />
        <SummaryFact label="Операторов" value={integer.format(preview.summary.operatorCount)} />
        <SummaryFact
          label="Рулоны без рассчитанного начисления"
          value={integer.format(preview.summary.unresolvedFactCount)}
        />
      </dl>

      {preview.operators.length > 0 ? (
        <section className="director-payroll-section" aria-labelledby="director-payroll-operators">
          <header className="director-payroll-section-heading">
            <h3 id="director-payroll-operators">Начисления по операторам</h3>
            <span>{preview.appliedTariffOrders.map(({ name }) => name).join(' · ')}</span>
          </header>
          <div className="director-payroll-table-wrap">
            <table className="director-payroll-table">
              <thead>
                <tr>
                  <th>Оператор</th>
                  <th>К начислению</th>
                  <th>Выработка</th>
                  <th>Смены</th>
                  <th>Без начисления</th>
                </tr>
              </thead>
              <tbody>
                {preview.operators.map((operator) => {
                  const rows = preview.breakdown.filter(
                    (row) => row.operatorId === operator.operatorId,
                  );
                  return (
                    <tr key={operator.operatorId}>
                      <td data-label="Оператор">
                        <OperatorBreakdownDetails
                          operatorName={operator.operatorName}
                          rows={rows}
                          orderNames={orderNames}
                        />
                      </td>
                      <td data-label="К начислению">{formatKopecks(operator.amountKopecks)}</td>
                      <td data-label="Выработка">{formatKilograms(operator.payableKg)}</td>
                      <td data-label="Смены">{integer.format(operator.machineShiftCount)}</td>
                      <td data-label="Без начисления">
                        {integer.format(operator.unresolvedFactCount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="director-payroll-defect-evidence" role="note">
        <strong>Исключённый брак</strong>
        <span>
          {formatKilograms(preview.summary.excludedDefectKg)} ·{' '}
          {integer.format(preview.summary.excludedDefectRollCount)} рул.
        </span>
      </div>

      {preview.unresolved.length > 0 ? <UnresolvedFactsTable preview={preview} /> : null}

      <TariffReference preview={preview} onCreateTariffOrder={onCreateTariffOrder} />
    </div>
  );
}

function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="director-payroll-summary-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function OperatorBreakdownDetails({
  operatorName,
  rows,
  orderNames,
}: {
  operatorName: string;
  rows: ServerDirectorPayrollBreakdownRow[];
  orderNames: ReadonlyMap<string, string>;
}) {
  if (rows.length === 0) return <strong>{operatorName}</strong>;
  return (
    <details className="director-payroll-breakdown">
      <summary>
        <strong>{operatorName}</strong>
      </summary>
      <div className="director-payroll-table-wrap">
        <table className="director-payroll-detail-table">
          <caption>{operatorName}: подтверждённые смены</caption>
          <thead>
            <tr>
              <th>Смена</th>
              <th>Станок</th>
              <th>Смена целиком</th>
              <th>К начислению оператору</th>
              <th>Ставка</th>
              <th>Сумма</th>
              <th>Основание</th>
              <th>Приказ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="Смена">{row.shiftLabel}</td>
                <td data-label="Станок">{machineLabel(row)}</td>
                <td data-label="Смена целиком">{formatKilograms(row.shiftOutputKg)}</td>
                <td data-label="К начислению оператору">{formatKilograms(row.payableKg)}</td>
                <td data-label="Ставка">{formatRate(row.rateKopecksPerKg)}</td>
                <td data-label="Сумма">{formatKopecks(row.amountKopecks)}</td>
                <td data-label="Основание">{row.basisLabel}</td>
                <td data-label="Приказ">{orderNames.get(row.tariffOrderId) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function UnresolvedFactsTable({ preview }: { preview: ServerDirectorPayrollPreview }) {
  return (
    <section className="director-payroll-section" aria-labelledby="director-payroll-unresolved">
      <header className="director-payroll-section-heading">
        <h3 id="director-payroll-unresolved">Рулоны без рассчитанного начисления</h3>
        <span>{formatKilograms(preview.summary.unresolvedKg)}</span>
      </header>
      <div className="director-payroll-table-wrap">
        <table className="director-payroll-table director-payroll-unresolved-table">
          <thead>
            <tr>
              <th>Рулон</th>
              <th>Заказ</th>
              <th>Выработка</th>
              <th>Оператор</th>
              <th>Смена</th>
              <th>Станок</th>
              <th>Причина</th>
            </tr>
          </thead>
          <tbody>
            {preview.unresolved.map((fact) => (
              <tr key={fact.rollId}>
                <td data-label="Рулон">
                  {fact.rollCode}
                  <small>{formatDateTime(fact.producedAt)}</small>
                </td>
                <td data-label="Заказ">{fact.orderNumber}</td>
                <td data-label="Выработка">{formatKilograms(fact.netKg)}</td>
                <td data-label="Оператор">{fact.operatorName ?? 'Не определён'}</td>
                <td data-label="Смена">{fact.shiftLabel ?? 'Не определена'}</td>
                <td data-label="Станок">
                  {[fact.postName, fact.postCode].filter(Boolean).join(' · ') || 'Не определён'}
                </td>
                <td data-label="Причина">
                  <ul>
                    {fact.reasons.map((reason) => (
                      <li key={reason}>{unresolvedReasonLabels[reason]}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TariffReference({
  preview,
  onCreateTariffOrder,
}: {
  preview: ServerDirectorPayrollPreview;
  onCreateTariffOrder: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (preview.appliedTariffOrders.length === 0) return null;
  const summary = preview.appliedTariffOrders.map(({ name }) => name).join(', ');
  const title =
    preview.appliedTariffOrders.length === 1
      ? `Тарифы по приказу ${summary.replace(/^Приказ\s+/u, '')}`
      : `Тарифы по приказам: ${summary}`;
  return (
    <section className="director-payroll-tariffs" aria-label="Тарифные приказы">
      <div className="director-payroll-tariff-actions">
        <button
          type="button"
          className="primary-button director-payroll-create-tariff-order"
          onClick={onCreateTariffOrder}
        >
          Создать новый приказ по тарифам
        </button>
        <button
          type="button"
          className="director-payroll-tariff-disclosure"
          aria-label="Показать тарифы по применённым приказам"
          aria-expanded={expanded}
          aria-controls="director-payroll-applied-tariffs"
          onClick={() => setExpanded((current) => !current)}
        >
          <span>
            <strong>{title}</strong>
            <small>Нажмите, чтобы посмотреть тарифы</small>
          </span>
          <SiemensIcon name="chevron-right-small" size="16" />
        </button>
      </div>
      <div
        id="director-payroll-applied-tariffs"
        className="director-payroll-applied-tariffs"
        hidden={!expanded}
      >
        {preview.appliedTariffOrders.map((order) => (
          <AppliedTariffOrderReference key={order.id} order={order} />
        ))}
      </div>
    </section>
  );
}

const tariffLadderLabels: Record<ServerPayrollTariffLadderKey, string> = {
  urp12h: 'УРП, Матиль, Китайка · 12 ч',
  urp24h: 'УРП, Матиль, Китайка · 24 ч',
  abc12h: 'АВС старая, АВС новая · 12 ч',
  abc24h: 'АВС старая, АВС новая · 24 ч',
};

function AppliedTariffOrderReference({ order }: { order: ServerAppliedPayrollTariffOrder }) {
  return (
    <section
      className="director-payroll-tariff-order"
      aria-label={order.name}
      data-payroll-tariff-order={true}
    >
      <header>
        <h3>{order.name}</h3>
        <span>Действует с {order.effectiveFrom}</span>
      </header>
      {(Object.keys(tariffLadderLabels) as ServerPayrollTariffLadderKey[]).map((ladder) => (
        <TariffLadder key={ladder} ladder={ladder} order={order} />
      ))}
      <dl className="director-payroll-special-rules">
        <div>
          <dt>Тонкий рулон</dt>
          <dd>
            {order.matrix.specialRules.thinRoll.enabled ? 'Включён' : 'Выключен'} · менее{' '}
            {formatKilograms(order.matrix.specialRules.thinRoll.maxExclusiveGrams / 1_000)} ·{' '}
            {formatRate(order.matrix.specialRules.thinRoll.rateKopecksPerKg)}
          </dd>
        </div>
        <div>
          <dt>Алабуга</dt>
          <dd>
            {order.matrix.specialRules.alabuga.enabled ? 'Включён' : 'Выключен'} ·{' '}
            {order.matrix.specialRules.alabuga.normalizedLegalName} ·{' '}
            {formatRate(order.matrix.specialRules.alabuga.rateKopecksPerKg)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function TariffLadder({
  ladder,
  order,
}: {
  ladder: ServerPayrollTariffLadderKey;
  order: ServerAppliedPayrollTariffOrder;
}) {
  const bands = order.matrix.ladders[ladder];
  const isUrp = ladder === 'urp12h' || ladder === 'urp24h';
  return (
    <section className="director-payroll-tariff-group">
      <h4>{tariffLadderLabels[ladder]}</h4>
      <div className="director-payroll-table-wrap">
        <table className="director-payroll-tariff-table">
          <thead>
            <tr>
              <th>Выработка</th>
              <th>{isUrp ? 'Первичное' : 'Стандарт'}</th>
              <th>{isUrp ? 'Вторичное' : 'Фальц'}</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((band, index) => (
              <TariffBandRow key={`${band.maxInclusiveGrams ?? 'above'}-${index}`} band={band} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TariffBandRow({
  band,
}: {
  band: ServerPayrollTariffUrpBand | ServerPayrollTariffAbcBand;
}) {
  const rates =
    'primaryRateKopecksPerKg' in band
      ? [band.primaryRateKopecksPerKg, band.secondaryRateKopecksPerKg]
      : [band.standardRateKopecksPerKg, band.blackWhiteRateKopecksPerKg];
  return (
    <tr>
      <td data-label="Выработка">
        {band.maxInclusiveGrams === null
          ? 'Свыше последнего порога'
          : `До ${formatKilograms(band.maxInclusiveGrams / 1_000)}`}
      </td>
      <td data-label="Ставка 1">{formatRate(rates[0] ?? null)}</td>
      <td data-label="Ставка 2">{formatRate(rates[1] ?? null)}</td>
    </tr>
  );
}
