import { useCallback, useEffect, useState } from 'react';

import {
  createRawMaterialCatalogItem,
  fetchRawMaterialCatalog,
  type RawMaterialCatalogItem,
} from '../../api/materialRecipeCatalog';
import {
  PlenkiDataTable,
  PlenkiMetricStrip,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';

export function AdminMaterialTypesSection() {
  const [materials, setMaterials] = useState<RawMaterialCatalogItem[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMaterials(await fetchRawMaterialCatalog());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const material = await createRawMaterialCatalogItem(trimmedName);
      setMaterials((current) =>
        [...current.filter((item) => item.id !== material.id), material].sort((left, right) =>
          left.name.localeCompare(right.name, 'ru'),
        ),
      );
      setName('');
      setNotice(`Вид сырья «${material.name}» добавлен в склад и коммерцию.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const columns: Array<PlenkiDataTableColumn<RawMaterialCatalogItem>> = [
    {
      id: 'name',
      header: 'Вид сырья',
      render: (material) => <strong>{material.name}</strong>,
    },
    {
      id: 'kind',
      header: 'Источник',
      render: (material) => (material.kind === 'base' ? 'Базовый' : 'Добавлен админом'),
    },
    {
      id: 'usage',
      header: 'Где доступен',
      render: () => 'Заявка коммерции · Big-Bag',
    },
  ];

  return (
    <section className="admin-live-section" data-testid="admin-material-types">
      <div className="admin-live-callout">
        <strong>Общий список видов сырья</strong>
        <span>Новый вид сразу появится в dropdown при создании Big-Bag и в заявке коммерции.</span>
        <form
          className="admin-live-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            <span>Название вида сырья</span>
            <input
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setError(null);
                setNotice(null);
              }}
              placeholder="Например, ПНД гранула"
            />
          </label>
          <button
            type="submit"
            className="compact-action-button action-recommended"
            disabled={busy || name.trim().length === 0}
          >
            {busy ? 'Добавляем…' : 'Добавить вид сырья'}
          </button>
        </form>
      </div>

      {error ? (
        <div className="admin-live-message tone-critical" role="alert">
          <span>{error}</span>
          <button type="button" className="compact-action-button" onClick={() => void reload()}>
            Обновить список
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="admin-live-message tone-success" role="status">
          {notice}
        </div>
      ) : null}

      <PlenkiMetricStrip
        metrics={[
          {
            id: 'materials',
            label: 'Виды сырья',
            value: loading ? '…' : materials.length,
            caption: 'в общем списке',
          },
          {
            id: 'custom',
            label: 'Добавлены админом',
            value: loading
              ? '…'
              : materials.filter((material) => material.kind === 'custom').length,
          },
        ]}
      />
      <PlenkiDataTable
        caption="Виды сырья"
        columns={columns}
        rows={materials}
        getRowKey={(material) => material.id}
        empty={loading ? 'Загружаем список…' : 'Виды сырья ещё не добавлены.'}
      />
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Операция не выполнена. Повторите попытку.';
}
