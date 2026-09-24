import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  fetchWarehouseDefectBags,
  type WarehouseDefectBag,
  type WarehouseDefectBagMode,
} from '../../api/warehouse';
import {
  defectBagDisplayLabel,
  defectBagShiftDisplayLabel,
  defectBagTypeLabel,
} from '../../domain/defectBagLabels';
import { PlenkiDataTable, type PlenkiDataTableColumn } from '../plenki-ui/PlenkiPrimitives';

const EMPTY_QUEUES: Record<WarehouseDefectBagMode, WarehouseDefectBag[]> = {
  receiving: [],
  shipping: [],
};

export function warehouseDefectBagModeForSection(section: string): WarehouseDefectBagMode | null {
  if (section === 'Прием брака') return 'receiving';
  if (section === 'Отгрузка брака') return 'shipping';
  return null;
}

function defectBagCountLabel(count: number) {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  const noun =
    mod100 >= 11 && mod100 <= 14
      ? 'мешков'
      : mod10 === 1
        ? 'мешок'
        : mod10 >= 2 && mod10 <= 4
          ? 'мешка'
          : 'мешков';
  return `${count} ${noun} в очереди`;
}

export function useWarehouseDefectBagQueues(
  enabled: boolean,
  mode: WarehouseDefectBagMode | null,
  refreshGeneration: number,
) {
  const [queues, setQueues] = useState(EMPTY_QUEUES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setQueues(EMPTY_QUEUES);
      setLoading(false);
      setError(null);
      return;
    }
    if (!mode) {
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      fetchWarehouseDefectBags('receiving'),
      fetchWarehouseDefectBags('shipping'),
    ])
      .then(([receiving, shipping]) => {
        if (!cancelled) setQueues({ receiving, shipping });
      })
      .catch(() => {
        if (!cancelled) {
          setError('Не удалось загрузить очередь брака. Проверьте связь и повторите.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, mode, refreshGeneration]);

  const counts = useMemo(
    () => ({
      'Прием брака': queues.receiving.length,
      'Отгрузка брака': queues.shipping.length,
    }),
    [queues],
  );

  return {
    bags: mode ? queues[mode] : EMPTY_QUEUES.receiving,
    counts,
    loading,
    error,
  };
}

export function WarehouseDefectBagSurface({
  mode,
  bags,
  loading = false,
  loadError,
  onScan,
  onRetry,
}: {
  mode: WarehouseDefectBagMode;
  bags: WarehouseDefectBag[];
  loading?: boolean;
  loadError?: string | null;
  onScan?: (payload: string) => Promise<boolean>;
  onRetry?: () => void;
}) {
  const [payload, setPayload] = useState('');
  const [pending, setPending] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const receiving = mode === 'receiving';
  const scanEnabled = Boolean(onScan);
  const title = receiving ? 'Прием брака' : 'Отгрузка брака';
  const action = receiving ? 'Принять мешок' : 'Отгрузить мешок';
  const totalKg = bags.reduce((sum, bag) => sum + bag.weightKg, 0);
  const lastScan = scanError ? 'Ошибка' : scanResult ? (receiving ? 'Принят' : 'Отгружен') : '—';

  useEffect(() => {
    if (!loading && scanEnabled) inputRef.current?.focus();
  }, [loading, mode, scanEnabled]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scanned = payload.trim();
    if (!scanned || !onScan || pending) return;
    setPending(true);
    setScanError(null);
    setScanResult(null);
    try {
      if (await onScan(scanned)) {
        setPayload('');
        setScanResult(receiving ? 'Мешок принят.' : 'Мешок отгружен.');
      } else setScanError('Скан не обработан. Проверьте код и повторите Enter.');
    } catch {
      setScanError('Скан не обработан. Проверьте связь и повторите Enter.');
    } finally {
      setPending(false);
      const focusInput = () => inputRef.current?.focus();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusInput);
      else focusInput();
    }
  }

  const columns: Array<PlenkiDataTableColumn<WarehouseDefectBag>> = [
    {
      id: 'code',
      header: 'Мешок',
      dataLabel: 'Мешок',
      render: (bag) => <strong>{defectBagDisplayLabel(bag)}</strong>,
    },
    {
      id: 'weight',
      header: 'Вес',
      dataLabel: 'Вес',
      width: '14%',
      render: (bag) => <strong>{bag.weightKg.toLocaleString('ru-RU')} кг</strong>,
    },
    {
      id: 'type',
      header: 'Тип брака',
      dataLabel: 'Тип брака',
      render: (bag) => <strong>{defectBagTypeLabel(bag.defectType)}</strong>,
    },
    {
      id: 'operator',
      header: 'Оператор',
      dataLabel: 'Оператор',
      render: (bag) => (
        <>
          <strong>{bag.operatorName}</strong>
          <small>{defectBagShiftDisplayLabel(bag)}</small>
        </>
      ),
    },
    {
      id: 'post',
      header: 'Пост',
      dataLabel: 'Пост',
      render: (bag) => (
        <>
          <strong>{bag.postName}</strong>
          <small>{bag.postCode}</small>
        </>
      ),
    },
    {
      id: 'weighedAt',
      header: 'Взвешен',
      dataLabel: 'Взвешен',
      render: (bag) => new Date(bag.weighedAt).toLocaleString('ru-RU'),
    },
  ];

  return (
    <section className="warehouse-scan-station-page" aria-label={title}>
      <section className="warehouse-command-strip" aria-label="Операция с браком">
        <div className="warehouse-command-title">
          <span className="eyebrow">Склад · брак</span>
          <h2>{title}</h2>
          <small>{loading ? 'Обновляем очередь…' : defectBagCountLabel(bags.length)}</small>
        </div>
        <div className="warehouse-command-facts" aria-label="Счетчики брака">
          <div>
            <span>Мешки</span>
            <strong>{bags.length}</strong>
          </div>
          <div>
            <span>Общий вес</span>
            <strong>{totalKg.toLocaleString('ru-RU')} кг</strong>
          </div>
          <div className={scanError ? 'severity-critical' : undefined}>
            <span>Последний скан</span>
            <strong>{lastScan}</strong>
          </div>
        </div>
        <div className="warehouse-command-actions">
          <form className="warehouse-scan-input-form" onSubmit={submit}>
            <label>
              <span>QR мешка брака</span>
              <input
                ref={inputRef}
                value={payload}
                disabled={!onScan || pending}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="done"
                aria-label="QR мешка брака"
                placeholder="Сканируйте QR"
                onChange={(event) => setPayload(event.target.value)}
              />
            </label>
            <button type="submit" disabled={!onScan || pending || !payload.trim()}>
              {pending ? 'Проверяем…' : action}
            </button>
            {!onScan && (
              <small>Сканирование доступно после входа в складскую сессию и привязки поста.</small>
            )}
            {scanResult && (
              <small className="is-success" role="status">
                {scanResult}
              </small>
            )}
            {scanError && <small role="alert">{scanError}</small>}
          </form>
        </div>
      </section>

      {loadError && (
        <div className="warehouse-empty-scan-state severity-critical" role="alert">
          <strong>Очередь недоступна</strong>
          <span>{loadError}</span>
          {onRetry && (
            <button type="button" className="secondary-button" onClick={onRetry}>
              Повторить
            </button>
          )}
        </div>
      )}

      <section className="warehouse-scan-station-table" aria-label={`${title}: очередь`}>
        <div className="warehouse-scan-queue-scroll">
          <PlenkiDataTable
            caption={`${title}: мешки брака`}
            columns={columns}
            rows={bags}
            tableClassName="warehouse-scan-station-data-table warehouse-defect-bag-data-table"
            getRowKey={(bag) => bag.id}
            empty={
              <div className="plenki-empty-state">
                <strong>{loading ? 'Обновляем очередь' : 'Очередь пуста'}</strong>
                <span>
                  {loading
                    ? 'Получаем актуальные мешки.'
                    : receiving
                      ? 'Все мешки брака приняты.'
                      : 'Нет мешков брака для отгрузки.'}
                </span>
              </div>
            }
          />
        </div>
      </section>
    </section>
  );
}
