import { useCallback, useEffect, useState } from 'react';

import {
  fetchFinanceReconciliation,
  resolveFinancePaymentAllocation,
  syncOneCPayments,
  type FinanceReconciliationItem,
  type OneCPaymentSyncResult,
} from '../../api/financeOneC';

function moneyLabel(value: string, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  const number = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${number} ${currency === 'RUB' ? '₽' : currency}`;
}

function receiptStateLabel(receipt: FinanceReconciliationItem): string {
  if (receipt.deleted || !receipt.posted) return 'Поступление отменено';
  if (receipt.matchState === 'ambiguous') return 'Неоднозначное совпадение';
  if (receipt.matchState === 'proposal') return 'Нужно подтвердить связь';
  if (receipt.matchState === 'unmatched') return 'Заказ не найден';
  if (receipt.sourceStatus !== 'fresh') return 'Источник требует проверки';
  return 'Остаток не распределён';
}

function ManualReceiptAllocation({
  receipt,
  onResolved,
}: {
  receipt: FinanceReconciliationItem;
  onResolved: () => Promise<void>;
}) {
  const [financeOrderId, setFinanceOrderId] = useState(receipt.candidateFinanceOrderIds[0] ?? '');
  const [amount, setAmount] = useState(receipt.remainingAmount);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericAmount = Number(amount.replace(',', '.'));
  const valid =
    financeOrderId.trim().length > 0 &&
    Number.isFinite(numericAmount) &&
    numericAmount > 0 &&
    reason.trim().length >= 4;

  async function resolve() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await resolveFinancePaymentAllocation(receipt.id, {
        operationKey: crypto.randomUUID(),
        reason: reason.trim(),
        allocations: [{ financeOrderId: financeOrderId.trim(), amount: numericAmount }],
      });
      await onResolved();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Не удалось связать поступление с заказом.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onec-reconciliation-resolve">
      <label>
        <span>Финансовое дело</span>
        <input
          value={financeOrderId}
          disabled={busy}
          onChange={(event) => setFinanceOrderId(event.currentTarget.value)}
          placeholder="ID финансового дела"
        />
      </label>
      <label>
        <span>Сумма распределения</span>
        <input
          inputMode="decimal"
          value={amount}
          disabled={busy}
          onChange={(event) => setAmount(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>Основание</span>
        <textarea
          value={reason}
          disabled={busy}
          maxLength={500}
          onChange={(event) => setReason(event.currentTarget.value)}
          placeholder="Например: сверено по банковской выписке"
        />
      </label>
      <button type="button" disabled={!valid || busy} onClick={() => void resolve()}>
        {busy ? 'Связываем…' : 'Связать поступление'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export function OneCReconciliationPanel() {
  const [receipts, setReceipts] = useState<FinanceReconciliationItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<OneCPaymentSyncResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await fetchFinanceReconciliation();
      setReceipts(next);
      setStatus('ready');
    } catch (caught) {
      setStatus('error');
      setError(
        caught instanceof Error ? caught.message : 'Не удалось загрузить сверку поступлений.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncOneCPayments();
      setSyncResult(result);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось получить поступления из 1С.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="onec-reconciliation-panel" aria-label="Сверка поступлений 1С">
      <header>
        <div>
          <span>Банковская выписка</span>
          <h3>Сверка поступлений из 1С</h3>
          <p>
            Точные ссылки на счёт и маркер заказа связываются первыми. Неоднозначные поступления
            требуют решения бухгалтера.
          </p>
        </div>
        <button type="button" disabled={syncing} onClick={() => void sync()}>
          {syncing ? 'Получаем…' : 'Получить поступления из 1С'}
        </button>
      </header>

      {syncResult ? (
        <p className="onec-reconciliation-sync-result" role="status">
          Импортировано: {syncResult.imported} · связано: {syncResult.matched} · предложений:{' '}
          {syncResult.proposals} · неоднозначных: {syncResult.ambiguous}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {status === 'loading' ? <p>Загружаем сверку…</p> : null}

      {status === 'ready' && receipts.length === 0 ? (
        <div className="onec-reconciliation-empty">
          <strong>Неразобранных поступлений нет</strong>
          <span>Новые строки появятся после импорта банковской выписки в 1С.</span>
        </div>
      ) : null}

      <div className="onec-reconciliation-list">
        {receipts.map((receipt) => (
          <article key={receipt.id} className="onec-reconciliation-receipt">
            <header>
              <div>
                <span>{receipt.number || 'Поступление без номера'}</span>
                <strong>{moneyLabel(receipt.amount, receipt.currency)}</strong>
              </div>
              <small>{receiptStateLabel(receipt)}</small>
            </header>
            <dl>
              <div>
                <dt>Осталось распределить</dt>
                <dd>{moneyLabel(receipt.remainingAmount, receipt.currency)}</dd>
              </div>
              <div>
                <dt>Маркер заказа</dt>
                <dd>{receipt.orderReference || 'Не указан'}</dd>
              </div>
              <div>
                <dt>Ссылка на счёт</dt>
                <dd>{receipt.invoiceNumberReference || 'Не указана'}</dd>
              </div>
            </dl>
            {Number(receipt.remainingAmount) > 0 && receipt.posted && !receipt.deleted ? (
              <ManualReceiptAllocation receipt={receipt} onResolved={load} />
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
