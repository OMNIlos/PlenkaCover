import type {
  ActualRawMaterialStockSnapshot,
  ImportedInstallmentScheduleSnapshot,
  ImportedInvoiceSnapshot,
  ImportedPaymentSnapshot,
  ImportedRawMaterialReferenceSnapshot,
  ImportedReserveRollSnapshot,
  ImportedShipmentSnapshot,
  ManualSecondaryStockSnapshot,
  SourceSnapshotMeta,
} from './sourceContracts';

const importedAt = '2026-06-11T08:45:00+05:00';

function meta(snapshotId: string, sourceOwnerRole: SourceSnapshotMeta['sourceOwnerRole']): SourceSnapshotMeta {
  return {
    sourceKind: 'mock_1C',
    sourceName: 'учётный снимок',
    snapshotId,
    capturedAt: '2026-06-11T08:40:00+05:00',
    importedAt,
    sourceOwnerRole,
  };
}

function warehouseMeta(snapshotId: string): SourceSnapshotMeta {
  return {
    sourceKind: 'warehouse_runtime',
    sourceName: 'складской контур',
    snapshotId,
    capturedAt: '2026-06-11T08:42:00+05:00',
    importedAt,
    sourceOwnerRole: 'warehouse',
  };
}

export const importedPaymentSnapshots: ImportedPaymentSnapshot[] = [
  { orderId: 'З-2606-019', invoiceId: 'INV-2606-019', paymentStatus: 'частично оплачен', amountTotal: '1 284 000 ₽', amountPaid: '640 000 ₽', amountRemaining: '644 000 ₽', paymentDueAt: '2026-06-13', meta: meta('1C-PAY-2606-019', 'finance') },
  { orderId: 'З-2606-017', invoiceId: 'INV-2606-017', paymentStatus: 'не оплачен', amountTotal: '460 000 ₽', amountPaid: '0 ₽', amountRemaining: '460 000 ₽', paymentDueAt: '2026-06-14', meta: meta('1C-PAY-2606-017', 'finance') },
  { orderId: 'З-2606-018', invoiceId: 'INV-2606-018', paymentStatus: 'просрочка', amountTotal: '720 000 ₽', amountPaid: '0 ₽', amountRemaining: '720 000 ₽', paymentDueAt: '2026-06-08', meta: meta('1C-PAY-2606-018', 'finance') },
  { orderId: 'З-2606-020', invoiceId: 'INV-2606-020', paymentStatus: 'оплачен', amountTotal: '240 000 ₽', amountPaid: '240 000 ₽', amountRemaining: '0 ₽', paymentDueAt: '2026-06-01', meta: meta('1C-PAY-2606-020', 'finance') },
  { orderId: 'ЗН-2606-025', invoiceId: 'INV-2606-025', paymentStatus: 'частично оплачен', amountTotal: '920 000 ₽', amountPaid: '300 000 ₽', amountRemaining: '620 000 ₽', paymentDueAt: '2026-07-03', meta: meta('1C-PAY-2606-025', 'finance') },
  { orderId: 'ЗН-2606-021', invoiceId: 'INV-2606-021', paymentStatus: 'просрочка', amountTotal: '420 000 ₽', amountPaid: '0 ₽', amountRemaining: '420 000 ₽', paymentDueAt: '2026-06-04', meta: meta('1C-PAY-2606-021', 'finance') },
];

export const importedInvoiceSnapshots: ImportedInvoiceSnapshot[] = [
  { orderId: 'З-2606-019', invoiceId: 'INV-2606-019', invoiceStatus: 'sent', amountTotal: '1 284 000 ₽', meta: meta('1C-INV-2606-019', 'finance') },
  { orderId: 'З-2606-020', invoiceId: 'INV-2606-020', invoiceStatus: 'issued', amountTotal: '240 000 ₽', meta: meta('1C-INV-2606-020', 'finance') },
  { orderId: 'ЗН-2606-025', invoiceId: 'INV-2606-025', invoiceStatus: 'issued', amountTotal: '920 000 ₽', meta: meta('1C-INV-2606-025', 'finance') },
  { orderId: 'ЗН-2606-021', invoiceId: 'INV-2606-021', invoiceStatus: 'issued', amountTotal: '420 000 ₽', meta: meta('1C-INV-2606-021', 'finance') },
];

