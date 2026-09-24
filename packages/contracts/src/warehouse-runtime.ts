import type { ScanStatus, WarehouseCoverStatus } from './statuses';
import type { PalletLabelLayoutPublication } from './pallet-label-layout';

/** Pallet-label profiles supported by the physical gateway transport. */
export const PALLET_LABEL_PROFILES = ['pallet-100x150-v1', 'pallet-100x150-compact-v2'] as const;

/** Immutable snapshots supported by the API; 100x100 profiles are browser-only. */
export const PALLET_LABEL_SNAPSHOT_PROFILES = [
  ...PALLET_LABEL_PROFILES,
  'pallet-100x100-square-v4',
  'pallet-100x100-safe-v5',
  'pallet-100x100-extended-v6',
  'pallet-100x100-configurable-v7',
] as const;
export type PalletLabelProfile = (typeof PALLET_LABEL_PROFILES)[number];
export type PalletLabelSnapshotProfile = (typeof PALLET_LABEL_SNAPSHOT_PROFILES)[number];

export type WarehouseRollSource =
  | 'warehouse_reserve'
  | 'production_handover'
  | 'production_pending';

export type WarehouseRollOwnership =
  | 'customer_owned'
  | 'free_reserve'
  | 'reserved_for_order'
  | 'shipped';

export type WarehouseQrRollView = {
  rollCode: string;
  orderId: string | null;
  orderNumber: string | null;
  customerAlias: string | null;
  requestCreatedAt: string | null;
  readyForShipmentAt: string | null;
  shipmentCompletedAt: string | null;
  sequence: number | null;
  plannedKg: number | null;
  spoolKg: number | null;
  grossKg: number | null;
  netKg: number | null;
  toleranceOk: boolean | null;
  filmType: string | null;
  actualThickness: string | null;
  accountingThickness: string | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  spoolType: string | null;
  birka: string | null;
  productionStatus: string;
  warehouseStatus: string;
  producedAt: string | null;
  receivedAt: string | null;
};

export type WarehouseQrBigBagView = {
  id: string;
  code: string;
  material: string;
  status: string;
  registrationStatus: string;
  location: string;
  initialKg: number | null;
  currentKg: number | null;
  lastMeasuredKg: number | null;
  lastMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceEffectiveAt: string | null;
  createdAt: string;
};

export type WarehouseQrPalletView = {
  palletCode: string;
  status: WarehousePalletStatus | null;
  /** Immutable document lifecycle; a voided label remains traceable but is not current. */
  documentStatus: 'sealed' | 'voided';
  materialMark: string;
  productNames: string[];
  article: string | null;
  rollCount: number;
  packagingMaterial: string | null;
  packagingCount: number | null;
  netKg: number;
  grossKg: number | null;
  productionDate: string | null;
  shelfLifeMonths: number | null;
  deliveryDate: string | null;
  storageConditions: string | null;
  orderNumbers: string[];
  customerAliases: string[];
  /** Ordered immutable pallet composition; empty only for legacy documents without row facts. */
  rollCodes: string[];
  createdAt: string;
  sealedAt: string | null;
};

/**
 * A read-only warehouse QR inspection. The opaque scanned token is deliberately absent:
 * it is an internal credential-like identifier and must never enter a role projection.
 */
export type WarehouseQrInspection =
  | {
      kind: 'roll';
      roll: WarehouseQrRollView;
      inspectedAt: string;
    }
  | {
      kind: 'big_bag';
      bigBag: WarehouseQrBigBagView;
      inspectedAt: string;
    }
  | {
      kind: 'pallet';
      pallet: WarehouseQrPalletView;
      inspectedAt: string;
    };

/**
 * Warehouse intake (Приёмка) read-model — design 2026-07-13 §9. Real roll data joined
 * from the operator contour; the warehouse sees the customer ALIAS only (ТЗ §4).
 */
export type WarehouseIntakeRollView = {
  /** Stable persisted ScanRow.id used by task-scoped warehouse commands. */
  scanRowId: string;
  rollCode: string;
  orderId: string | null;
  orderNumber: string | null;
  /** Stable commercial order-line identity; sequence alone is not an identity. */
  orderLineId: string | null;
  customerAlias: string | null;
  sequence: number;
  planKg: number | null;
  netKg: number | null;
  grossKg: number | null;
  characteristics: {
    filmType?: string | null;
    materialMark?: string | null;
    sizeMeters?: string | null;
    actualThickness?: string | null;
    lengthMeters?: string | null;
    spoolType?: string | null;
    article?: string | null;
    packagingMaterial?: string | null;
    packagingCount?: number | null;
    deliveryDate?: string | null;
  } | null;
  source: WarehouseRollSource;
  ownership: WarehouseRollOwnership;
  operatorLabel: string | null;
  machineLabel: string | null;
  productionStatus: string;
  producedAt: string | null;
  scanStatus: ScanStatus;
  warehouseState: string;
  scannedByName: string | null;
  /** Server-owned pallet-membership fact; clients must not infer it from scan state. */
  palletSelection: WarehousePalletSelectionView;
};

