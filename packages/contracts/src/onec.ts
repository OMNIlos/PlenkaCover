import type { SourceKind } from './events';

export const ONEC_ORDER_REFERENCE_PREFIX = 'PLENKA_ORDER=';

/** Stable exact marker copied into the configured 1С invoice field. */
export function oneCOrderReference(orderNumber: string): string {
  return `${ONEC_ORDER_REFERENCE_PREFIX}${orderNumber.trim()}`;
}

export const ONEC_INVOICE_SYNC_STATES = [
  'not_synced',
  'not_found',
  'draft_found',
  'posted',
  'ambiguous',
  'stale',
  'error',
] as const;
export type OneCInvoiceSyncState = (typeof ONEC_INVOICE_SYNC_STATES)[number];

/** Which 1С subject a snapshot describes (ТЗ §8, S6). */
export const ONEC_SUBJECT_TYPES = [
  'counterparty',
  'nomenclature',
  'organization',
  'warehouse',
  'invoice',
  'payment',
  'shipment',
  'stock',
  'production_report',
  'production_output_line',
  'production_material_line',
] as const;
export type OneCSubjectType = (typeof ONEC_SUBJECT_TYPES)[number];

/** fresh right after a good GET; stale on version-change/TTL/failed fetch; unknown = never fetched. */
export type OneCStaleness = 'fresh' | 'stale' | 'unknown';

export const ONEC_HEALTH_STATUSES = ['ready', 'degraded', 'unavailable'] as const;
export type OneCHealthStatus = (typeof ONEC_HEALTH_STATUSES)[number];

export interface OneCHealthResult {
  mode: 'mock' | 'http';
  status: OneCHealthStatus;
  checkedAt: string;
  latencyMs: number;
  endpointLabel?: string;
  errorCategory?: 'config' | 'auth' | 'timeout' | 'network' | 'http';
  message?: string;
}

/**
 * Generic 1С source snapshot — evidence, not proof of live sync (ТЗ §8).
 * `rawPayload` is ADMIN-DIAGNOSTICS ONLY; business projections expose only `parsed` + metadata.
 * `externalId` = 1С `Ref_Key`; `sourceVersion` = 1С `DataVersion`.
 */
export interface OneCSnapshot<TParsed> {
  sourceKind: SourceKind;
  subjectType: OneCSubjectType;
  externalId: string | null;
  sourceVersion: string | null;
  staleness: OneCStaleness;
  capturedAt: string;
  parsed: TParsed;
  rawPayload: unknown;
}

/** Catalog_Контрагенты → counterparty. */
export interface OneCCounterpartyParsed {
  displayName: string;
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  code: string | null;
  deleted?: boolean;
}

/** Catalog_Номенклатура → exact 1С catalog identity and display values. */
export interface OneCNomenclatureParsed {
  code: string;
  article: string | null;
  name: string;
  fullName: string | null;
  kindExternalId: string | null;
  kindName: string | null;
  unitExternalId: string | null;
  unitName: string | null;
  deleted: boolean;
  archived: boolean;
}

/** Catalog_Организации → source catalog; it does not replace ERP tenant identity. */
export interface OneCOrganizationParsed {
  code: string;
  name: string;
  fullName: string | null;
  inn: string | null;
  kpp: string | null;
  deleted: boolean;
}

/** Catalog_Склады → source catalog; it does not replace physical ERP post topology. */
export interface OneCWarehouseParsed {
  code: string;
  name: string;
  warehouseType: string | null;
  deleted: boolean;
}

/** Document_СчетНаОплатуПокупателю → customer invoice (счёт). */
export interface OneCInvoiceParsed {
  invoiceNo: string;
  date: string | null;
  total: number;
  currency: string;
  counterpartyExternalId: string | null;
  posted: boolean;
  orderReference?: string | null;
  subtotal?: number | null;
  taxTotal?: number | null;
  organizationExternalId?: string | null;
  currencyExternalId?: string | null;
  deleted?: boolean;
  lines?: OneCInvoiceLineParsed[];
}