export const importedRawMaterialReferenceSnapshots: ImportedRawMaterialReferenceSnapshot[] = [
  { rawMaterialId: 'ПВД-15803-020', label: 'ПВД 15803-020', nominalQty: 1240, unit: 'кг', accountingLabel: 'Учётный остаток', meta: meta('1C-RAW-15803', 'warehouse') },
  { rawMaterialId: 'ПВД-10803-020', label: 'ПВД 10803-020', nominalQty: 680, unit: 'кг', accountingLabel: 'Учётный остаток', meta: meta('1C-RAW-10803', 'warehouse') },
];

export const actualRawMaterialStockSnapshots: ActualRawMaterialStockSnapshot[] = [
  { rawMaterialId: 'ПВД-15803-020', label: 'ПВД 15803-020', actualQty: 1186, unit: 'кг', packageQty: 'мешки 25 кг', source: 'warehouse_fact', meta: warehouseMeta('WH-RAW-15803') },
  { rawMaterialId: 'ПВД-10803-020', label: 'ПВД 10803-020', actualQty: 60, unit: 'кг', packageQty: 'мешки 25 кг', source: 'warehouse_fact', meta: warehouseMeta('WH-RAW-10803') },
];

export const manualSecondaryStockSnapshots: ManualSecondaryStockSnapshot[] = [
  {
    rawMaterialId: 'ВТОР-РЕГРАН-01',
    label: 'Вторичка регранулят прозрачный',
    materialKind: 'secondary',
    qty: 310,
    unit: 'кг',
    packageQty: 'биг-бег',
    lastMovementId: 'MOV-SEC-2606-001',
    meta: { ...meta('PLATFORM-SEC-REGRAN-01', 'warehouse'), sourceKind: 'manual_platform', sourceName: 'ручной учет платформы' },
  },
];

export const importedShipmentSnapshots: ImportedShipmentSnapshot[] = [
  { orderId: 'З-2606-020', shipmentStatus: 'отгружено', completedAt: '2026-06-01T13:30:00+05:00', warehouseTaskId: 'WH-2606-048', meta: meta('1C-SHIP-2606-020', 'warehouse') },
];

export const importedReserveRollSnapshots: ImportedReserveRollSnapshot[] = [
  { orderId: 'З-2606-019', rollId: 'WHR-Z-2606-019-P1-01', qty: 1, label: 'Рукав, 80 мкм, шпуля 76 мм', ownership: 'free_reserve', meta: { ...meta('PLATFORM-RESERVE-2606-019', 'warehouse'), sourceKind: 'warehouse_runtime', sourceName: 'складской контур' } },
];

export const importedInstallmentScheduleSnapshots: ImportedInstallmentScheduleSnapshot[] = [
  { orderId: 'З-2606-020', shipmentCompletedAt: '2026-06-01T13:30:00+05:00', startRule: 'shipment_plus_1_day', startsAt: '2026-06-02', meta: { ...meta('PLATFORM-INSTALLMENT-2606-020', 'finance'), sourceKind: 'warehouse_runtime', sourceName: 'закрытая отгрузка склада' } },
];

export function paymentSnapshotByOrder(orderId: string) {
  return importedPaymentSnapshots.find((snapshot) => snapshot.orderId === orderId);
}

export function shipmentSnapshotByOrder(orderId: string) {
  return importedShipmentSnapshots.find((snapshot) => snapshot.orderId === orderId);
}

export function reserveRollSnapshotsByOrder(orderId: string) {
  return importedReserveRollSnapshots.filter((snapshot) => snapshot.orderId === orderId);
}
