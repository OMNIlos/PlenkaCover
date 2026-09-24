import { useState, type FormEvent } from 'react';

export function CommercialOrderLifecycleActions({
  orderNumber,
  cancelled,
  busy,
  onCancel,
  onDelete,
}: {
  orderNumber: string;
  cancelled: boolean;
  busy: boolean;
  onCancel: (reason: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');

  if (cancelled) {
    return (
      <section className="commercial-order-lifecycle" aria-label="Управление заказом">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (
              globalThis.confirm(
                `Заказ ${orderNumber} будет удалён у всех без возможности восстановления. Продолжить?`,
              )
            ) {
              void onDelete();
            }
          }}
        >
          {busy ? 'Удаляем…' : 'Удалить заказ'}
        </button>
      </section>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (!normalizedReason || busy) return;
    if (await onCancel(normalizedReason)) {
      setEditing(false);
      setReason('');
    }
  };

  return (
    <section
      className="commercial-order-comment commercial-order-lifecycle"
      aria-label="Управление заказом"
    >
      {!editing ? (
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>
          Отменить заказ
        </button>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>Причина отмены заказа</span>
            <textarea
              aria-label="Причина отмены заказа"
              autoFocus
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
          <div className="commercial-order-comment-actions">
            <span>{reason.length} / 500</span>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Закрыть
            </button>
            <button type="submit" disabled={busy || !reason.trim()}>
              {busy ? 'Отменяем…' : 'Подтвердить отмену'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
