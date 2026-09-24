import type { AuditEntry, OperatorOrderProgress, OperatorRollLine, OperatorShift, OrderRollGroup, ProblemCase } from '../types';
import type { DefectBagType } from '../defectBagLabels';

export type OperatorOrderStatus =
  | 'assigned'
  | 'spool_weight'
  | 'roll_scale_activation'
  | 'roll_weight'
  | 'qr_print'
  | 'qr_check'
  | 'handover'
  | 'deferred'
  | 'defect'
  | 'warehouse';

export type OperatorOrderRuntime = OperatorOrderProgress & {
  id: string;
  title: string;
  customerAlias: string;
  templateName: string;
  filmType: string;
  cardSizeMeters: string;
  status: OperatorOrderStatus;
  lastEventAt: string;
  workplace: string;
  problemCount: number;
  rollPlanKg: number;
  spoolKg?: number;
  rollNetKg?: number;
  /** Stable server identity of the actionable physical attempt. */
  currentDispatchItemId?: string;
  rollGroups: OrderRollGroup[];
  rolls: OperatorRollLine[];
};

export type OperatorQueueDirection = 'up' | 'down';

export type OperatorRuntimeState = {
  shift: OperatorShift;
  orders: OperatorOrderRuntime[];
  audit: Record<string, AuditEntry[]>;
  reportedProblems?: Record<string, ProblemCase[]>;
  balanceProblemOrderId?: string;
};

/** Карточка мешка в пикере открытия смены (live-режим, design 2026-07-13). */
export type OperatorBigBagPickerOption = {
  id: string;
  code: string;
  material: string;
  materialId: string | null;
  warehouseKg: number | null;
  currentKg: number | null;
  status: 'available' | 'in_use' | 'consumed';
};

export type BigBagWeightDraft = {
  startKg: string;
  endKg: string;
  /** Отдельный черновик сохраняет identity при повторе и одинаковых весах. */
  defectBagDraftId?: string;
  /** Ручной вес добавляемого мешка брака. */
  defectBagKg?: string;
  /** Вид брака в добавляемом мешке. */
  defectBagType?: DefectBagType;
  /** Live-режим: выбранный мешок для открытия смены. */
  selectedBagId?: string;
  /** Live-режим: финальные веса по каждому мешку смены (bagId → ввод). */
  bagEndKg?: Record<string, string>;
  /** Live-режим: добавление мешка в открытую смену. */
  addBagId?: string;
  addKg?: string;
};

export type OperatorRollHubSortKey =
  | 'queue'
  | 'roll'
  | 'order'
  | 'priority'
  | 'status'
  | 'step'
  | 'machine'
  | 'parameters'
  | 'weight'
  | 'qr'
  | 'blocker'
  | 'updated';

export type OperatorRollHubSortDirection = 'asc' | 'desc';

export type OperatorRollHubRow = {
  id: string;
  orderId: string;
  orderCode: string;
  orderTitle: string;
  customerAlias: string;
  roll: OperatorRollLine;
  rollProgress: OperatorOrderProgress['rollProgress'];
  queueRank: number;
  priority: string;
  status: string;
  step: string;
  machine: string;
  parameters: string;
  recipe: string;
  plannedWeight: string;
  weight: string;
  qrWarehouse: string;
  blocker: string;
  updated: string;
  dateKey?: string;
  handoverAt?: string;
  isCurrent: boolean;
  isArchived: boolean;
  severity: 'info' | 'warning' | 'critical';
};

export type OperatorOrderHubGroup = {
  id: string;
  orderCode: string;
  title: string;
  customerAlias: string;
  status: string;
  priority: string;
  updated: string;
  progress: string;
  activeRolls: number;
  archivedRolls: number;
  blockedRolls: number;
  rows: OperatorRollHubRow[];
};
