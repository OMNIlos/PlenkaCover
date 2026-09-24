import { useState, type FormEvent } from 'react';

export function ProductionActionCancellationDialog({
  title,
  detail,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  detail: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      setError('Укажите причину отмены.');
      return;
    }
    if (!confirmed) {
      setError('Подтвердите безопасную отмену действия.');
      return;
    }
    setError(null);
    if (await onConfirm(normalizedReason)) onClose();
  };

  return (
    <div className="production-action-cancellation-backdrop" role="presentation">
      <section
        className="production-action-cancellation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="production-action-cancellation-title"
      >
        <form onSubmit={(event) => void submit(event)}>
          <header>
            <div>
              <span className="eyebrow">Корректировка планирования</span>
              <h3 id="production-action-cancellation-title">{title}</h3>
            </div>
            <button type="button" disabled={busy} onClick={onClose}>
              Закрыть
            </button>
          </header>

          <strong>{detail}</strong>
          <p>
            Освобождается только незапущенная работа. Физические факты не удаляются: перед отменой
            будут проверены сессия оператора, веса, печать и другие действия оборудования.
          </p>

          <label>
            <span>Причина отмены</span>
            <textarea
              aria-label="Причина отмены действия"
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Например: назначен не тот оператор"
            />
          </label>

          <label className="production-action-cancellation-confirm">
            <input
              aria-label="Подтвердить безопасную отмену"
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            <span>Подтверждаю отмену только действия, которое ещё не началось физически</span>
          </label>

          {error && <p role="alert">{error}</p>}

          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              Назад
            </button>
            <button type="submit" className="action-destructive" disabled={busy}>
              {busy ? 'Проверяем…' : 'Подтвердить отмену'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
