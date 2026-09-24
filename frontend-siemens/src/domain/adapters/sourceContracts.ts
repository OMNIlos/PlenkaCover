import type { CommercialPaymentStatus, ShipmentStatus, WarehouseRollOwnership } from '../types';

export type ExternalSourceKind = '1C' | 'mock_1C' | 'manual_platform' | 'warehouse_runtime';

export type SourceSnapshotMeta = {
  sourceKind: ExternalSourceKind;
  sourceName: string;
  snapshotId: string;
  capturedAt: string;
  importedAt: string;
  sourceOwnerRole: 'finance' | 'warehouse' | 'admin' | 'system';
};

export type ImportedPaymentSnapshot = {
  orderId: string;
  invoiceId?: string;
  paymentStatus: CommercialPaymentStatus;
  amountTotal?: string;
  amountPaid?: string;
  amountRemaining?: string;
  paymentDueAt?: string;
  meta: SourceSnapshotMeta;
};

export type ImportedInvoiceSnapshot = {
  orderId: string;
  invoiceId: string;
  invoiceStatus: 'not_issued' | 'issued' | 'sent' | 'cancelled';
  amountTotal?: string;
  meta: SourceSnapshotMeta;
};

export type ImportedRawMaterialReferenceSnapshot = {
  rawMaterialId: string;
  label: string;
  nominalQty: number;
  unit: string;
  accountingLabel?: string;
  meta: SourceSnapshotMeta;
};

export type ActualRawMaterialStockSnapshot = {
  rawMaterialId: string;
  label: string;
  actualQty: number;
  unit: string;
  packageQty?: string;
  source: 'warehouse_fact' | 'manual_platform' | 'mock';
  meta: SourceSnapshotMeta;
};

export type ManualSecondaryStockSnapshot = {
  rawMaterialId: string;
  label: string;
  materialKind: 'secondary';
  qty: number;
  unit: string;
  packageQty?: string;
  lastMovementId?: string;
  meta: SourceSnapshotMeta;
};

export type ImportedShipmentSnapshot = {
  orderId: string;
  shipmentStatus: ShipmentStatus;
  completedAt?: string;
  warehouseTaskId?: string;
  meta: SourceSnapshotMeta;
};

export type ImportedReserveRollSnapshot = {
  orderId?: string;
  rollId: string;
  qty: number;
  label: string;
  ownership: WarehouseRollOwnership;
  meta: SourceSnapshotMeta;
};

export type ImportedInstallmentScheduleSnapshot = {
  orderId: string;
  shipmentCompletedAt: string;
  startRule: 'shipment_plus_1_day';
  startsAt: string;
  meta: SourceSnapshotMeta;
};
