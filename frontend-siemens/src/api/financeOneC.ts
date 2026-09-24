import type { FinanceInvoiceView, OneCInvoiceSyncState } from '../domain/types';
import { apiGet, apiPost } from './client';

export type OneCInvoiceSyncResult = {
  financeOrderId: string;
  orderReference: string;
  invoiceSyncState: OneCInvoiceSyncState;
  candidateCount: number;
  candidates: Array<{
    externalId: string;
    sourceVersion: string;
    invoiceNumber?: string | null;
    date?: string | null;
    amount: string;
    currency?: string | null;
    posted: boolean;
    deleted: boolean;
  }>;
  invoice: FinanceInvoiceView | null;
};

export type OneCPaymentSyncResult = {
  imported: number;
  matched: number;
  autoApplied: number;
  proposals: number;
  ambiguous: number;
  unmatched: number;
  reversed: number;
  skipped: number;
  replayed: boolean;
};

export type FinanceReconciliationAllocation = {
  id: string;
  financeOrderId: string;
  scheduleId?: string | null;
  amount: string;
  status: string;
  matchKind?: string | null;
  reversesId?: string | null;
  createdAt: string;
};

export type FinanceReconciliationItem = {
  id: string;
  externalId: string;
  sourceVersion: string;
  number?: string | null;
  receivedAt?: string | null;
  amount: string;
  allocatedAmount: string;
  remainingAmount: string;
  currency: string;
  counterpartyExternalId?: string | null;
  invoiceExternalId?: string | null;
  invoiceNumberReference?: string | null;
  orderReference?: string | null;
  posted: boolean;
  deleted: boolean;
  sourceStatus: string;
  matchState: string;
  matchKind?: string | null;
  candidateFinanceOrderIds: string[];
  capturedAt: string;
  allocations: FinanceReconciliationAllocation[];
};

export function refreshOneCInvoice(
  financeOrderId: string,
  operationKey = crypto.randomUUID(),
): Promise<OneCInvoiceSyncResult> {
  return apiPost<OneCInvoiceSyncResult>(
    `/api/finance/orders/${encodeURIComponent(financeOrderId)}/source-retry`,
    { operationKey },
  );
}

export function syncOneCPayments(
  operationKey = crypto.randomUUID(),
): Promise<OneCPaymentSyncResult> {
  return apiPost<OneCPaymentSyncResult>('/api/finance/payment-source-sync', {
    operationKey,
  });
}

export function fetchFinanceReconciliation(): Promise<FinanceReconciliationItem[]> {
  return apiGet<FinanceReconciliationItem[]>('/api/finance/reconciliation');
}

export function resolveFinancePaymentAllocation(
  receiptId: string,
  dto: {
    operationKey: string;
    reason: string;
    allocations: Array<{ financeOrderId: string; amount: number }>;
  },
): Promise<Array<Record<string, unknown>>> {
  return apiPost<Array<Record<string, unknown>>>(
    `/api/finance/payment-allocations/${encodeURIComponent(receiptId)}/resolve`,
    dto,
  );
}
