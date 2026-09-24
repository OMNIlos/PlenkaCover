import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAdminUnresolvedPrintJobs,
  reconcileAdminPrintJob,
  type AdminUnresolvedPrintJob,
} from '../../api/admin';
import { IdempotentOperationGate, isDeliveryUncertain } from '../../api/idempotentOperation';
import {
  PlenkiDataTable,
  PlenkiModal,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';

const KIND_LABELS = {
  roll: 'Рулон',
  defect_bag: 'Мешок брака',
  big_bag: 'Биг-бег сырья',
  pallet: 'Паллета',
};

export function AdminPrintRecoverySection() {
  const [jobs, setJobs] = useState<AdminUnresolvedPrintJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminUnresolvedPrintJob | null>(null);
  const [outcome, setOutcome] = useState<'label_observed' | 'not_printed' | ''>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(new IdempotentOperationGate(undefined, true));
  const load = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    load.current?.abort();
    const controller = new AbortController();
    load.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchAdminUnresolvedPrintJobs(controller.signal);
      if (!controller.signal.aborted) setJobs(rows);
    } catch (cause) {
      if (!controller.signal.aborted)
        setLoadError(
          cause instanceof Error ? cause.message : 'Не удалось загрузить список печати.',
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => load.current?.abort();
  }, [refresh]);

  async function submit() {
    if (!selected || !outcome || busy || reason.trim().length < 3) return;
    const decision = { outcome, reason: reason.trim() };
    const pending = gate.current.start(
      JSON.stringify(['admin:print-reconcile', selected.kind, selected.printJobId, decision]),
      (operationKey) => reconcileAdminPrintJob(selected, { ...decision, operationKey }),
    );
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await pending;
      setNotice(
        `Сверка «${selected.objectCode}» сохранена. ${outcome === 'label_observed' ? 'Этикетка подтверждена. Обновите рабочий экран.' : 'Доступна новая попытка печати.'}`,
      );
      setSelected(null);
      setUncertain(false);
      await refresh();
    } catch (cause) {
      const unknown = isDeliveryUncertain(cause);
      setUncertain(unknown);
      setError(
        unknown
          ? 'Ответ не получен. Нажмите «Повторить сохранение»: будет отправлено то же решение.'
          : cause instanceof Error
            ? cause.message
            : 'Не удалось сохранить сверку.',
      );
    } finally {
      setBusy(false);
    }
  }

  const columns: PlenkiDataTableColumn<AdminUnresolvedPrintJob>[] = [
    { id: 'kind', header: 'Тип', render: (job) => KIND_LABELS[job.kind] },
    { id: 'object', header: 'Объект', render: (job) => <strong>{job.objectCode}</strong> },
    {
      id: 'time',
      header: 'Запрос печати',
      render: (job) => new Date(job.createdAt).toLocaleString('ru-RU'),
    },
    {
      id: 'action',
      header: 'Действие',
      render: (job) => (
        <button
          type="button"
          className="compact-action-button"
          onClick={() => {
            setSelected(job);
            setOutcome('');
            setReason('');
            setError(null);
            setUncertain(false);
            setNotice(null);
          }}
        >
          Сверить печать
        </button>
      ),
    },
  ];

  return (
    <section className="admin-live-section" data-testid="admin-print-recovery">
      <div className="admin-live-callout">
        <strong>Неизвестный результат печати</strong>
        <span>Проверьте этикетку у принтера и сохраните факт. Сверка не запускает принтер.</span>
        <button
          type="button"
          className="compact-action-button"
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          Обновить список печати
        </button>
      </div>
      {loadError ? (
        <div role="alert" className="admin-live-message tone-critical">
          {loadError}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="admin-live-message tone-success">
          {notice}
        </div>
      ) : null}
      {!loadError ? (
        <PlenkiDataTable
          caption="Печать требует сверки"
          columns={columns}
          rows={jobs}
          getRowKey={(job) => `${job.kind}:${job.printJobId}`}
          empty={loading ? 'Загружаем…' : 'Нет заданий, требующих сверки.'}
        />
      ) : null}
      {selected ? (
        <PlenkiModal
          title={`Сверка печати · ${selected.objectCode}`}
          eyebrow={KIND_LABELS[selected.kind]}
          closeDisabled={busy || uncertain}
          onClose={() => setSelected(null)}
        >
          <form
            className="admin-live-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p>
              Убедитесь, что проверяете этикетку этого объекта. Если результат неизвестен, закройте
              окно и обратитесь к оператору принтера.
            </p>
            <label>
              <span>Фактический результат</span>
              <select
                required
                value={outcome}
                disabled={busy || uncertain}
                onChange={(event) => setOutcome(event.currentTarget.value as typeof outcome)}
              >
                <option value="">Выберите после проверки</option>
                <option value="label_observed">Этикетка напечатана</option>
                <option value="not_printed">Этикетка не напечатана</option>
              </select>
            </label>
            <label>
              <span>Основание сверки</span>
              <textarea
                required
                minLength={3}
                maxLength={500}
                value={reason}
                disabled={busy || uncertain}
                placeholder="Что проверили и кто подтвердил результат"
                onChange={(event) => setReason(event.currentTarget.value)}
              />
            </label>
            {error ? (
              <div role="alert" className="admin-live-message tone-critical">
                {error}
              </div>
            ) : null}
            <button
              type="submit"
              className="compact-action-button action-recommended"
              disabled={busy || !outcome || reason.trim().length < 3}
            >
              {busy ? 'Сохраняем…' : uncertain ? 'Повторить сохранение' : 'Подтвердить результат'}
            </button>
          </form>
        </PlenkiModal>
      ) : null}
    </section>
  );
}
