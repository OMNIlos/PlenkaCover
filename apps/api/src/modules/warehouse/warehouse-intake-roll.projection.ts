import type {
  Role,
  ScanStatus,
  WarehouseIntakeRollView,
  WarehouseRollOwnership,
  WarehouseRollSource,
} from '@plenka/contracts';
import { projectCounterparty } from '../commercial/projection';

export type ScanRowProjection = {
  id: string;
  rollCode: string;
  fromOrderId: string | null;
  scanStatus: string;
  lastScanAt: Date | null;
  scannedByName: string | null;
};

export type OperatorLineProjection = {
  sequence: number;
  planKg: number | null;
  netKg: number | null;
  grossKg: number | null;
  warehouseState: string;
  rollDispatchItem: {
    id: string;
    orderLineId?: string | null;
    rollCode: string;
    filmType: string | null;
    plannedLengthM: number | null;
    characteristicsSnapshot: unknown;
    status: string;
    completedAt: Date | null;
    assignedOperator?: { displayName: string } | null;
    post?: { id: string; name: string; code: string } | null;
    productionOrder?: {
      id: string;
      commercialOrder?: {
        id: string;
        orderNumber: string;
        counterparty: Parameters<typeof projectCounterparty>[0];
      } | null;
    } | null;
  };
};

export type WarehouseRollProjection = {
  rollCode: string;
  ownerCounterpartyId: string | null;
  reservedForOrderId: string | null;
  warehouseStatus: string;
  positionSnapshot: unknown;
};

export const WAREHOUSE_ARRIVED_STATES = new Set(['sent', 'received', 'defect', 'delivered']);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textField = (
  primary: Record<string, unknown>,
  secondary: Record<string, unknown>,
  key: string,
): string | null => {
  for (const value of [primary[key], secondary[key]]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
};

const numberField = (
  primary: Record<string, unknown>,
  secondary: Record<string, unknown>,
  key: string,
): number | null => {
  for (const value of [primary[key], secondary[key]]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};

const metersField = (value: number | null): string | null =>
  value !== null && Number.isFinite(value) && value > 0
    ? `${Number(value.toFixed(3)).toLocaleString('ru-RU', { useGrouping: false })}м`
    : null;

export function projectWarehouseIntakeRoll(
  row: ScanRowProjection,
  line: OperatorLineProjection | undefined,
  warehouseRoll: WarehouseRollProjection | undefined,
  actorRole: Role,
): WarehouseIntakeRollView {
  const snapshot = record(line?.rollDispatchItem.characteristicsSnapshot);
  const positionSnapshot = record(warehouseRoll?.positionSnapshot);
  const commercialOrder = line?.rollDispatchItem.productionOrder?.commercialOrder;
  const customerAlias = commercialOrder?.counterparty
    ? projectCounterparty(commercialOrder.counterparty, actorRole).displayName
    : null;
  const characteristics = {
    filmType:
      textField(snapshot, positionSnapshot, 'filmType') ?? line?.rollDispatchItem.filmType ?? null,
    materialMark: textField(snapshot, positionSnapshot, 'materialMark') ?? (line ? 'PE-LD' : null),
    sizeMeters: textField(snapshot, positionSnapshot, 'sizeMeters'),
    actualThickness: textField(snapshot, positionSnapshot, 'actualThickness'),
    lengthMeters:
      textField(snapshot, positionSnapshot, 'lengthMeters') ??
      metersField(
        numberField(snapshot, positionSnapshot, 'plannedLengthM') ??
          line?.rollDispatchItem.plannedLengthM ??
          null,
      ),
    spoolType: textField(snapshot, positionSnapshot, 'spoolType'),
    article: textField(snapshot, positionSnapshot, 'article'),
    packagingMaterial: textField(snapshot, positionSnapshot, 'packagingMaterial'),
    packagingCount: numberField(snapshot, positionSnapshot, 'packagingCount'),
    deliveryDate: textField(snapshot, positionSnapshot, 'deliveryDate'),
  };
  const hasCharacteristics =
    line !== undefined ||
    Object.values(characteristics).some((value) => value !== null && value !== undefined);
  const source: WarehouseRollSource = warehouseRoll
    ? 'warehouse_reserve'
    : WAREHOUSE_ARRIVED_STATES.has(line?.warehouseState ?? '')
      ? 'production_handover'
      : 'production_pending';
  const ownership: WarehouseRollOwnership =
    warehouseRoll?.warehouseStatus === 'shipped'
      ? 'shipped'
      : warehouseRoll?.reservedForOrderId
        ? 'reserved_for_order'
        : warehouseRoll?.ownerCounterpartyId
          ? 'customer_owned'
          : 'free_reserve';

  return {
    scanRowId: row.id,
    rollCode: row.rollCode,
    orderId: commercialOrder?.id ?? null,
    orderNumber: commercialOrder?.orderNumber ?? row.fromOrderId,
    orderLineId: line?.rollDispatchItem.orderLineId ?? null,
    customerAlias,
    sequence: line?.sequence ?? 0,
    planKg: line?.planKg ?? null,
    netKg: line?.netKg ?? null,
    grossKg: line?.grossKg ?? null,
    characteristics: hasCharacteristics ? characteristics : null,
    source,
    ownership,
    operatorLabel: line?.rollDispatchItem.assignedOperator?.displayName ?? null,
    machineLabel: line?.rollDispatchItem.post?.name ?? line?.rollDispatchItem.post?.code ?? null,
    productionStatus: line?.rollDispatchItem.status ?? 'not_ready',
    producedAt: line?.rollDispatchItem.completedAt?.toISOString() ?? null,
    scanStatus: row.scanStatus as ScanStatus,
    warehouseState: line?.warehouseState ?? 'not_ready',
    scannedByName: row.scannedByName,
    palletSelection: {
      selected: false,
      locked: false,
      palletId: null,
      palletCode: null,
    },
  };
}
