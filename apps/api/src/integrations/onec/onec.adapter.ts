import type {
  OneCCounterpartySnapshot,
  OneCHealthResult,
  OneCInvoiceSnapshot,
  OneCInvoiceLineSource,
  OneCNomenclatureSnapshot,
  OneCOrganizationSnapshot,
  OneCPaymentSnapshot,
  OneCProductionMaterialLineSource,
  OneCProductionOutputLineSource,
  OneCProductionReportSnapshot,
  OneCShipmentSnapshot,
  OneCShipmentLineSource,
  OneCStockSnapshot,
  OneCWarehouseSnapshot,
} from '@plenka/contracts';

export type {
  OneCCounterpartySnapshot,
  OneCInvoiceSnapshot,
  OneCInvoiceLineSource,
  OneCNomenclatureSnapshot,
  OneCOrganizationSnapshot,
  OneCPaymentSnapshot,
  OneCProductionMaterialLineSource,
  OneCProductionOutputLineSource,
  OneCProductionReportSnapshot,
  OneCShipmentSnapshot,
  OneCShipmentLineSource,
  OneCStockSnapshot,
  OneCWarehouseSnapshot,
};

/** Pagination for list pulls (ТЗ §11.8; OData `$top`/`$skip`). */
export interface OneCListOptions {
  top?: number;
  skip?: number;
}

/** One stock line for the single platform → 1С write (остатки по сырью/рулонам). */
export interface OneCStockItem {
  materialId: string;
  externalId?: string | null;
  qty: number;
  unit: string;
}

/** Business-safe acknowledgement for the separately gated, human-confirmed stock posting. */
export interface OneCStockPushAck {
  accepted: boolean;
  mode: 'mock' | 'http';
  documentCreated: boolean;
  count: number;
  ref: string;
}

/** Static, secret-free write configuration exposed for a fail-closed readiness check. */
export interface OneCStockPushConfiguration {
  mode: 'mock' | 'http';
  enabled: boolean;
}

/**
 * 1С integration contract (ТЗ §11.8, §12.1). Platform is ≈ read-only (product owner, 2026-07-02):
 * counterparties / invoices / payments / shipments are READ from 1С and reconciled by `externalId`
 * (`Ref_Key`). The ONLY write is the demo stock posting (`pushStock`), protected by live/write
 * gates and a human confirmation flow. Snapshots are EVIDENCE, not proof of live sync (ТЗ §8) —
 * `rawPayload` stays admin-diagnostics only.
 */
export interface OneCAdapter {
  stockPushConfiguration(): OneCStockPushConfiguration;
  checkHealth(): Promise<OneCHealthResult>;
  pullCounterparty(externalId: string): Promise<OneCCounterpartySnapshot>;
  pullCounterparties(opts?: OneCListOptions): Promise<OneCCounterpartySnapshot[]>;
  pullNomenclature(opts?: OneCListOptions): Promise<OneCNomenclatureSnapshot[]>;
  pullOrganizations(opts?: OneCListOptions): Promise<OneCOrganizationSnapshot[]>;
  pullWarehouses(opts?: OneCListOptions): Promise<OneCWarehouseSnapshot[]>;
  /** `orderRefOrExternalId` keeps the pre-S6 call site (finance passes commercialOrderId). */
  pullInvoice(orderRefOrExternalId: string): Promise<OneCInvoiceSnapshot>;
  findInvoicesByOrderReference(orderReference: string): Promise<OneCInvoiceSnapshot[]>;
  findInvoicesByExactNumber(invoiceNumber: string): Promise<OneCInvoiceSnapshot[]>;
  pullInvoiceByExternalId(externalId: string): Promise<OneCInvoiceSnapshot>;
  pullInvoices(opts?: OneCListOptions): Promise<OneCInvoiceSnapshot[]>;
  pullInvoiceLines(opts?: OneCListOptions): Promise<OneCInvoiceLineSource[]>;
  pullPayments(opts?: OneCListOptions): Promise<OneCPaymentSnapshot[]>;
  pullPaymentByExternalId(externalId: string): Promise<OneCPaymentSnapshot>;
  pullShipments(opts?: OneCListOptions): Promise<OneCShipmentSnapshot[]>;
  pullShipmentLines(opts?: OneCListOptions): Promise<OneCShipmentLineSource[]>;
  pullProductionReports(opts?: OneCListOptions): Promise<OneCProductionReportSnapshot[]>;
  pullProductionOutputLines(opts?: OneCListOptions): Promise<OneCProductionOutputLineSource[]>;
  pullProductionMaterialLines(opts?: OneCListOptions): Promise<OneCProductionMaterialLineSource[]>;
  pullBalances(
    accountCode: '10.01' | '41.01',
    opts?: OneCListOptions,
  ): Promise<OneCStockSnapshot[]>;
  pullStock(opts?: OneCListOptions): Promise<OneCStockSnapshot[]>;
  pushStock(items: OneCStockItem[]): Promise<OneCStockPushAck>;
}

/** DI token for the active OneCAdapter implementation. */
export const ONEC_ADAPTER = 'ONEC_ADAPTER';
