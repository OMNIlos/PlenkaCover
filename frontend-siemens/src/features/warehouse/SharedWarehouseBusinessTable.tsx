import { useEffect, useState } from 'react';
import {
  fetchCommercialWarehouseBusiness,
  type WarehouseBusinessPage,
  type WarehouseBusinessStatus,
  type WarehouseBusinessTemplate,
} from '../../api/commercialPerformance';
import { fetchDirectorWarehouseBusiness } from '../../api/director';

type WarehouseBusinessRole = 'commercial' | 'director';

const STATUS_LABELS: Record<WarehouseBusinessStatus, string> = {
  awaiting_shipment: 'Ожидает отгрузки',
  reserve: 'В резерве',
  processing: 'В обработке',
};

function number(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3, useGrouping: false })
    .format(value)
    .replace(/\u00a0/gu, ' ');
}

function templateLabel(template: WarehouseBusinessTemplate) {
  const recipe = template.recipeVersion ? ` · ${template.recipeVersion}` : '';
  return (
    `${template.filmType} · ${number(template.actualThicknessMicron)}/` +
    `${number(template.accountingThicknessMicron)} мкм · ${number(template.widthMm)} мм · ` +
    `${number(template.plannedLengthM)} м · ${number(template.plannedWeightKg)} кг · ` +
    `шпуля ${template.spoolType} · бирка ${template.birka}${recipe}`
  );
}

function loadPage(
  role: WarehouseBusinessRole,
  page: number,
  pageSize: number,
  signal: AbortSignal,
) {
  return role === 'director'
    ? fetchDirectorWarehouseBusiness({ page, pageSize }, { signal })
    : fetchCommercialWarehouseBusiness({ page, pageSize }, { signal });
}

export function SharedWarehouseBusinessTable({
  role,
  pageSize = 50,
  refreshGeneration = 0,
}: {
  role: WarehouseBusinessRole;
  pageSize?: number;
  refreshGeneration?: string | number;
}) {
  const [page, setPage] = useState(1);
  const requestScope = `${role}:${page}:${pageSize}`;
  const [loadedSnapshot, setLoadedSnapshot] = useState<{
    scope: string;
    value: WarehouseBusinessPage;
  } | null>(null);
  const snapshot = loadedSnapshot?.scope === requestScope ? loadedSnapshot.value : null;
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setError(null);
    setLoadedSnapshot((current) => (current?.scope === requestScope ? current : null));
    void loadPage(role, page, pageSize, controller.signal)
      .then((next) => {
        if (active) setLoadedSnapshot({ scope: requestScope, value: next });
      })
      .catch((loadError: unknown) => {
        if (active) {
          setLoadedSnapshot(null);
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить склад.');
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, pageSize, refreshGeneration, requestScope, revision, role]);

  if (!snapshot) {
    return error ? (
      <div>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          Повторить
        </button>
      </div>
    ) : (
      <p aria-live="polite">Загрузка склада…</p>
    );
  }

  const pageCount = Math.max(1, Math.ceil(snapshot.total / snapshot.pageSize));
  return (
    <div className="warehouse-business-table" aria-live="polite">
      {error ? (
        <div>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : null}
      {snapshot.items.length === 0 ? (
        <p>На складе нет текущих позиций.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Параметры рулонов</th>
              <th>Статус</th>
              <th>Заказ</th>
              <th>Контрагент</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.items.map((item) => (
              <tr key={`${item.kind}:${item.id}`} data-order-status={item.status}>
                <td data-label="Параметры рулонов">
                  {item.templates.length === 0 ? (
                    <span>Параметры уточняются</span>
                  ) : (
                    <ul>
                      {item.templates.map((template) => (
                        <li key={template.fingerprint}>{templateLabel(template)}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td data-label="Статус">{STATUS_LABELS[item.status]}</td>
                <td data-label="Заказ">{item.orderNumber ?? '—'}</td>
                <td data-label="Контрагент">{item.counterpartyName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pageCount > 1 ? (
        <nav className="commercial-performance-pagination" aria-label="Страницы склада">
          <button
            type="button"
            aria-label="Предыдущая страница"
            disabled={snapshot.page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Назад
          </button>
          <span>
            Страница {snapshot.page} из {pageCount}
          </span>
          <button
            type="button"
            aria-label="Следующая страница"
            disabled={snapshot.page >= pageCount}
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          >
            Далее
          </button>
        </nav>
      ) : null}
    </div>
  );
}
