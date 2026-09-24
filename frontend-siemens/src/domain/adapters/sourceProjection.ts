import type { CommercialPaymentIndicator, InstallmentSchedule, OrderRawMaterial, RawMaterialStock, ShipmentStatus, WarehouseCoverProposal } from '../types';
import type {
  ActualRawMaterialStockSnapshot,
  ImportedInstallmentScheduleSnapshot,
  ImportedPaymentSnapshot,
  ImportedRawMaterialReferenceSnapshot,
  ImportedReserveRollSnapshot,
  ImportedShipmentSnapshot,
  ManualSecondaryStockSnapshot,
} from './sourceContracts';

export function externalSourceLabel(sourceKind: string) {
  if (sourceKind === 'mock_1C' || sourceKind === '1C') return 'учётный снимок';
  if (sourceKind === 'manual_platform') return 'ручной учет платформы';
  if (sourceKind === 'warehouse_runtime') return 'складской контур';
  return 'источник данных';
}

export function projectPaymentSnapshot(snapshot: ImportedPaymentSnapshot): CommercialPaymentIndicator {
  const severity = snapshot.paymentStatus === 'просрочка'
    ? 'critical'
    : snapshot.paymentStatus === 'оплачен'
      ? 'info'
      : 'warning';
  return {
    orderId: snapshot.orderId,
    paymentStatus: snapshot.paymentStatus,
    label: snapshot.paymentStatus.charAt(0).toUpperCase() + snapshot.paymentStatus.slice(1),
    severity,
    lastUpdatedAt: '08:45',
    source: snapshot.meta.sourceKind === '1C' ? '1C' : 'mock_1C',
    syncedAt: `${externalSourceLabel(snapshot.meta.sourceKind)} ${snapshot.meta.capturedAt.slice(11, 16)}`,
  };
}

export function projectRawMaterialReferenceSnapshot(snapshot: ImportedRawMaterialReferenceSnapshot): OrderRawMaterial {
  return {
    rawMaterialId: snapshot.rawMaterialId,
    label: snapshot.label,
    nominalQty: snapshot.nominalQty,
    unit: snapshot.unit,
    accountingSource: snapshot.meta.sourceKind === '1C' ? '1C_snapshot' : 'manual_reference',
    referenceSnapshotId: snapshot.meta.snapshotId,
  };
}

export function projectActualRawMaterialStock(snapshot: ActualRawMaterialStockSnapshot, reference?: ImportedRawMaterialReferenceSnapshot): RawMaterialStock {
  const hasReferenceConflict = Boolean(reference && reference.nominalQty !== snapshot.actualQty);
  return {
    id: `RAW-${snapshot.meta.snapshotId}`,
    rawMaterialId: snapshot.rawMaterialId,
    label: snapshot.label,
    materialKind: 'primary',
    qty: snapshot.actualQty,
    actualQty: snapshot.actualQty,
    unit: snapshot.unit,
    packageQty: snapshot.packageQty,
    source: snapshot.source,
    sourceOfTruthStatus: hasReferenceConflict ? 'расхождение с 1С' : 'актуально',
    updatedAt: snapshot.meta.capturedAt.slice(11, 16),
    referenceQty: reference?.nominalQty,
    referenceSource: reference ? externalSourceLabel(reference.meta.sourceKind) : undefined,
    referenceSnapshotId: reference?.meta.snapshotId,
  };
}

export function projectSecondaryRawMaterial(snapshot: ManualSecondaryStockSnapshot): RawMaterialStock {
  return {
    id: `RAW-${snapshot.meta.snapshotId}`,
    rawMaterialId: snapshot.rawMaterialId,
    label: snapshot.label,
    materialKind: 'secondary',
    qty: snapshot.qty,
    actualQty: snapshot.qty,
    unit: snapshot.unit,
    packageQty: snapshot.packageQty,
    source: 'manual_platform',
    sourceOfTruthStatus: 'ручная корректировка',
    updatedAt: snapshot.meta.importedAt.slice(11, 16),
  };
}

export function projectInstallmentSchedule(snapshot: ImportedInstallmentScheduleSnapshot): InstallmentSchedule {
  return {
    id: `INSTALLMENT-${snapshot.orderId}`,
    orderId: snapshot.orderId,
    shipmentCompletedAt: snapshot.shipmentCompletedAt,
    startRule: snapshot.startRule,
    startsAt: snapshot.startsAt,
    source: 'warehouse_delivery_mock',
  };
}

export function projectShipmentSnapshot(snapshot: ImportedShipmentSnapshot): ShipmentStatus {
  return snapshot.shipmentStatus;
}

export function projectReserveRollSnapshot(snapshot: ImportedReserveRollSnapshot): WarehouseCoverProposal['matchedRolls'][number] {
  return {
    id: snapshot.rollId,
    ownership: snapshot.ownership,
    qty: snapshot.qty,
    label: snapshot.label,
  };
}
