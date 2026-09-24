export const SAFE_INVENTORY_SOURCE_STATUSES = [
  'fresh',
  'stale',
  'partial',
  'unavailable',
  'conflict',
  'erp_only',
] as const;
export type SafeInventorySourceStatus = (typeof SAFE_INVENTORY_SOURCE_STATUSES)[number];

export type SafeInventorySource = {
  snapshotId: string;
  sourceKind: string;
  capturedAt: string | null;
  importedAt: string | null;
};

export type SafeInventoryConflict = {
  code: string;
  message: string;
};

export type SafeInventoryItem = {
  materialId: string;
  materialName: string;
  category: string | null;
  unit: string | null;
  erpActualQty: number | null;
  oneCQty: number | null;
  reservedQty: number | null;
  availableQty: number | null;
  expectedUsageQty: number | null;
  openBigBagQty: number | null;
  recycledQty: number | null;
  sourceStatus: SafeInventorySourceStatus;
  source: SafeInventorySource | null;
  conflicts: SafeInventoryConflict[];
  updatedAt: string | null;
};

export type SafeInventoryPage = {
  items: SafeInventoryItem[];
  nextCursor: string | null;
  sourceUnavailable: boolean;
  generatedAt: string;
};

export type SafeInventorySourceSummary = Pick<
  SafeInventoryPage,
  'sourceUnavailable' | 'generatedAt'
> & {
  statuses: SafeInventorySourceStatus[];
};
