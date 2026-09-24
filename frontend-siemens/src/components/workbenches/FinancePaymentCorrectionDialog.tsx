import { useState, type FormEvent } from 'react';
import type { FinanceCorrectablePayment } from '../../domain/types';

export function FinancePaymentCorrectionDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: FinanceCorrectablePayment;
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
      setError('Укажите причину отмены подтверждения.');
      return;
    }
    if (!confirmed) {
      setError('Подтвердите создание корректирующей записи.');
      return;
    }
    setError(null);
    if (await onConfirm(normalizedReason)) onClose();
  };

  return (
    <div className="finance-payment-correction-backdrop" role="presentation">
      <section
        className="finance-payment-correction-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finance-payment-correction-title"
      >
        <form onSubmit={(event) => void submit(event)}>
          <header>
            <div>
              <span>Корректирующая запись</span>
              <h3 id="finance-payment-correction-title">Отменить подтверждение оплаты</h3>
            </div>
            <button type="button" disabled={busy} onClick={onClose} aria-label="Закрыть">
              Закрыть
            </button>
          </header>

          <dl>
            <div>
              <dt>Операция</dt>
              <dd>{target.label}</dd>
            </div>
            {target.amount && (
              <div>
                <dt>Сумма</dt>
                <dd>{target.amount} ₽</dd>
              </div>
            )}
          </dl>

          <p className="finance-payment-correction-note">
            Будет создана компенсирующая запись. Счёт не удаляется, ранее выданный производственный
            допуск сохраняется — повторного ожидания оплаты или выставления счёта не будет.
          </p>

          <label>
            <span>Причина корректировки</span>
            <textarea
              aria-label="Причина отмены подтверждения"
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder="Например: оплата отмечена не по тому заказу"
            />
          </label>

          <label className="finance-payment-correction-confirm">
            <input
              aria-label="Подтвердить корректировку оплаты"
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            <span>Подтверждаю отмену только выбранного платёжного факта</span>
          </label>

          {error && <p role="alert">{error}</p>}

          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              Назад
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Создать корректировку'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
