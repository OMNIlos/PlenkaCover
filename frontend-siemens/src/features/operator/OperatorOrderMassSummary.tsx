import { memo, useEffect, useRef, useState } from 'react';
import { fetchOperatorOrderMass, type OperatorOrderMass } from '../../api/operator';
import { isLiveContour } from '../../api/liveContours';

const MASS_FORMAT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

type LoadMass = (orderNumber: string, signal?: AbortSignal) => Promise<OperatorOrderMass>;

function kg(value: number): string {
  return `${MASS_FORMAT.format(value)} кг`;
}

function deviation(value: number): { label: string; value: string } {
  if (value > 0) return { label: 'Перевес', value: `+${kg(value)}` };
  if (value < 0) return { label: 'Недовес', value: `−${kg(Math.abs(value))}` };
  return { label: 'Отклонение', value: kg(0) };
}

export const OperatorOrderMassSummary = memo(function OperatorOrderMassSummary({
  orderNumber,
  refreshKey = '',
  refreshIntervalMs = isLiveContour('operator') ? 5_000 : 0,
  loadMass = fetchOperatorOrderMass,
}: {
  orderNumber: string;
  refreshKey?: string;
  refreshIntervalMs?: number;
  loadMass?: LoadMass;
}) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    orderNumber: string;
    value: OperatorOrderMass;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const inFlightRef = useRef(false);
  const data = snapshot?.orderNumber === orderNumber ? snapshot.value : null;

  useEffect(() => {
    if (refreshIntervalMs <= 0) return;
    const handle = globalThis.setInterval(() => {
      if (!inFlightRef.current && (typeof document === 'undefined' || !document.hidden)) {
        setRevision((value) => value + 1);
      }
    }, refreshIntervalMs);
    return () => globalThis.clearInterval(handle);
  }, [orderNumber, refreshIntervalMs]);

  useEffect(() => {
    const controller = new AbortController();
    inFlightRef.current = true;
    setLoading(true);
    void loadMass(orderNumber, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        inFlightRef.current = false;
        setSnapshot({ orderNumber, value: next });
        setFailed(false);
        setLoading(false);
      },
      () => {
        if (controller.signal.aborted) return;
        inFlightRef.current = false;
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      controller.abort();
      inFlightRef.current = false;
    };
  }, [loadMass, orderNumber, refreshKey, revision]);

  const difference = data ? deviation(data.deviationKg) : null;
  const values: Array<{
    label: string;
    value: string;
    detail?: string;
    deviation?: 'zero' | 'over' | 'under';
  }> = data
    ? [
        { label: 'План заказа', value: kg(data.orderPlannedNetKg) },
        {
          label: 'План взвешенных',
          value: kg(data.weighedPlannedNetKg),
          detail: `${data.weighedRollCount} из ${data.totalRollCount}`,
        },
        { label: 'Факт', value: kg(data.actualNetKg) },
        {
          label: difference?.label ?? 'Отклонение',
          value: difference?.value ?? '—',
          deviation: data.deviationKg === 0 ? 'zero' : data.deviationKg > 0 ? 'over' : 'under',
        },
      ]
    : [
        { label: 'План заказа', value: '—' },
        { label: 'План взвешенных', value: '—' },
        { label: 'Факт', value: '—' },
        { label: 'Отклонение', value: '—' },
      ];
  return (
    <section
      className="operator-order-mass"
      role="region"
      aria-label="Масса заказа"
      aria-busy={loading}
    >
      <dl className="operator-order-mass-values">
        {values.map((item) => (
          <div key={item.label} data-deviation={item.deviation}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
            {item.detail ? <small>{item.detail}</small> : null}
          </div>
        ))}
      </dl>
      <div
        className="operator-order-mass-state"
        role={failed ? 'alert' : 'status'}
        aria-live="polite"
      >
        {failed ? (
          <>
            <span>Не удалось обновить массу заказа.</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              Повторить
            </button>
          </>
        ) : loading && !data ? (
          <span>Рассчитываем массу заказа…</span>
        ) : (
          <span aria-hidden="true">&nbsp;</span>
        )}
      </div>
    </section>
  );
});