export type WarehouseIntakeTaskStatus =
  | 'accepted' // принято (задача закрыта)
  | 'has_defect' // брак
  | 'has_reserve' // резерв + производство
  | 'awaiting_rolls' // рулоны ещё не переданы на склад
  | 'pallet_open' // всё отсканировано, палета не закрыта
  | 'scanning'; // в работе

export type WarehousePalletStatus = 'open' | 'sealed' | 'voided';

export type SetPalletSelectionRequest = {
  operationKey: string;
  selected: boolean;
};

export type WarehousePalletVoidReasonCode = 'wrong_composition' | 'print_problem' | 'other';

export const WAREHOUSE_PALLET_VOID_NOTE_MAX_LENGTH = 500;

export type VoidPalletRequest = {
  operationKey: string;
  reasonCode: WarehousePalletVoidReasonCode;
  /** At most WAREHOUSE_PALLET_VOID_NOTE_MAX_LENGTH characters. */
  note?: string;
};

export type WarehousePalletItemView = {
  rollCode: string;
  position: number;
  acceptedAt: string;
  scannedByName: string | null;
};

export type WarehousePalletSelectionView = {
  selected: boolean;
  locked: boolean;
  palletId: string | null;
  palletCode: string | null;
};

export type WarehousePalletView = {
  id: string;
  palletCode: string;
  orderId: string;
  orderNumber: string;
  sequenceNo: number;
  status: WarehousePalletStatus;
  rollCount: number;
  openedAt: string;
  rows: WarehousePalletItemView[];
};

/** Maximum pallet rows carried by the pallet-selection command response and idempotency snapshot. */
export const WAREHOUSE_PALLET_SELECTION_ROW_LIMIT = 100;

export type WarehousePalletSelectionPalletView = Omit<WarehousePalletView, 'rollCount' | 'rows'> & {
  /** Total active rolls on the pallet; rows contains only the first bounded page. */
  totalCount: number;
  hasMore: boolean;
  rows: WarehousePalletItemView[];
};

export type WarehousePalletSelectionResult = {
  selectionChanged: boolean;
  activePallet: WarehousePalletSelectionPalletView | null;
};

export type WarehousePalletSelectionScanOutcome = 'added' | 'already_selected';

export type WarehousePalletSelectionScanResult = {
  operationKey: string;
  taskId: string;
  scanRowId: string;
  rollCode: string;
  outcome: WarehousePalletSelectionScanOutcome;
  activePallet: WarehousePalletSelectionPalletView;
};

export type WarehousePalletHandoffScanResult = {
  operationKey: string;
  documentId: string;
  palletId: string;
  palletCode: string;
  orderId: string;
  deliveryTaskId: string;
  deliveryCreated: boolean;
  rollCount: number;
  replayed: boolean;
};

export type WarehousePalletDeliveryScanResult = {
  operationKey: string;
  documentId: string;
  palletId: string;
  palletCode: string;
  orderId: string;
  deliveryTaskId: string;
  rollCount: number;
  newlyDeliveredRollCount: number;
  alreadyDeliveredRollCount: number;
  remainingRollCount: number;
  taskStatus: 'open' | 'partial' | 'closed';
  deliveryClosed: boolean;
  replayed: boolean;
};

export type WarehousePalletDocumentSummary = {
  id: string;
  palletId: string;
  warehousePalletId: string | null;
  origin: 'legacy' | 'physical_pallet';
  createdAt: string;
  templateVersion: PalletLabelSnapshotProfile;
  /** Server-owned document lifecycle; voided labels stay visible only as history. */
  documentStatus: 'sealed' | 'voided';
  printReady: boolean;
  printStatus: 'not_printed' | 'submitted' | 'failed' | 'needs_admin';
  rollCount: number;
  /** First bounded page of immutable printed composition; warehouse projection only. */
  rollCodes: string[];
  rollCodesHasMore: boolean;
  orderId: string | null;
};

export type WarehousePalletHistoryPage = {
  activePallet: WarehousePalletView | null;
  items: WarehousePalletDocumentSummary[];
  nextCursor: string | null;
};