export interface OneCInvoiceLineParsed {
  lineNumber: number;
  nomenclatureExternalId: string | null;
  name: string | null;
  quantity: number;
  price: number;
  amount: number;
  unitExternalId: string | null;
  taxRate?: string | null;
  taxAmount?: number | null;
}

export interface OneCInvoiceLineSource {
  invoiceExternalId: string;
  parsed: OneCInvoiceLineParsed;
  rawPayload: unknown;
}

/** Document_ПоступлениеНаРасчетныйСчет → incoming payment. */
export interface OneCPaymentParsed {
  number: string;
  date: string | null;
  amount: number;
  currency?: string | null;
  counterpartyExternalId: string | null;
  posted: boolean;
  orderReference?: string | null;
  organizationExternalId?: string | null;
  documentBasisExternalId?: string | null;
  documentBasisType?: string | null;
  invoiceExternalId?: string | null;
  invoiceNumberReference?: string | null;
  deleted?: boolean;
}

/** Document_РеализацияТоваровУслуг → shipment (реализация). */
export interface OneCShipmentParsed {
  number: string;
  date: string | null;
  total: number;
  counterpartyExternalId: string | null;
  posted: boolean;
  organizationExternalId?: string | null;
  invoiceExternalId?: string | null;
  deleted?: boolean;
  lines?: OneCShipmentLineParsed[];
}

export interface OneCShipmentLineParsed {
  lineNumber: number;
  nomenclatureExternalId: string | null;
  name: string | null;
  quantity: number;
  price: number;
  amount: number;
  unitExternalId: string | null;
}

export interface OneCShipmentLineSource {
  shipmentExternalId: string;
  parsed: OneCShipmentLineParsed;
  rawPayload: unknown;
}

/** AccountingRegister_Хозрасчетный/Balance → stock/balance row. */
export interface OneCStockParsed {
  account: string | null;
  accountCode?: string | null;
  organizationExternalId?: string | null;
  nomenclatureExternalId?: string | null;
  qty: number;
  amount: number;
  subconto: string[];
}

export interface OneCProductionReportParsed {
  number: string;
  date: string | null;
  posted: boolean;
  deleted: boolean;
  organizationExternalId: string | null;
  warehouseExternalId: string | null;
  departmentExternalId: string | null;
}

export interface OneCProductionLineParsed {
  lineNumber: number;
  nomenclatureExternalId: string | null;
  unitExternalId: string | null;
  unitName: string | null;
  quantity: number;
}

export interface OneCProductionOutputLineParsed extends OneCProductionLineParsed {}

export interface OneCProductionMaterialLineParsed extends OneCProductionLineParsed {
  productExternalId: string | null;
}

export type OneCCounterpartySnapshot = OneCSnapshot<OneCCounterpartyParsed>;
export type OneCNomenclatureSnapshot = OneCSnapshot<OneCNomenclatureParsed>;
export type OneCOrganizationSnapshot = OneCSnapshot<OneCOrganizationParsed>;
export type OneCWarehouseSnapshot = OneCSnapshot<OneCWarehouseParsed>;
export type OneCInvoiceSnapshot = OneCSnapshot<OneCInvoiceParsed>;
export type OneCPaymentSnapshot = OneCSnapshot<OneCPaymentParsed>;
export type OneCShipmentSnapshot = OneCSnapshot<OneCShipmentParsed>;
export type OneCStockSnapshot = OneCSnapshot<OneCStockParsed>;
export type OneCProductionReportSnapshot = OneCSnapshot<OneCProductionReportParsed>;

export interface OneCProductionOutputLineSource {
  reportExternalId: string;
  parsed: OneCProductionOutputLineParsed;
  rawPayload: unknown;
}

export interface OneCProductionMaterialLineSource {
  reportExternalId: string;
  parsed: OneCProductionMaterialLineParsed;
  rawPayload: unknown;
}
