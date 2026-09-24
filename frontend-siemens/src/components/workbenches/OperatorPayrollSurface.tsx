import { useEffect, useRef, useState } from 'react';

import {
  fetchOperatorPayroll,
  type ServerOperatorPayrollPreview,
  type ServerOperatorPayrollUnresolvedFact,
} from '../../api/operatorPayroll';
import {
  createDirectorPayrollRange,
  type DirectorPayrollPreset,
} from '../../domain/runtime/directorPayrollView';
import {
  operatorPayrollHeadlineRanges,
  operatorPayrollReasonLabel,
} from '../../domain/runtime/operatorPayrollView';
import {
  formatOperatorPayrollKg,
  formatOperatorPayrollMoney,
  formatOperatorPayrollRate,
} from '../../domain/runtime/operatorPayrollFormatters';

type LoadState =
  | { status: 'loading'; preview: null }
  | { status: 'ready' | 'refreshing'; preview: ServerOperatorPayrollPreview }
  | { status: 'error'; preview: ServerOperatorPayrollPreview | null };

type HeadlineState =
  | { status: 'loading'; today: null; fortnight: null }
  | {
      status: 'ready';
      today: ServerOperatorPayrollPreview;
      fortnight: ServerOperatorPayrollPreview;
    }
  | { status: 'error'; today: null; fortnight: null };

const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function formatDate(value: string): string {
  const parsed = new Date(`${value}T12:00:00+03:00`);
  return Number.isNaN(parsed.getTime()) ? value : date.format(parsed);
}

function initialRange() {
  return createDirectorPayrollRange('current_month', new Date());
}

function currentHeadlineDateKey() {
  return operatorPayrollHeadlineRanges(new Date()).today.to;
}

export function OperatorPayrollSurface() {
  const [range, setRange] = useState(initialRange);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [headlineDateKey, setHeadlineDateKey] = useState(currentHeadlineDateKey);
  const [state, setState] = useState<LoadState>({ status: 'loading', preview: null });
  const [headlines, setHeadlines] = useState<HeadlineState>({
    status: 'loading',
    today: null,
    fortnight: null,
  });
  const requestGeneration = useRef(0);
  const headlineGeneration = useRef(0);

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      const nextDateKey = currentHeadlineDateKey();
      setHeadlineDateKey((current) => (current === nextDateKey ? current : nextDateKey));
    }, 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  useEffect(() => {
    let normalized;
    try {
      normalized = createDirectorPayrollRange('custom', new Date(), range);
    } catch {
      requestGeneration.current += 1;
      return;
    }

    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setState((current) =>
      current.preview
        ? { status: 'refreshing', preview: current.preview }
        : { status: 'loading', preview: null },
    );
    void fetchOperatorPayroll(
      { from: normalized.from, to: normalized.to },
      { signal: controller.signal },
    ).then(
      (preview) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setState({ status: 'ready', preview });
      },
      () => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setState((current) => ({ status: 'error', preview: current.preview }));
      },
    );
    return () => {
      controller.abort();
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [range, retryGeneration]);

  useEffect(() => {
    const generation = ++headlineGeneration.current;
    const headlineRanges = operatorPayrollHeadlineRanges(new Date());
    setHeadlines({ status: 'loading', today: null, fortnight: null });
    void Promise.all([
      fetchOperatorPayroll(headlineRanges.today),
      fetchOperatorPayroll(headlineRanges.fortnight),
    ]).then(
      ([today, fortnight]) => {
        if (headlineGeneration.current !== generation) return;
        setHeadlines({ status: 'ready', today, fortnight });
      },
      () => {
        if (headlineGeneration.current !== generation) return;
        setHeadlines({ status: 'error', today: null, fortnight: null });
      },
    );
    return () => {
      if (headlineGeneration.current === generation) headlineGeneration.current += 1;
    };
  }, [headlineDateKey, retryGeneration]);

  const applyPreset = (preset: Exclude<DirectorPayrollPreset, 'custom'>) => {
    setRange(createDirectorPayrollRange(preset, new Date()));
  };

  return (
    <section className="operator-payroll-surface" aria-labelledby="operator-payroll-title">
      <header className="operator-payroll-header">
        <div>
          <h1 id="operator-payroll-title">Моя зарплата</h1>
        </div>
      </header>

      <OperatorPayrollHeadlines state={headlines} />

      <div className="operator-payroll-toolbar">
        <div className="operator-payroll-presets" role="group" aria-label="Период расчёта">
          <button
            className={range.preset === 'current_month' ? 'is-active' : undefined}
            type="button"
            aria-pressed={range.preset === 'current_month'}
            onClick={() => applyPreset('current_month')}
          >
            Этот месяц
          </button>
          <button
            className={range.preset === 'previous_month' ? 'is-active' : undefined}
            type="button"
            aria-pressed={range.preset === 'previous_month'}
            onClick={() => applyPreset('previous_month')}
          >
            Прошлый месяц
          </button>
          <button
            className={range.preset === 'current_week' ? 'is-active' : undefined}
            type="button"
            aria-pressed={range.preset === 'current_week'}
            onClick={() => applyPreset('current_week')}
          >
            Эта неделя
          </button>
        </div>
        <div className="operator-payroll-range">
          <label htmlFor="operator-payroll-from">
            С
            <input
              id="operator-payroll-from"
              type="date"
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({
                  ...current,
                  preset: 'custom',
                  from: event.currentTarget.value,
                }))
              }
            />
          </label>
          <label htmlFor="operator-payroll-to">
            По
            <input
              id="operator-payroll-to"
              type="date"
              value={range.to}
              onChange={(event) =>
                setRange((current) => ({
                  ...current,
                  preset: 'custom',
                  to: event.currentTarget.value,
                }))
              }
            />
          </label>
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="operator-payroll-state" role="status">
          Загружаем начисления
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="operator-payroll-state operator-payroll-error" role="status">
          <span>Расчёт сейчас недоступен</span>
          <button type="button" onClick={() => setRetryGeneration((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : null}

      {state.preview ? (
        <OperatorPayrollContent
          preview={state.preview}
          refreshing={state.status === 'refreshing'}
        />
      ) : null}
    </section>
  );
}

