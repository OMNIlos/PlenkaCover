export const WAREHOUSE_ACCOUNTING_STOCK_SCOPES = ['goods', 'consumables'] as const;
export type WarehouseAccountingStockScope = (typeof WAREHOUSE_ACCOUNTING_STOCK_SCOPES)[number];

export type WarehouseAccountingBalanceStatus = 'positive' | 'zero' | 'negative';

export type WarehouseAccountingStockItem = {
  nomenclatureExternalId: string;
  name: string;
  kind: string | null;
  unit: string | null;
  quantity: number;
  balanceStatus: WarehouseAccountingBalanceStatus;
  capturedAt: string;
  importedAt: string;
  stale: boolean;
  physicalTraceability: 'unavailable';
};

export type WarehouseAccountingStockPage = {
  items: WarehouseAccountingStockItem[];
  nextCursor: string | null;
  accountCode: '41.01';
  scope: WarehouseAccountingStockScope;
  generatedAt: string;
};

export type WarehouseAccountingMovementLine = {
  lineNumber: number;
  name: string;
  quantity: number;
  unit: string | null;
};

export type WarehouseAccountingMovement = {
  externalId: string;
  documentNumber: string;
  documentDate: string;
  direction: 'outbound';
  sourceLabel: 'Отгрузка по 1С';
  capturedAt: string;
  importedAt: string;
  physicalTraceability: 'unavailable';
  lines: WarehouseAccountingMovementLine[];
};

export type WarehouseAccountingMovementPage = {
  items: WarehouseAccountingMovement[];
  nextCursor: string | null;
  generatedAt: string;
};
