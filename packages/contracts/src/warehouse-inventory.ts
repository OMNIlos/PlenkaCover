export const WAREHOUSE_INVENTORY_ORIGINS = ['client', 'reserve'] as const;
export type WarehouseInventoryOrigin = (typeof WAREHOUSE_INVENTORY_ORIGINS)[number];

export const WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES = [
  'awaiting_shipment',
  'available',
  'reserved',
  'defect',
  'in_transit',
  'delivered',
  'processed',
] as const;
export type WarehouseInventoryLifecycleStatus =
  (typeof WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES)[number];

export const WAREHOUSE_INVENTORY_LIFECYCLE_LABELS = {
  awaiting_shipment: 'Ожидает отгрузки',
  available: 'Доступен',
  reserved: 'Зарезервирован',
  defect: 'Брак',
  in_transit: 'В пути',
  delivered: 'Выдан',
  processed: 'Обработан',
} as const satisfies Record<WarehouseInventoryLifecycleStatus, string>;
export type WarehouseInventoryLifecycleStatusLabel =
  (typeof WAREHOUSE_INVENTORY_LIFECYCLE_LABELS)[WarehouseInventoryLifecycleStatus];

export const WAREHOUSE_INVENTORY_PROVENANCE_KINDS = [
  'client_order',
  'stock_reserve',
  'manual',
] as const;
export type WarehouseInventoryProvenanceKind =
  (typeof WAREHOUSE_INVENTORY_PROVENANCE_KINDS)[number];

export const WAREHOUSE_INVENTORY_SORT_KEYS = ['receivedAt', 'rollCode'] as const;
export type WarehouseInventorySortKey = (typeof WAREHOUSE_INVENTORY_SORT_KEYS)[number];

export const WAREHOUSE_INVENTORY_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type WarehouseInventorySortDirection = (typeof WAREHOUSE_INVENTORY_SORT_DIRECTIONS)[number];

export const WAREHOUSE_INVENTORY_VIEWS = ['current', 'processed'] as const;
export type WarehouseInventoryView = (typeof WAREHOUSE_INVENTORY_VIEWS)[number];

export const WAREHOUSE_INVENTORY_PHYSICAL_STATUSES = [
  'sent',
  'received',
  'defect',
  'delivered',
] as const;
export type WarehouseInventoryPhysicalStatus =
  (typeof WAREHOUSE_INVENTORY_PHYSICAL_STATUSES)[number];

export const WAREHOUSE_INVENTORY_PHYSICAL_STATUS_LABELS = {
  sent: 'В пути на склад',
  received: 'Принят складом',
  defect: 'Подтверждён брак',
  delivered: 'Выдан',
} as const satisfies Record<WarehouseInventoryPhysicalStatus, string>;

export const WAREHOUSE_INVENTORY_NEXT_ROUTES = [
  'receiving',
  'delivery',
  'reserve',
  'defect_resolution',
  'completed',
] as const;
export type WarehouseInventoryNextRoute = (typeof WAREHOUSE_INVENTORY_NEXT_ROUTES)[number];

export const WAREHOUSE_INVENTORY_NEXT_ROUTE_LABELS = {
  receiving: 'Приёмка',
  delivery: 'Выдача',
  reserve: 'Складской резерв',
  defect_resolution: 'Решение по браку',
  completed: 'Маршрут завершён',
} as const satisfies Record<WarehouseInventoryNextRoute, string>;

export type WarehouseInventoryRollItem = {
  id: string;
  rollCode: string;
  origin: WarehouseInventoryOrigin;
  lifecycleStatus: WarehouseInventoryLifecycleStatus;
  lifecycleStatusLabel: WarehouseInventoryLifecycleStatusLabel;
  orderNumber: string | null;
  positionId: string | null;
  positionSequence: number | null;
  warehouseStatus: WarehouseInventoryPhysicalStatus;
  warehouseStatusLabel: (typeof WAREHOUSE_INVENTORY_PHYSICAL_STATUS_LABELS)[WarehouseInventoryPhysicalStatus];
  nextRoute: WarehouseInventoryNextRoute;
  nextRouteLabel: (typeof WAREHOUSE_INVENTORY_NEXT_ROUTE_LABELS)[WarehouseInventoryNextRoute];
  counterpartyName: string;
  batchCode: string | null;
  weightKg: number | null;
  specification: string;
  receivedAt: string | null;
  processedAt: string | null;
};

export type WarehouseInventorySpecificationDetails = {
  filmType: string | null;
  actualThicknessMicron: number | null;
  accountingThicknessMicron: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  netKg: number | null;
  spoolType: string | null;
  birka: string | null;
  recipeName: string | null;
  ingredients: string[];
};

export type WarehouseInventoryProvenance = {
  kind: WarehouseInventoryProvenanceKind;
  orderNumber: string | null;
  batchCode: string | null;
};

export type WarehouseInventoryRollDetail = WarehouseInventoryRollItem & {
  specificationDetails: WarehouseInventorySpecificationDetails;
  provenance: WarehouseInventoryProvenance;
};

export type WarehouseInventoryRollPage = {
  items: WarehouseInventoryRollItem[];
  nextCursor: string | null;
};
