import type { PaymentOperationEntry, WorkObject } from '../../domain/types';
import { financePaymentSourceLabel } from '../../domain/financePaymentSources';
import { visibleAuditAction } from '../shell/viewPrimitives';
import { moneyDraftLabel } from './financeMoney';

function importedPaymentHistory(object: WorkObject): PaymentOperationEntry[] {
  const payments = (object.financePaymentTimeline ?? []).map((entry) => ({
    id: entry.id,
    label: entry.reversesId ? 'Возврат или компенсация поступления' : 'Подтверждённое поступление',
    amountLabel: moneyDraftLabel(Number(entry.amount)),
    dateLabel: entry.receivedAt
      ? new Date(entry.receivedAt).toLocaleDateString('ru-RU')
      : undefined,
    source: [
      entry.receiptNumber,
      entry.matchKind === 'invoice_ref'
        ? 'точная ссылка на счёт'
        : entry.matchKind === 'order_marker'
          ? 'маркер заказа'
          : entry.matchKind
            ? 'сопоставлено с заказом'
            : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  const corrections = (object.financePaymentCorrections ?? []).map((entry) => ({
    id: entry.id,
    label: 'Оплата скорректирована',
    amountLabel: '',
    dateLabel: new Date(entry.createdAt).toLocaleDateString('ru-RU', {
      timeZone: 'Europe/Moscow',
    }),
    source: `${entry.actorRole} · ${entry.reason}`,
  }));
  return [...payments, ...corrections];
}

export function financePaymentHistory(object: WorkObject): PaymentOperationEntry[] {
  const imported = importedPaymentHistory(object);
  const importedAllocationIds = new Set(
    (object.financePaymentTimeline ?? []).map((entry) => entry.id),
  );
  const seenIds = new Set(imported.map((entry) => entry.id));
  const independentOperations = (object.paymentOperations ?? [])
    .filter((operation) => {
      if (operation.allocationId && importedAllocationIds.has(operation.allocationId)) {
        return false;
      }
      if (seenIds.has(operation.id)) return false;
      seenIds.add(operation.id);
      return true;
    })
    .map((operation) => ({
      ...operation,
      source: financePaymentSourceLabel(operation.source),
    }));
  const confirmedHistory = [...imported, ...independentOperations];
  if (confirmedHistory.length) return confirmedHistory;

  return object.audit
    .filter((entry) => /оплат|плат[её]ж|счет/i.test(`${entry.actionLabel} ${entry.detail}`))
    .map((entry) => ({
      id: entry.id,
      label: visibleAuditAction(entry.actionLabel),
      amountLabel: '',
      dateLabel: entry.time,
      source: entry.actorLabel,
    }));
}