export type WarehouseIntakeTaskView = {
  taskId: string;
  /** «Название операции» с датой и порядковым номером: ПР-ДДММ-NN. */
  operationCode: string | null;
  orderNumbers: string[];
  customerAliases: string[];
  orderNumber: string | null;
  customerAlias: string | null;
  status: WarehouseIntakeTaskStatus;
  /** Full commercial-order plan; independent from rolls already handed over to the warehouse. */
  plannedRollCount: number;
  expected: number;
  accepted: number;
  errors: number;
  closable: boolean;
  lastScanResult: {
    rollCode: string | null;
    scanStatus: ScanStatus;
    scannedAt: string;
  } | null;
  rolls: WarehouseIntakeRollView[];
  activePallet: WarehousePalletView | null;
  palletHistory: WarehousePalletDocumentSummary[];
  palletHistoryHasMore: boolean;
  palletList: {
    id: string;
    createdAt: string;
    templateVersion: PalletLabelSnapshotProfile;
    printReady: boolean;
    printStatus: 'not_printed' | 'submitted' | 'failed' | 'needs_admin';
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type WarehouseIntakeStats = {
  /** Скан-операции за сегодня. */
  todayOps: number;
  /** Осталось QR по открытым задачам. */
  remainingQr: number;
  /** Ошибки скана за сегодня (wrong / duplicate / excess). */
  errors: number;
};

export type WarehouseIntake = {
  stats: WarehouseIntakeStats;
  tasks: WarehouseIntakeTaskView[];
  generatedAt: string;
};

type PalletLabelSnapshotBase = {
  palletId: string;
  materialMark: string;
  productNames: string[];
  article: string | null;
  rollCount: number;
  packagingMaterial: string | null;
  packagingCount: number | null;
  netKg: number;
  grossKg: number | null;
  productionDate: string | null;
  shelfLifeMonths: 12;
  deliveryDate: string | null;
  storageConditions: string;
  orderNumbers: string[];
  customerAliases: string[];
  createdAt: string;
};

export type LegacyPalletLabelSnapshot = PalletLabelSnapshotBase & {
  templateVersion: 'pallet-100x150-v1' | 'pallet-100x150-compact-v2';
  rollCodes?: never;
};

export type SquarePalletLabelSnapshot = PalletLabelSnapshotBase & {
  templateVersion:
    | 'pallet-100x100-square-v4'
    | 'pallet-100x100-safe-v5'
    | 'pallet-100x100-extended-v6'
    | 'pallet-100x100-configurable-v7';
  /** Exact ordered composition sealed into the immutable browser-print snapshot. */
  rollCodes: string[];
};

export type PalletLabelSnapshot = LegacyPalletLabelSnapshot | SquarePalletLabelSnapshot;

export type PalletListPayload = {
  templateVersion: PalletLabelSnapshotProfile;
  palletId: string;
  operationCode: string | null;
  orderIds: string[];
  orderNumbers: string[];
  customerAliases: string[];
  products: string[];
  orderNumber: string | null;
  customerAlias: string | null;
  scannedCount: number;
  expectedCount: number;
  printReady: boolean;
  rows: Array<{
    seq: number;
    rollCode: string;
    orderId: string | null;
    orderNumber: string | null;
    customerAlias: string | null;
    productName: string;
    netKg: number | null;
    grossKg: number | null;
    planKg: number | null;
    status: string;
  }>;
  totals: {
    rollCount: number;
    plannedKg: number;
    netKg: number;
    grossKg: number | null;
  };
  receivedBy: string | null;
  collectedBy: string | null;
  date: string;
  label: PalletLabelSnapshot;
  /** Complete immutable publication snapshot; mandatory for configurable-v7 documents. */
  layoutPublication?: PalletLabelLayoutPublication;
};

export type WarehousePrinterView = {
  id: string;
  code: string | null;
  label: string;
  post: { id: string; code: string; name: string };
  status: string;
  ready: boolean;
  unavailableReason: string | null;
};

export type WarehousePhysicalPostView = {
  id: string;
  code: string;
  name: string;
  ready: boolean;
  readinessCode: string;
  readinessMessage: string;
  selected: boolean;
};

export type WarehousePhysicalPostsView = {
  items: WarehousePhysicalPostView[];
  currentPostCode: string | null;
};

export type WarehouseCoverCheckState = 'open';

export type WarehouseCoverCheckPosition = {
  id: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  rawMaterialId: string | null;
  spoolType: string | null;
  birka: string | null;
  plannedWeightKg: number | null;
  warehouseCoverStatus: WarehouseCoverStatus;
};

/** Safe warehouse-owned task projection; legal/finance/source diagnostics are intentionally absent. */
export type WarehouseCoverCheckItem = {
  caseId: string;
  orderId: string;
  orderNumber: string;
  customerAlias: string;
  state: WarehouseCoverCheckState;
  requestedAt: string;
  updatedAt: string;
  positions: WarehouseCoverCheckPosition[];
};

export type WarehouseCoverCheckPage = {
  items: WarehouseCoverCheckItem[];
  nextCursor: string | null;
};

export type WarehouseCoverRequestOrder = {
  id: string;
  orderNumber: string;
  version: number;
  warehouseCoverStatus: WarehouseCoverStatus;
};

export type WarehouseCoverRequestCase = {
  id: string;
  orderId: string;
  state: 'open';
  ownerRole: 'warehouse';
  affectedPositionIds: string[];
  requestedAt: string;
  updatedAt: string;
};

export type WarehouseCoverRequestResult = {
  order: WarehouseCoverRequestOrder;
  case: WarehouseCoverRequestCase;
};
