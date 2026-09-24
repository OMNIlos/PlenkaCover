import { useEffect, useState } from 'react';

import { fetchFinanceRawMaterials, type FinanceRawMaterial } from '../../api/financeRawMaterials';

const MOSCOW_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
  timeStyle: 'short',
});

function exactMoney(value: string | null): string {
  if (value === null) return 'Нет данных';
  const [integer, fraction = '00'] = value.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
  return `${grouped},${fraction.padEnd(2, '0').slice(0, 2)} ₽`;
}

function weight(value: string | null): string {
  return value === null ? 'Нет данных' : `${value.replace('.', ',')} кг`;
}

function dateTime(value: string | null): string {
  return value === null ? 'Нет данных' : MOSCOW_DATE_TIME.format(new Date(value));
}

export function FinanceRawMaterialsTable({ rows }: { rows: FinanceRawMaterial[] }) {
  if (rows.length === 0) {
    return (
      <div className="finance-raw-material-empty" role="status">
        <strong>BigBag пока не зарегистрированы</strong>
        <span>Финансовые факты появятся после подтверждённой складской приёмки.</span>
      </div>
    );
  }

  return (
    <div className="finance-raw-material-table-wrap">
      <table
        className="finance-raw-material-table"
        aria-label="Финансовое состояние партий BigBag"
      >
        <colgroup>
          <col className="finance-raw-material-identity-column" />
          <col className="finance-raw-material-receipt-column" />
          <col className="finance-raw-material-initial-column" />
          <col className="finance-raw-material-current-column" />
          <col className="finance-raw-material-consumed-column" />
        </colgroup>
        <thead>
          <tr className="finance-raw-material-group-row">
            <th scope="col" rowSpan={2}>
              BigBag / партия
            </th>
            <th scope="colgroup" colSpan={2}>
              Изначальные данные
            </th>
            <th scope="colgroup" colSpan={2}>
              Текущие данные
            </th>
          </tr>
          <tr>
            <th scope="col">Приёмка</th>
            <th scope="col">Вес и стоимость</th>
            <th scope="col">Остаток</th>
            <th scope="col">Расход</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td data-label="BigBag / партия">
                <strong>{row.code}</strong>
                <span>{row.material}</span>
                <small>Партия: {row.batchCode ?? 'Нет данных'}</small>
                <small>Поставщик: {row.supplier ?? 'Нет данных'}</small>
              </td>
              <td data-label="Изначально · Приёмка">
                <dl className="finance-raw-material-facts">
                  <div>
                    <dt>Дата</dt>
                    <dd>{dateTime(row.receivedAt)}</dd>
                  </div>
                </dl>
              </td>
              <td data-label="Изначально · Вес и стоимость">
                <dl className="finance-raw-material-facts">
                  <div>
                    <dt>Вес</dt>
                    <dd>{weight(row.initialWeightKg)}</dd>
                  </div>
                  <div>
                    <dt>Цена за кг</dt>
                    <dd>{exactMoney(row.purchasePricePerKg)}</dd>
                  </div>
                  <div>
                    <dt>Первоначальная стоимость</dt>
                    <dd>{exactMoney(row.initialValue)}</dd>
                  </div>
                </dl>
              </td>
              <td data-label="Сейчас · Остаток">
                <dl className="finance-raw-material-facts">
                  <div>
                    <dt>Остаток</dt>
                    <dd>{weight(row.currentWeightKg)}</dd>
                  </div>
                  <div>
                    <dt>Стоимость остатка</dt>
                    <dd>{exactMoney(row.currentValue)}</dd>
                  </div>
                  <div>
                    <dt>Измерено</dt>
                    <dd>{dateTime(row.measuredAt)}</dd>
                  </div>
                </dl>
              </td>
              <td data-label="Сейчас · Расход">
                <dl className="finance-raw-material-facts">
                  <div>
                    <dt>Израсходовано</dt>
                    <dd>{weight(row.consumedWeightKg)}</dd>
                  </div>
                  <div>
                    <dt>Стоимость расхода</dt>
                    <dd>{exactMoney(row.consumedValue)}</dd>
                  </div>
                </dl>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FinanceRawMaterialsSurface() {
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<
    | { status: 'loading'; rows: FinanceRawMaterial[] }
    | { status: 'ready'; rows: FinanceRawMaterial[] }
    | { status: 'error'; rows: FinanceRawMaterial[] }
  >({ status: 'loading', rows: [] });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', rows: [] });
    void fetchFinanceRawMaterials({ signal: controller.signal })
      .then((rows) => setState({ status: 'ready', rows }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error', rows: [] });
      });
    return () => controller.abort();
  }, [generation]);

  return (
    <article className="finance-raw-material-surface" aria-label="Финансовый учёт BigBag">
      <header>
        <h2>Стоимость партий BigBag</h2>
      </header>
      {state.status === 'loading' ? (
        <div className="finance-raw-material-empty" role="status">
          Загружаем финансовые факты BigBag…
        </div>
      ) : state.status === 'error' ? (
        <div className="finance-raw-material-empty" role="alert">
          <strong>Финансовые факты сырья недоступны</strong>
          <span>Неподтверждённые цены и остатки не показаны.</span>
          <button type="button" onClick={() => setGeneration((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <FinanceRawMaterialsTable rows={state.rows} />
      )}
    </article>
  );
}