function OperatorPayrollHeadlines({ state }: { state: HeadlineState }) {
  if (state.status === 'loading') {
    return (
      <div className="operator-payroll-headlines is-loading" role="status">
        Считаем заработок за сегодня и 14 дней
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="operator-payroll-headlines is-unavailable" role="status">
        Суммы за сегодня и 14 дней временно недоступны
      </div>
    );
  }
  return (
    <dl className="operator-payroll-headlines" aria-label="Быстрые суммы зарплаты">
      <Summary
        label="Сегодня"
        value={formatOperatorPayrollMoney(state.today.summary.payableAmountKopecks)}
      />
      <Summary
        label="За 14 дней"
        value={formatOperatorPayrollMoney(state.fortnight.summary.payableAmountKopecks)}
      />
    </dl>
  );
}

function OperatorPayrollContent({
  preview,
  refreshing,
}: {
  preview: ServerOperatorPayrollPreview;
  refreshing: boolean;
}) {
  const { summary } = preview;
  const orderNames = new Map(preview.appliedTariffOrders.map((order) => [order.id, order.name]));
  const hasDefects = summary.excludedDefectRollCount > 0;
  const hasUnresolved = summary.unresolvedFactCount > 0;
  return (
    <div
      className="operator-payroll-content"
      data-testid="operator-payroll-content"
      aria-busy={refreshing}
    >
      <dl className="operator-payroll-summary">
        <Summary
          label="Начислено"
          value={formatOperatorPayrollMoney(summary.payableAmountKopecks)}
        />
        <Summary label="Выработка" value={formatOperatorPayrollKg(summary.payableKg)} />
        <Summary label="Смены" value={integer.format(summary.machineShiftCount)} />
        <Summary label="Без расчёта" value={integer.format(summary.unresolvedFactCount)} />
      </dl>

      {preview.breakdown.length > 0 ? (
        <section className="operator-payroll-section" aria-labelledby="operator-payroll-breakdown">
          <div className="operator-payroll-section-title">
            <h2 id="operator-payroll-breakdown">Начисления по сменам</h2>
            <span>{preview.appliedTariffOrders.map(({ name }) => name).join(' · ')}</span>
          </div>
          <div className="operator-payroll-table-wrap">
            <table className="operator-payroll-table">
              <thead>
                <tr>
                  <th>Смена</th>
                  <th>Станок</th>
                  <th>Моя выработка</th>
                  <th>Ставка</th>
                  <th>Начислено</th>
                  <th>Основание</th>
                  <th>Приказ</th>
                </tr>
              </thead>
              <tbody>
                {preview.breakdown.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Смена">
                      <strong>{row.shiftLabel}</strong>
                      <small>{formatDate(row.shiftDate)}</small>
                    </td>
                    <td data-label="Станок">{row.postName}</td>
                    <td data-label="Моя выработка">{formatOperatorPayrollKg(row.payableKg)}</td>
                    <td data-label="Ставка">{formatOperatorPayrollRate(row.rateKopecksPerKg)}</td>
                    <td data-label="Начислено">
                      <strong>{formatOperatorPayrollMoney(row.amountKopecks)}</strong>
                    </td>
                    <td data-label="Основание">{row.basisLabel}</td>
                    <td data-label="Приказ">{orderNames.get(row.tariffOrderId) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <div className="operator-payroll-empty" role="status">
          За этот период нет закрытых рулонов
        </div>
      )}

      {preview.unresolved.length > 0 ? <UnresolvedPayroll rows={preview.unresolved} /> : null}

      {hasDefects || hasUnresolved ? (
        <footer className="operator-payroll-footnote">
          {hasDefects ? (
            <span>
              Брак не начисляется: {formatOperatorPayrollKg(summary.excludedDefectKg)} ·{' '}
              {integer.format(summary.excludedDefectRollCount)} рул.
            </span>
          ) : null}
          {hasUnresolved ? (
            <span>
              Не рассчитано: {formatOperatorPayrollKg(summary.unresolvedKg)}. Сумма обновится после
              появления фактов.
            </span>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UnresolvedPayroll({ rows }: { rows: ServerOperatorPayrollUnresolvedFact[] }) {
  return (
    <section className="operator-payroll-section" aria-labelledby="operator-payroll-unresolved">
      <div className="operator-payroll-section-title">
        <h2 id="operator-payroll-unresolved">Пока без начисления</h2>
        <span>{rows.length}</span>
      </div>
      <ul className="operator-payroll-unresolved">
        {rows.map((row) => (
          <li key={row.rollId}>
            <span>
              <strong>{row.rollCode}</strong>
              <small>Заказ {row.orderNumber}</small>
            </span>
            <span>{formatOperatorPayrollKg(row.netKg)}</span>
            <span>{row.reasons.map(operatorPayrollReasonLabel).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
